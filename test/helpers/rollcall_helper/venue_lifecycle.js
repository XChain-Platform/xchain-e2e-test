/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict'

const assert = require('assert')
const os = require('os')
const path = require('path')
const chainRail = require('../chainRail')
const { assertFrozenCanonicalVector } = require('./canonical_wire')
const { federationRoster } = require('./federation')
const { epochsAfter } = require('./sibling_resolution')
const federationPreconditions = require('./federation_preconditions')
const proofPreconditions = require('./proof_preconditions')
const { assertEpochsUnshadowed } = require('./database_reads')

const {
    assertBtcRail,
    assertGatedReadsReachable,
    assertOraclePublishFederation,
    assertRegtestConstants,
} = federationPreconditions
const {
    assertBtcProofWiring,
    assertDogePeerManifest,
    assertRosterStreaksClean,
    probePublicRollcallReads,
} = proofPreconditions

async function mineDoge(...args){ return require('./chain_driving').mineDoge(...args) }
async function publishWire(...args){ return require('./chain_driving').publishWire(...args) }

// ── the DOGE rail ────────────────────────────────────────────────────────────

// The second stack, through the repo's own multi-chain rail rather than a
// bespoke set of connectors: withRail(rail, fn) swaps the globals so every
// existing helper (transactionHelper, cryptoHelper, gasHelper) works verbatim
// on DOGE, which is what lets the sweeper leg broadcast a real ROLLCALL action.
async function openDogeRail(network){
    let rail
    try {
        rail = await chainRail.createRail('dogecoin', network)
    } catch (e) {
        throw new Error(
            'ROLLCALL precondition FAILED: cannot build the DOGE rail (' + (e && e.message) + '). ' +
            'Roll calls land on DOGECOIN, so the acceptance venue needs BOTH regtest stacks up and both ' +
            'registered with the hub. Bring up the dogecoin-regtest stack (node, utxo-tracker, encoder, ' +
            'decoder, indexer, regtest-miner) before running.')
    }
    const failures = await chainRail.railFailures(rail)
    assert.strictEqual(failures.length, 0,
        'ROLLCALL precondition FAILED: the DOGE rail is not usable: ' + failures.join('; ') +
        '. Every ROLLCALL action is published on DOGE, so none of the acceptance tests can drive without it.')
    return rail
}

// ── hub engine wiring ────────────────────────────────────────────────────────

// RollcallRound instances, in hub index order. Constructed inside
// XChainHub.startAttestation(), so a MultiValidatorHub built without
// startAttestation:true has none and the whole run would sign nothing.
function rollcallRounds(mvh){
    const rounds = mvh.hubs.map(h => (h.getRollcallRound && h.getRollcallRound()) || null)
    const missing = rounds.map((r, i) => r ? null : i).filter(i => i !== null)
    assert.strictEqual(missing.length, 0,
        'ROLLCALL harness: hub(s) ' + missing.join(', ') + ' have no RollcallRound. The engine is constructed ' +
        'in XChainHub.startAttestation(), so MultiValidatorHub must be built with startAttestation:true - but ' +
        'the likelier cause is a STALE xchain-hub checkout, because MultiValidatorHub resolves the sibling by ' +
        'a path ladder and a monorepo checkout shared with other sessions can sit behind origin without saying ' +
        'so. Measured 2026-08-30: the sibling was 12 commits behind origin/develop and simply had no ' +
        'rollcall/round.js, and this assertion was the only symptom. Check ' +
        JSON.stringify(process.env.XCHAIN_HUB_PATH || '(XCHAIN_HUB_PATH unset; resolved by the sibling ladder)') +
        ' and point XCHAIN_HUB_PATH at a checkout that carries src/rollcall/round.js.')
    return rounds
}

// The roster index of the hub the election would pick for `epoch`, asked of a
// live engine so the answer is the one the chain will pay rather than a second
// copy of hashOrder that could disagree with it.
//
// Returns null when the engine cannot resolve the capability set for that epoch,
// which is a real state rather than an error: electionOrder resolves the set AT
// the epoch, and a far-future epoch has no snapshot to resolve. A caller that
// gets null must fall back rather than treat it as "no leader".
//
// -1 means the elected key is not in the roster at all, which on an exact-roster
// venue cannot happen and elsewhere means an outsider won.
async function electedLeaderIndex(ctx, epoch){
    const eng = ctx.rounds && ctx.rounds[0]
    if (!eng || typeof eng.electionOrder !== 'function') return null

    // The engine's own resolver first, because it is the one the chain agrees
    // with. It resolves the capability set AT the epoch, so it answers for an
    // epoch the chain has reached and returns null for one it has not - measured
    // 2026-09-03: every future epoch came back null, which is why the look-ahead
    // fell through to a draw and AT6a lost one.
    let order = null
    try { order = await eng.electionOrder(Number(epoch)) } catch (e) { order = null }

    // FALL BACK TO THE HUB'S OWN ORDERING OVER A SET WE ALREADY KNOW, which is
    // not a second copy of the election logic: electionKey and hashOrder are the
    // hub's own functions, called here with the roster keys instead of a snapshot
    // the chain cannot yet provide. Sound only where the set is certain, so it is
    // gated on an EXACT-ROSTER venue: assertOraclePublishFederation has already
    // established that the staked oracle_publish set is exactly these four keys,
    // and a future epoch's set can only differ if someone stakes in between.
    if ((!Array.isArray(order) || !order.length)
        && ctx.fed && !ctx.fed.outsiders
        && typeof eng.electionKey === 'function'){
        try {
            const { resolveHubFile } = require('../multiValidatorHubHelper')
            const sap = require(resolveHubFile('src/anchor/publisher.js'))
            if (sap && typeof sap.hashOrder === 'function')
                order = sap.hashOrder(eng.electionKey(Number(epoch)), ctx.roster.map(r => r.pubkey))
        } catch (e) { order = null }
    }

    if (!Array.isArray(order) || !order.length) return null
    const leader = String(order[0]).toLowerCase()
    return ctx.roster.findIndex(r => r.pubkey === leader)
}

// Wire one DOGE publish hook into every hub's RollcallRound. Only the ranks the
// election has unlocked actually call it, so a single funded publisher address
// is safe. `fn(wirePayload)` must return `{ txid }`.
function setRollcallBroadcastHook(mvh, fn){
    for (const eng of rollcallRounds(mvh)) eng.setBroadcastHook(fn)
}

// Drive every engine one tick, in hub order. The suites set ROLLCALL_POLL_MS
// high and tick manually so a round advances on the test's schedule rather than
// on a wall clock the mining loop races.
//
// `skip` is how an outage is expressed, and it is NOT optional decoration.
// RollcallRound.stop() only stops the engine's OWN timer; calling tick()
// afterwards drives it anyway, so a "stopped" hub kept signing and gossiping
// and a sweeper then landed its signature on chain, exactly as union semantics
// says it should. AT2 measured that as "the silenced hub was present", which
// reads as a protocol failure when it is the harness driving a hub it had just
// declared down. An outage means nobody ticks it.
async function tickAll(mvh, skip){
    const skipSet = new Set((skip || []).map(Number))
    const rounds  = rollcallRounds(mvh)
    for (let i = 0; i < rounds.length; i++){
        if (skipSet.has(i)) continue
        await rounds[i].tick()
    }
}

// Gossip needs a moment to cross the in-process mesh between the tick that signs
// and the tick that publishes. Poll the engines' own collected counts rather
// than sleeping a fixed span.
// `nudgeCtx`, when given, MINES DOGE WHILE IT WAITS, and that is not a
// convenience. A hub signs an epoch only once its own BTC indexer can answer
// `ledger_hash(E)`, and that indexer HALTS on any close whose DOGE evidence it
// cannot prove ("ROLLCALL PROOF UNAVAILABLE ... HALTING block processing"). An
// epoch nobody drove sitting between the run's start and its target epoch is
// enough: measured 2026-09-04, the indexer parked at block 5803 on epoch 5790's
// close for this whole wait, no hub could open a round for 5820, and the leg
// failed as "expected three gossiped signatures, saw 0" - which reads as a
// signing or gossip fault and is neither. The cure is the one `mineBtcTo`
// already applies for the same halt: mine DOGE so the close can decide.
async function waitForGossip(mvh, epoch, wantSigners, timeoutMs, skip, nudgeCtx){
    const deadline = Date.now() + (timeoutMs || 60000)
    const skipSet  = new Set((skip || []).map(Number))
    let best = 0
    let nudgedAt = 0
    while (Date.now() < deadline){
        if (nudgeCtx && Date.now() - nudgedAt > 10000){
            nudgedAt = Date.now()
            try { await mineDoge(nudgeCtx, 2) } catch (e) { /* the rail is asserted elsewhere */ }
        }
        await tickAll(mvh, skip)
        // Count only the hubs that are up. A silenced engine's own view is not
        // evidence about the mesh, and reading it would let an outage satisfy
        // its own gossip target.
        best = Math.max(...rollcallRounds(mvh).map((e, i) => {
            if (skipSet.has(i)) return 0
            const s = e.getStatus()
            return (s && s.epoch === epoch) ? Number(s.gossiped_count || 0) : 0
        }))
        if (best >= wantSigners) return best
        await new Promise(r => setTimeout(r, 1000))
    }
    return best
}

// ── shared venue bring-up ────────────────────────────────────────────────────
//
// All three ROLLCALL suites need the same thing standing before they can assert
// anything: both stacks reachable, every precondition named and checked, three
// in-process hubs with their DOGE publish rail wired, and a funded DOGE
// publisher. It lives here rather than being copied into each suite so a venue
// gap is reported in one voice, and so a fix to one precondition reaches all
// three at once.
//
// Returns a context object the suites drive through. Throws, never skips: by the
// time this runs the suite has already opted in.
async function bringUpVenue(opts){
    const o = opts || {}
    const ctx = {}

    assertBtcRail()
    assertFrozenCanonicalVector()

    ctx.network = NETWORK
    assertRegtestConstants(ctx.network)

    ctx.btcRail = chainRail.captureCurrentRail()
    ctx.idxQuery = async (sql, args) => {
        const conn = await indexerDatabase.getConnection()
        try { return await conn.query(sql, args) }
        finally { await conn.release() }
    }
    ctx.btcTip = async () => Number((await indexerConnector.call('getblockhashes', {})).block_index)

    const tip = await ctx.btcTip()
    await assertGatedReadsReachable(indexerConnector, tip, 'BTC')
    ctx.wiring = await assertBtcProofWiring(nodeConnector, indexerConnector, ctx.idxQuery, ctx.network)

    ctx.dogeRail = await openDogeRail(ctx.network)
    ctx.peer = await assertDogePeerManifest(ctx.dogeRail.globals.indexerConnector, ctx.network)

    ctx.roster = federationRoster()
    ctx.fed    = await assertOraclePublishFederation(
        indexerConnector, tip, o.needSources || 4, o.requireExactRoster === true)
    ctx.idleSource = ctx.fed.idleSource
    ctx.sourceOf   = (hubIndex) => ctx.fed.byPubkey.get(ctx.roster[hubIndex].pubkey)

    ctx.weightBySource = new Map()
    for (const v of ctx.fed.weights)
        if (!ctx.weightBySource.has(String(v.source))) ctx.weightBySource.set(String(v.source), Number(v.weight))
    ctx.totalWeight = Array.from(ctx.weightBySource.values()).reduce((a, b) => a + b, 0)

    ctx.publicReads = await probePublicRollcallReads(indexerConnector)
    ctx.streaks = await assertRosterStreaksClean(ctx, o.allowDirtyStreaks === true)

    // The next few epochs must be unshadowed on the DOGE side (see the helper);
    // four covers the longest single-suite drive plus the age-out tool.
    await assertEpochsUnshadowed(ctx, epochsAfter(tip + 6, ctx.network, o.unshadowedEpochs || 4))

    // Optional deterministic source addresses. When the operator seeded the
    // federation from this mnemonic, the harness holds the sources' keys, which
    // is what lets AT10 drive a real COLLECT rather than only asserting the
    // ledger arithmetic behind one.
    ctx.federationMnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC || null
    ctx.sourceAddressInfo  = new Map()
    if (ctx.federationMnemonic){
        const cryptoHelper = require('../core/cryptoHelper')
        for (const r of ctx.roster){
            const info = await cryptoHelper.getNewAddress(
                'rollcall-source-' + r.addressIndex, COIN, NETWORK, ctx.federationMnemonic, 'legacy', r.addressIndex)
            ctx.sourceAddressInfo.set(String(info.address), info)
        }
        const staked = new Set(ctx.fed.sources)
        const derived = Array.from(ctx.sourceAddressInfo.keys())
        const unmatched = derived.filter(a => !staked.has(a))
        assert.strictEqual(unmatched.length, 0,
            'XC_ROLLCALL_FEDERATION_MNEMONIC is set, but the addresses it derives are not the staked sources: ' +
            JSON.stringify(unmatched) + ' are not among ' + JSON.stringify(Array.from(staked)) + '. Seed the ' +
            'federation from this mnemonic (address index i for roster entry i), or unset the variable and let ' +
            'the COLLECT leg skip.')
    }

    // In-process hubs. The DOGE indexer URL is for THESE hubs' RollcallRound
    // engines only; it does nothing for the separately deployed BTC indexer,
    // whose own DOGE_INDEXER_API_URL is a container-side deployment condition
    // that assertBtcProofWiring above is the only check on.
    process.env.DOGE_INDEXER_API_URL = 'http://' + ctx.dogeRail.host + ':' + ctx.dogeRail.ports.indexer + '/'
    process.env.ROLLCALL_POLL_MS     = '600000'   // manual ticks only
    // Per-run spend and signature logs. RollcallRound deliberately re-emits a
    // STORED signature for an epoch it has already signed, so a shared default
    // path would make a second run replay the first run's bytes against a
    // different ledger_hash and read as a federation-wide absence.
    const logDir = path.join(os.tmpdir(), 'xchain-rollcall-' + process.pid)
    process.env.ROLLCALL_SIGN_LOG_PATH  = path.join(logDir, 'signatures.jsonl')
    process.env.ROLLCALL_SPEND_LOG_PATH = path.join(logDir, 'publish.spend.jsonl')

    // The three hubs each want their own database, and the platform's own
    // `xchain_hub` user deliberately lacks CREATE DATABASE (disposableHubDb's
    // header makes the argument: granting it would be a privileged platform
    // grant that every consensus test then depends on). Measured on the venue:
    // MultiValidatorHub.start() dies on ER_ACCESS_DENIED_ERROR against
    // xchain_hub@127.0.0.1:13306, and "retrying will not fix a credentials
    // error". So self-provision, exactly as the multiHub* integration suites
    // do. forceDocker is load-bearing rather than belt-and-braces: this venue
    // ALWAYS has HUB_DB_USER/HUB_DB_PASS in its .env, so the helper's reuse
    // path would hand back the very credentials that cannot create a database,
    // and it answers a liveness probe happily while doing it.
    const { startDisposableHubDb } = require('../disposableHubDb')
    ctx.hubDb = await startDisposableHubDb({
        forceDocker: true,
        // STABLE name, not pid-suffixed. The helper's first act is
        // `docker rm -f <name>`, so a stable name makes a crashed run's
        // container self-healing; a per-pid name plus a fixed port does the
        // opposite and guarantees the NEXT run dies on "port already
        // allocated" (measured: a run that threw after bring-up left
        // xchain-rollcall-testdb-2716751 holding 13308 and the following run
        // could not start at all). Two concurrent ROLLCALL runs would collide
        // on this name, but they would collide on the single regtest chain
        // first, so serialising them is a precondition either way.
        name: 'xchain-rollcall-testdb',
        // 13307 is the multiHub integration suites' default and a leftover
        // container may still hold it; a per-rail port keeps a stale one from
        // silently becoming this run's database.
        port: process.env.XC_ROLLCALL_HUB_DB_PORT || 13308,
    })
    assert.ok(ctx.hubDb,
        'ROLLCALL precondition FAILED: no hub database available. The three in-process hubs each create their ' +
        'own database and the platform user cannot, so this run needs Docker on the box to spin a throwaway ' +
        'MariaDB. Install Docker or export a HUB_DB_USER with CREATE DATABASE and re-run.')

    const { MultiValidatorHub } = require('../multiValidatorHubHelper')
    ctx.mvh = new MultiValidatorHub({
        count: o.hubCount || 3,
        identities: federationRoster().slice(0, o.hubCount || 3).map(r => ({ pubkeyHex: r.pubkey, privkeyHex: r.seed })),
        // RollcallRound is constructed inside XChainHub.startAttestation(), so
        // this is load-bearing rather than incidental.
        startAttestation: true,
        dbNamePrefix: (o.dbNamePrefix || 'XChain_BTC_Regtest_ROLLCALL_') + process.pid + '_',
    })
    await ctx.mvh.start()
    ctx.rounds = rollcallRounds(ctx.mvh)

    // The DOGE publish rail: the funded address every ROLLCALL is broadcast from.
    // The broadcast itself lives in publishWire (below), which is the single route
    // every ROLLCALL takes to that chain - the engines' hook and a drill's
    // hand-built action must ride the SAME pipeline, or a drill could land a
    // payload shape no hub could have produced.
    const cryptoHelper = require('../core/cryptoHelper')
    ctx.dogePublisher = await chainRail.withRail(ctx.dogeRail, async () => {
        // seedGas=false, and it is load-bearing on DOGE. The default seeds the
        // new address with an XCHAIN gas MINT, but ROLLCALL carries NO protocol
        // fee (D33, the ANCHOR precedent) - a publish pays a native DOGE fee
        // output and nothing else, which is exactly why the venue's own anchor
        // publisher wallet holds only DOGE. Meanwhile a regtest DOGE chain need
        // not have XCHAIN issued at all, and when it does not the seeding MINT
        // comes back `invalid: TICK (unknown)` while waitForMint polls forever:
        // measured on the venue, the bring-up hung there with no error, which is
        // the worst shape a missing precondition can take.
        const addr = await cryptoHelper.getNewFundedAddress('rollcall-publisher', COIN, NETWORK, null, 'legacy', 0, 5.0, false)
        await regtestMinerConnector.generateBlocks(2)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
        return addr
    })
    ctx.publishedWires = []
    setRollcallBroadcastHook(ctx.mvh, async (payload) => await publishWire(ctx, payload))
    for (let i = 0; i < ctx.rounds.length; i++)
        assert.strictEqual(ctx.rounds[i].broadcastCapable(), true,
            'hub ' + i + ' must be broadcast-capable for this run; a hub that can only sign and gossip cannot ' +
            'publish, and the acceptance drives need a leader that lands its roll call')

    return ctx
}

async function tearDownVenue(ctx){
    if (ctx && ctx.mvh){ await ctx.mvh.stop(); await ctx.mvh.dropDatabases() }
    // After the hubs, never before: dropDatabases still needs the server, and
    // stop() also restores the HUB_DB_* env it overwrote, so leaving it out
    // poisons the next suite's resolution path with a dead port.
    if (ctx && ctx.hubDb){ await ctx.hubDb.stop() }
    delete process.env.DOGE_INDEXER_API_URL
    delete process.env.ROLLCALL_POLL_MS
    delete process.env.ROLLCALL_SIGN_LOG_PATH
    delete process.env.ROLLCALL_SPEND_LOG_PATH
}

module.exports = {
    openDogeRail,
    rollcallRounds,
    electedLeaderIndex,
    setRollcallBroadcastHook,
    tickAll,
    waitForGossip,
    bringUpVenue,
    tearDownVenue,
}
