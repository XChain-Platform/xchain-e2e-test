'use strict'

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
 **********************************************************************
 * AT5, THE ON-CHAIN BATCH. Full history stays reconstructible from chain parse
 * even though no response was ever broadcast individually.
 *
 * The spec's own test: a window of responses lands as v5 plus v6 continuations on
 * DOGE regtest, `valid`, with `batch_action_index` set; an empty window lands a
 * `row_count 0` head; a fresh chain-only node rebuilds the mirror table from the
 * batches and re-derives every callback with 0 mismatches; an over-budget window
 * dead-letters loudly.
 *
 * WHAT THIS FILE DRIVES AND WHAT IT CANNOT, stated up front because the split is
 * the useful part of it. Two of the four clauses are driven here. The other two
 * are skipped with measurements rather than opinions, in their own cases below.
 *
 * THE PUBLISHER IS WIRED BY THIS DRILL, not by an operator, and an earlier version
 * of this file got that wrong in a way worth recording. The hub's
 * `AttestationBatchPublisher` starts with every real hub and regtest is armed at
 * height 0, so these hubs are ALREADY closing windows on the venue's cadence; they
 * simply cannot publish without a signer module, an encoder URL and a funded DOGE
 * address. This file first declared those three "operator property" and skipped.
 * That was a misclassification, and each third of it fell to one measurement:
 * regtest funding is a block rather than money, `HUB_SIGNER_MODULE` is a path to a
 * module a drill can stage from the one the hub repo ships, and the encoder URL is
 * a venue coordinate pinned in `chainRail`. `stageDogeSigner` below now builds all
 * three, and the only skip left is a DOGE rail that cannot be reached at all.
 *
 * The general shape, since it has caught more than one lane: "I cannot do X"
 * hardening into "the operator must do X" without a measurement in between.
 *
 * THE SECOND PRECONDITION is the anchor. `_resolveAnchor` reads a BTC chain tip
 * that arrives on the hub only through the `pushchaintip` JSON-RPC, and without one
 * the publisher defers every window with a latched warning and publishes nothing.
 * The drill pushes it to every hub itself, because on this venue no production BTC
 * indexer is pointed at these hubs to do it.
 *
 * THE ELECTION IS WHY THIS DRILL IS PATIENT. Publication is elected by
 * `sha256(batch_key + pubkey)` rank against the window's age, so on a five-hub
 * federation the rank-0 hub publishes the first window, and any other hub only
 * takes over as the window ages. A drill that watched one hub for one window would
 * see nothing and call it a failure, so this one watches the marker table across
 * every hub and lets several windows pass.
 *
 * SERIALIZED, not parallel, and heavier than its neighbours: it drives both chains.
 ********************************************************************/

const assert = require('assert')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, startAttestTestServer, deployRequestContract, queryVenueDb, withWedgeClear,
    mineWhile,
} = require("./mirrorDrillFixture")
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    venueTipProbe, mineDogeBlocks, findEmittedAttestRequest,
    clearBeforeBroadcast,
    allHubTails,
    attestRequestWatermark,
    settleOrReport,
    widenArithmetic,
    jsonSafe,
} = require('./mirrorDrillWaits')
const vmHelper     = require('../helpers/vmHelper')
const chainRail    = require('../helpers/chainRail')
const cryptoHelper = require('../cryptoHelper')
const { loadHubModule } = require('../helpers/multiValidatorHubHelper')

// Short enough that several windows close inside a drill, and comfortably above
// the four-times-the-hop floor the venue's own timing invariant would impose if
// this hub keyed windows on wall clock rather than on the signed effective time.
const BATCH_WINDOW_S = 30

// Above the gossip hop budget, as the venue requires, AND ABOVE A ROUND: a row's
// effective time is its leader's clock plus this margin, and the row is only
// written at finalization. A round that runs through a leader-slot timeout
// (30 s here) finalizes long after the leader's clock, so with 8 s the second of
// two responses landed in a window hub 3 had already closed and published with
// one row; the re-publish with both was refused on chain as a duplicate head
// (`BATCH_KEY`) and that response never linked (pass 17, 2026-09-05). Ninety
// seconds covers two slots plus gossip and keeps the drill's own waits intact.
const FORWARD_S = 90

// How often the drill re-pushes the node's live BTC tip to every hub. Half the
// miner's 6 s ceiling on the drive venue, so no hub ever holds a tip more than
// one block stale; cheap (five fire-and-forget RPCs).
const TIP_FEED_MS = 3000

// DOGE funded to the publisher, as MANY INDEPENDENT OUTPUTS rather than one. The
// encoder spends confirmed outputs only, and every window (empty ones too, one per
// BATCH_WINDOW_S) spends the wallet's largest output into fresh, unconfirmed
// change; with one funding output the publisher can reach only the small
// carrier outputs earlier windows left behind, and a 3-wire batch needing
// 2,000,000 against `selected inputs total 600000` failed at the one window that
// carried the responses (pass 10, 2026-09-05; the publisher never retries a
// failed broadcast). With PUBLISHER_FUND_OUTPUTS outputs of PUBLISHER_FUND_DOGE
// each, at most one is in flight per window and a confirmed one is always there.
const PUBLISHER_FUND_DOGE    = 1.0
const PUBLISHER_FUND_OUTPUTS = 40

const DEADLINE_BLOCKS = 60
const BURIAL_BLOCKS   = 6

// The DOGE encoder this venue publishes through, taken from the rail's own port map
// so the drill and the rail cannot disagree about where that service lives.
const DOGE_ENCODER_PORT = chainRail.DEFAULT_PORTS.DOGE.encoder

// The head and continuation versions, and the DOGE-side action formats a drill
// reads them back as.
const BATCH_HEAD_VERSION         = 5
const BATCH_CONTINUATION_VERSION = 6

// The bodies are deliberately incompressible so that two responses exceed one
// 8189-byte wire and the batch must chunk, which is the only way a v6 appears at
// all. Compressible filler would ride in a single head and the continuation half of
// this clause would silently never be exercised. Entropy bytes per body; carried as
// base64 (6 bits per character, so deflate recovers little), which puts two bodies
// at roughly 12 KB on the wire against the 8189-byte ceiling.
const INCOMPRESSIBLE_BYTES = 6000

/** SHA-256 chain seeded on `seed`, base64, INCOMPRESSIBLE_BYTES of entropy. */
function deterministicFiller (seed) {
    const crypto = require('crypto')
    const chunks = []
    let h = crypto.createHash('sha256').update('at5:' + seed).digest()
    let n = 0
    while (n < INCOMPRESSIBLE_BYTES) {
        chunks.push(h)
        n += h.length
        h = crypto.createHash('sha256').update(h).digest()
    }
    return Buffer.concat(chunks).subarray(0, INCOMPRESSIBLE_BYTES).toString('base64')
}

const CONTRACT_CODE = `
module.exports = {
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            [xchain.getInputParam(2)],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        var tag = xchain.getInputParam(4);
        xchain.state.set('status_' + tag, xchain.getInputParam(2));
    }
};
`

/**
 * Fund a DOGE publisher wallet, stage the shipped signer module against it, and
 * return the hub environment that turns the batch publisher on.
 *
 * THIS WAS ONCE WRITTEN AS AN OPERATOR PRECONDITION AND THAT WAS WRONG. The
 * earlier version of this drill skipped unless four variables were already in the
 * environment, on the reasoning that a funded wallet on another chain is not a
 * test's to invent. Every part of that fell to measurement:
 *
 *   - FUNDING ON REGTEST IS A BLOCK, NOT MONEY. `getNewFundedAddress` on the DOGE
 *     rail funds an address the same way every other drill funds one; there is
 *     nothing to be granted.
 *   - `HUB_SIGNER_MODULE` IS A PATH, and this venue spawns hubs as processes with
 *     an environment this file constructs, not as containers with a mounted
 *     operator directory. The module it points at is the one the hub repo SHIPS as
 *     its reference signer, copied into a temp directory with the two packages it
 *     requires symlinked in. `test/federation/anchorAcceptance.test.js` has staged
 *     it exactly this way for the ANCHOR rail all along.
 *   - `DOGE_ENCODER_URL` IS A VENUE COORDINATE, pinned at 3123 in `chainRail`.
 *
 * So the whole thing is arranged here, and the drill skips only if the DOGE rail
 * itself cannot be reached, which is a venue fault with a named cause rather than
 * a category of work belonging to someone else.
 *
 * THE KEY NEVER TOUCHES DISK. The staged signer reads its `.env` through dotenv,
 * which does not override variables already present, so the WIF is handed to the
 * hub child through its environment and no file is written with a key in it.
 */
async function stageDogeSigner (label, rail) {
    const os     = require('os')
    const fs     = require('fs')
    const path   = require('path')
    const crypto = require('crypto')
    const { encode: wifEncode } = require('wif')
    const CryptoNetworks = require('../../src/CryptoNetworks.js')

    // Funded ON the DOGE rail, which is the whole point: the publisher pays a real
    // fee on that chain for every window it broadcasts.
    const funded = await chainRail.withRail(rail, async () => {
        // WRAPPED for the same reason as the relayer in AT6: the funding call mints
        // gas internally, so it starves under the wedge, and it is keyed by label so
        // a retry re-funds one publisher rather than minting a second wallet.
        const addr = await withWedgeClear('funding the batch publisher on the other rail',
            () => cryptoHelper.getNewFundedAddress(
                label + '-batch-publisher', COIN, NETWORK, null, 'legacy', 0, PUBLISHER_FUND_DOGE))
        // The remaining outputs, each its own transaction from the miner's wallet
        // (see PUBLISHER_FUND_OUTPUTS). Idempotency is not needed here: a retry
        // that re-funds simply leaves the publisher richer.
        for (let i = 1; i < PUBLISHER_FUND_OUTPUTS; i++) {
            await regtestMinerConnector.sendFunds(addr.address, PUBLISHER_FUND_DOGE)
        }
        console.log('AT5: publisher ' + addr.address + ' funded with ' + PUBLISHER_FUND_OUTPUTS +
            ' outputs of ' + PUBLISHER_FUND_DOGE + ' DOGE')
        await regtestMinerConnector.generateBlocks(2)
        await utxoTrackerConnector.quiesce({
            timeoutMs: 60_000, pollMs: 250, regtestMiner: regtestMinerConnector,
        })
        return { address: addr.address, privateKey: addr.privateKey, publicKey: addr.publicKey,
                 coin: COIN, network: NETWORK }
    })
    assert.ok(funded && funded.address,
        'could not fund a DOGE publisher address, so the batch publisher would have nothing to pay with')

    // The reference signer, staged the way an operator installs it. os.tmpdir()
    // rather than the checkout, because the e2e tree can live on a share where
    // symlink creation is unreliable.
    const hubRoot = path.resolve(__dirname, '../../../xchain-hub')
    const examplePath = path.join(hubRoot, 'examples', 'doge-signer.example.js')
    assert.ok(fs.existsSync(examplePath),
        'the hub ships no examples/doge-signer.example.js at ' + examplePath +
        ', so there is no reference signer to stage')
    const signerDir = path.join(os.tmpdir(),
        'xchain-attest-batch-signer-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'))
    fs.rmSync(signerDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true })
    fs.copyFileSync(examplePath, path.join(signerDir, 'signer.js'))
    for (const dep of ['xchain-sdk', 'dotenv']) {
        let target
        try { target = path.dirname(require.resolve(dep + '/package.json')) }
        catch (e) {
            target = path.resolve(__dirname, '../../../', dep)
            assert.ok(fs.existsSync(target), 'cannot resolve ' + dep + ' for the staged signer')
        }
        fs.symlinkSync(target, path.join(signerDir, 'node_modules', dep), 'dir')
    }

    const netObj = CryptoNetworks.getBitcoinJsNetwork(funded.coin + '-' + funded.network)
    const host = process.env.DOGE_SERVICE_HOST || 'localhost'
    const port = process.env.DOGE_ENCODER_API_PORT || String(DOGE_ENCODER_PORT)
    const env = {
        HUB_SIGNER_MODULE: path.join(signerDir, 'signer.js'),
        DOGE_NETWORK:      funded.coin + '-' + funded.network,
        DOGE_ADDRESS:      funded.address,
        DOGE_WIF:          wifEncode(netObj.wif, Buffer.from(funded.privateKey), true),
        // Read by the publisher for election and low-balance warnings, separately
        // from the signer's own key material.
        DOGE_PUBKEY_HEX:   Buffer.from(funded.publicKey).toString('hex'),
        DOGE_ENCODER_URL:  'http://' + host + ':' + port,
        // Explicit, so this never depends on the default staying true.
        ATTEST_BATCH_PUBLISH_ENABLED: 'true',
    }
    if (process.env.DOGE_ENCODER_API_KEY) env.DOGE_ENCODER_API_KEY = String(process.env.DOGE_ENCODER_API_KEY)

    // PROVED IN-PROCESS BEFORE FIVE HUBS ARE SPAWNED, through the hub's own loader
    // rather than by inspection: a signer that cannot fulfil its contract throws at
    // load, and discovering that from five dead children four minutes later costs
    // the whole prologue.
    const { loadSignerHooks } = loadHubModule('src/lib/signer-loader.js')
    // THE SIGNER READS process.env, NOT THE OBJECT THE LOADER IS HANDED: the
    // loader uses its env argument only to find HUB_SIGNER_MODULE, then
    // `require`s it, and the module reads DOGE_WIF and friends off process.env
    // after a dotenv load of its own (empty) directory. Handed only the object,
    // the probe failed with `DOGE_WIF is not set in <dir>/.env` on 2026-09-05
    // while the hub children, which receive the same variables in THEIR
    // environment, would have loaded it fine. So the variables are placed in
    // this process's environment for the load and taken out again. Still
    // never on disk.
    const previous = {}
    for (const k of Object.keys(env)) { previous[k] = process.env[k]; process.env[k] = env[k] }
    let hooks
    try {
        hooks = loadSignerHooks(Object.assign({}, process.env, env))
    } finally {
        for (const k of Object.keys(env)) {
            if (previous[k] === undefined) delete process.env[k]
            else process.env[k] = previous[k]
        }
    }
    assert.ok(hooks && hooks.broadcastFn,
        'the hub signer loader did not wire a broadcast hook from the staged signer, so every window ' +
        'would defer with "no broadcast pipeline configured"')

    console.log('AT5: staged the reference DOGE signer at ' + signerDir + ' for a funded publisher address')
    return { env: env, signerDir: signerDir, address: funded.address }
}

describe('AT5: the responses of a window land on chain as one batch', function () {
    this.timeout(120 * 60 * 1000)

    let venue      = null
    let dogeVenue  = null   // the attached DOGE reader, see the before-hook
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null
    let publisher  = null
    let dogeRail   = null
    // The live BTC tip feeder (see the before-hook), and its re-entrancy latch so a
    // slow push never stacks a second one behind it.
    let tipFeeder   = null
    let tipFeedBusy = false
    // The BTC node connector as it stands before the first rail switch (see
    // pushLiveTipToAllHubs for why the global cannot be read from a timer).
    let btcNode = null

    before(async function () {
        btcNode = nodeConnector
        // The DOGE rail first: the signer's wallet is funded on it, and every wait
        // below confirms batches through it.
        try {
            dogeRail = await chainRail.createRail('dogecoin', 'regtest')
        } catch (e) {
            console.log('AT5 SKIPPED: the DOGE regtest rail is unreachable (' + (e && e.message) +
                '), so the chain this batch rides cannot be driven at all. This is a venue fault with a ' +
                'named cause, not a missing credential.')
            this.skip()
            return
        }

        publisher = await stageDogeSigner('at5', dogeRail)

        // REAL TLS, not http. The provider refuses a non-https payload before any
        // network work, so a plain-HTTP server resolves every round provider_error
        // and no batch would ever have a terminal response to carry.
        testServer = await startAttestTestServer({
            path: '/blob',
            handler: (req, res) => {
                // Incompressible AND DETERMINISTIC PER URL. Every responsible hub
                // fetches this URL for itself and the round needs 2f+1 IDENTICAL
                // bodies; `randomBytes` per request (passes 6 and 7, 2026-09-05) gave
                // each hub its own body, so every round ended `no consensus (3
                // proposals diverged)`, `status=no_quorum`, and the mirror skips a
                // no-quorum round by design. A SHA-256 chain seeded on the URL is
                // as incompressible as random bytes and the same on every fetch.
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ path: String(req.url), filler: deterministicFiller(String(req.url)) }))
            },
        })
        testUrl = testServer.url

        const staked = await provisionDrillIdentities({ label: 'at5', count: 5, redundancy: 3 })
        venue = new AttestMirrorVenue({
            label: 'at5',
            identities: staked.identities,
            forwardS: FORWARD_S,
            batchWindowS: BATCH_WINDOW_S,
            // BOTH, merged: the signer's WIF and the TLS trust root are needed by
            // the same hub children, and passing either alone silently drops the other.
            hubExtraEnv: Object.assign({}, publisher.env, testServer.hubEnv),
        })
        up = await venue.start()
        if (!up) {
            console.log('AT5 SKIPPED: ' + venue.unavailable)
            this.skip()
            return
        }

        // BEFORE ANY REQUEST, and AFTER the venue exists: this call sat above the
        // venue's construction and dereferenced null in 92 ms on 2026-09-05, so
        // AT5 had never reached its first assertion. The venue indexers are seeded
        // from the standing node and still need to catch its tip before a request
        // made here can be applied on them.
        await waitForVenueIndexersAtTip(venue)

        // THE DOGE READER IS PART OF THE VENUE. A v5 head is judged on DOGE against
        // `capability_snapshots` at its anchor, mirrored from the hub the DOGE indexer
        // follows. The venue hubs write those rows; the STANDING DOGE indexer follows
        // the STANDING hub and never sees them, so every head it judges reads
        // `invalid: insufficient signer stake` (pass 12, 2026-09-05). This second venue
        // spawns one DOGE indexer from the tree that follows venue hub 0 and shares the
        // hub database; the batch actions are read from it. Started INSIDE the DOGE
        // rail switch so the seed clones from the standing DOGE indexer (the rail swaps
        // INDEXER_DB_* for its duration) and the decoder discovered is DOGE's.
        dogeVenue = await chainRail.withRail(dogeRail, async () => {
            const dv = new AttestMirrorVenue({
                label: 'at5doge',
                coin: 'dogecoin',
                attachHubs: venue.hubs,
                hubDb: venue.hubDb,
                indexerCount: 1,
                // The harness DECODER_DB_* are Bitcoin's; this venue's decoder is DOGE's.
                useEnvDecoderCredential: false,
            })
            const dvUp = await dv.start()
            assert.ok(dvUp, 'the attached DOGE venue did not start: ' + dv.unavailable)
            return dv
        })
        await waitForVenueIndexersAtTip(dogeVenue)
        console.log('AT5: DOGE venue indexer follows hub ' + dogeVenue.indexers[0].followsHub +
            ' and reads ' + dogeVenue.indexers[0].indexerDbName)

        // THE ANCHOR. Without a BTC chain tip every hub defers every window with a
        // latched warning and publishes nothing, which reads exactly like a publisher
        // that is broken. Pushed to every hub, since any of them may be elected.
        //
        // AND KEPT LIVE, NOT PINNED. The same `chain_tips` row is the FIRST source
        // `XChainHub._resolveBtcLatestBlock` consults for every attestation round
        // (Consensus.js), preferred over the live indexer while its block_time is
        // younger than MAX_TIP_AGE_S (default twice the oracle round interval, 20
        // min). Pass 6 (2026-09-05) pushed the tip ONCE at 7405: the responsible
        // hubs then measured every request against a height the 6 s miner left
        // behind within seconds, saw it as unconfirmed, and executed nothing; the
        // 60-block deadline (about 6 min) expired long before the row went stale,
        // so 0 of 5 hubs ever held a finalized row. A co-located indexer re-pushes on
        // every block in production; the venue's hubs have no such feeder, so this
        // drill is one, for its whole life, cleared in the after-hook.
        const first = await pushLiveTipToAllHubs()
        for (const [i, res] of first.entries()) {
            assert.ok(!res.error,
                'hub ' + i + ' refused the chain tip push (or was unreachable), so it will defer ' +
                'every window and co-sign none: ' + res.error + '; last failures: ' +
                JSON.stringify(venue.hubs[i].connector.lastFailures || []))
        }
        console.log('AT5: pushed BTC tip ' + first.tip + ' to all ' + venue.hubs.length + ' hubs (status success on each); ' +
            'feeding the live tip every ' + (TIP_FEED_MS / 1000) + ' s from here on')
        let feedFailuresReported = 0
        tipFeeder = setInterval(() => {
            if (tipFeedBusy) return
            tipFeedBusy = true
            pushLiveTipToAllHubs().then((r) => {
                const bad = r.map((x, i) => (x.error ? 'hub ' + i + ': ' + x.error : null)).filter(Boolean)
                // Said once, not every 3 s: a refusal that starts mid-drill is the
                // thing to read, and a wall of the same line hides it.
                if (bad.length && feedFailuresReported++ === 0) console.log('AT5: tip feed refused: ' + bad.join('; '))
            }).catch(() => null).then(() => { tipFeedBusy = false })
        }, TIP_FEED_MS)

        contract = await deployRequestContract({ label: 'at5', code: CONTRACT_CODE })
    })

    /**
     * Push the node's CURRENT BTC tip (height and block time) to every venue hub.
     * Returns the per-hub results (null where a hub refused or was unreachable),
     * with `.tip` set to the height pushed. `XChainHubConnector` exposes `_call(body)`
     * over a full JSON-RPC body and returns the RESULT, or null when every endpoint
     * failed or the hub answered with an error. There is no `.call`:
     * `hub.connector.call is not a function` was this drill's first line past its
     * venue boot on 2026-09-05, the same shape the federation capture documents.
     */
    async function pushLiveTipToAllHubs () {
        // THE BTC NODE CAPTURED BEFORE ANY RAIL SWITCH, never the global. `chainRail.withRail`
        // swaps `global.nodeConnector` (and its siblings) to the DOGE rail for the duration
        // of every DOGE nudge, and this runs on a timer: pass 9 (2026-09-05) read the
        // DOGE height through the global mid-swap and pushed it as the BTC tip, so every
        // hub's batch anchor became the DOGE height (4236, 4252, ...).
        const tip = Number(await btcNode.getBlockCount())
        const block = await btcNode.getBlock(await btcNode.getBlockHash(tip))
        const results = []
        for (const hub of venue.hubs) {
            // `coin` is the hub's chain TICKER: `validateChain` admits BTC, LTC and
            // DOGE and nothing else, and a refused push comes back as a RESULT
            // object carrying `error`, not as a JSON-RPC error and not as null.
            // Passes 6 and 7 (2026-09-05) sent `bitcoin`, were refused on every hub
            // every time, and read the refusal as success through a null check;
            // the followers then held no chain_tips row and refused to co-sign every
            // window (`tip unresolved: no BTC chain_tips row exists`).
            const res = await hub.connector._call({
                jsonrpc: '2.0', id: Date.now(), method: 'pushchaintip',
                params: { coin: 'BTC', network: venue.network, block_height: tip, block_time: Number(block.time) },
            }).catch((e) => ({ error: String(e && e.message) }))
            results.push(res && !res.error && String(res.status) === 'success' ? res : { error: jsonSafe(res) })
        }
        results.tip = tip
        return results
    }

    after(async function () {
        if (tipFeeder) { clearInterval(tipFeeder); tipFeeder = null }
        if (testServer) await testServer.close()
        // The attached venue first: its indexer follows a hub the owner is about to kill.
        if (dogeVenue) await dogeVenue.stop()
        if (venue) await venue.stop()
        // The staged signer holds a WIF only in the hub children's environment, but the
        // directory itself is this drill's litter and goes back.
        if (publisher && publisher.signerDir) {
            try { require('fs').rmSync(publisher.signerDir, { recursive: true, force: true }) }
            catch (_) { /* already gone */ }
        }
    })

    /** Every published-window marker any hub holds, with the hub that holds it. */
    async function readMarkers () {
        const out = []
        for (const hub of venue.hubs) {
            const rows = await queryVenueDb(venue, hub.dbName,
                'SELECT network, window_start, window_end, batch_key, row_count, txid, status ' +
                'FROM attest_published_batches ORDER BY window_start ASC').catch(() => [])
            for (const r of rows) out.push(Object.assign({ hub: hub.index }, r))
        }
        return out
    }

    /**
     * Mine one DOGE block, because a broadcast batch is not a landed batch.
     *
     * THE WINDOW CLOSES ON WALL CLOCK, so the publisher fires without any help. The
     * TRANSACTION it broadcasts is a different matter: nothing mines DOGE on this
     * venue, so a v5 sits unconfirmed in the mempool forever and every read below
     * reports an empty chain. The stalled-tip clear in the shared waits helper does
     * not cover this, and correctly so: it mines DOGE only when the BTC indexer is
     * stuck behind its own decoder, which an unconfirmed DOGE transaction never
     * causes.
     *
     * Mining here cannot move what this drill measures. The batch window is keyed on
     * the SIGNED effective time, not on DOGE height, so DOGE blocks cannot shift a
     * window boundary; they only let a transaction confirm. That is why this is one
     * block per poll rather than the miner's mine-empty heartbeat, which both lanes
     * agreed to leave off.
     */
    async function nudgeDoge () {
        await mineDogeBlocks(1).catch((e) => {
            console.log('AT5: could not mine DOGE (' + (e && e.message) + '), and a broadcast batch ' +
                'cannot confirm without it')
        })
    }

    /**
     * The DOGE-side ATTEST batch actions, read on the standing DOGE indexer.
     *
     * There is no generic `query` on the harness Database, and no helper anywhere
     * reads an action by version, so this is the first `version IN (5, 6)` reader in
     * the tree: connection out, connection released in a finally, exactly as
     * `src/db.js` does it everywhere else. `at` is quoted because it is a reserved
     * word in some MariaDB versions and an unquoted alias would fail only there.
     */
    async function readDogeBatchActions () {
        // Read on the VENUE's DOGE indexer (see the before-hook), never the standing
        // one: only a node mirroring the venue federation holds the capability
        // snapshot the verdict is judged against.
        if (!dogeVenue || !dogeVenue.indexers[0]) return []
        try {
            return await queryVenueDb(dogeVenue, dogeVenue.indexers[0].indexerDbName,
                'SELECT a.action_index, a.block_index, `at`.version, `at`.batch_window_start, ' +
                '       `at`.batch_window_end, `at`.batch_row_count, `at`.batch_chunk_index, ' +
                '       `at`.batch_total_chunks, s.status AS verdict ' +
                'FROM attests `at` JOIN actions a ON a.action_index = `at`.action_index ' +
                'LEFT JOIN index_statuses s ON s.id = `at`.status_id ' +
                'WHERE `at`.version IN (?, ?) ORDER BY a.action_index ASC',
                [BATCH_HEAD_VERSION, BATCH_CONTINUATION_VERSION])
        } catch (e) {
            // Reported rather than swallowed: an unreadable DOGE side is a different
            // failure from an empty one, and the caller's assertion prints this.
            console.log('AT5: could not read DOGE batch actions: ' + (e && e.message))
            return []
        }
    }

    it('lands a window of responses on DOGE as a valid v5 head with its continuations', async function () {
        // Two large responses in one window: enough compressed bytes to exceed a
        // single 8189-byte wire, so the batch has to chunk.
        const ids = []
        for (const tag of ['b1', 'b2']) {
            const sinceAction = await attestRequestWatermark(contract.contractIndex)
            await clearBeforeBroadcast()
            const exec = await mineWhile(() => vmHelper.sendExecuteV0(
                contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl + '?' + tag, tag]))
            assert.strictEqual(exec.execution.status, 'valid',
                tag + ': the EXECUTE that emits the request came back ' + exec.execution.status)
            // Correlated on the emitting action, never on the broadcast txid: for a
            // P2SH-encoded EXECUTE that hash is not the one recorded against the row.
            const request = await findEmittedAttestRequest(
                contract.contractIndex, sinceAction + 1, { label: tag })
            ids.push(request.requestId)
        }

        await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
        await settleOrReport('at5')
        for (const id of ids) await waitForMirrorRowEverywhere(venue, id, null, {
                mineWhileWaiting: { perPoll: 1, maxBlocks: widenArithmetic(DEADLINE_BLOCKS).safeCap },
            })
        // Mined under, as AT1's applied wait is: the applier runs inside the block
        // loop, so an idle chain never applies a row that is already valid.
        for (const id of ids) await waitForAppliedEverywhere(venue, id, null,
                { mineWhileWaiting: { perPoll: 1, maxBlocks: widenArithmetic(DEADLINE_BLOCKS).safeCap } })
        console.log('AT5: ' + ids.length + ' responses finalized and applied; waiting for their window to close')

        // The window has to close, be elected, be signed and be broadcast. Several
        // windows of patience, because rank decides who publishes and when.
        const sent = await untilOrClearDogeStall(async () => {
            // One DOGE block per poll, IN SEQUENCE with everything else this drill
            // does (a timer-driven cadence raced the rail switch, pass 9). The
            // publisher pays each window out of the previous window's CHANGE and the
            // encoder spends confirmed outputs only; with nothing mining DOGE here,
            // pass 8 saw 8 of 22 windows fail `insufficient funds`, the responses'
            // window among them, and the publisher never retries a failed broadcast.
            await nudgeDoge()
            const markers = await readMarkers()
            const hit = markers.filter((m) => Number(m.row_count) > 0 &&
                (String(m.status) === 'sent' || String(m.status) === 'landed'))
            return { ok: hit.length > 0, hit: hit, markers: markers }
        }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(sent.ok,
            'no hub ever published a non-empty window. Markers seen: ' + jsonSafe(sent.markers) +
            '. A window with rows that never reaches `sent` is either unelected, unsigned, unanchored or ' +
            'unfunded, and the hub logs say which. Publication is ELECTED, so the hub that should have ' +
            'published is not knowable here and every tail follows.\n' + allHubTails(venue))
        const marker = sent.hit[0]
        console.log('AT5: hub ' + marker.hub + ' published window ' + marker.window_start + '-' +
            marker.window_end + ' with ' + marker.row_count + ' row(s), status ' + marker.status)

        // AND IT LANDED ON DOGE, judged valid, as a head plus its continuations.
        const landed = await untilOrClearDogeStall(async () => {
            await nudgeDoge()
            const actions = await readDogeBatchActions()
            const heads = actions.filter((a) => Number(a.version) === BATCH_HEAD_VERSION &&
                Number(a.batch_window_start) === Number(marker.window_start))
            // A VALID head, not the first head. The same window's head can sit on the
            // chain more than once and the indexer judges each arrival on what it holds
            // at that block: pass 18 (2026-09-05) recorded one `invalid: ATTEST_BATCH
            // (crc32-mismatch)` head, its continuations not yet all indexed, and two
            // valid ones for one window, and the lowest action index was the invalid
            // one. Coverage is provable the moment ONE valid head exists.
            const valid = heads.filter((h) => String(h.verdict) === 'valid')
            return { ok: valid.length > 0, heads: heads, valid: valid, actions: actions }
        }, { timeoutMs: 20 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(landed.ok,
            'the published window never appeared on DOGE as a VALID ATTEST v5. Heads seen for it: ' +
            jsonSafe((landed.heads || []).map((h) => ({ action: h.action_index, block: h.block_index, verdict: h.verdict }))) +
            '. All batch actions seen: ' + jsonSafe(landed.actions))
        if (landed.heads.length > landed.valid.length) {
            console.log('AT5 NOTE: window ' + marker.window_start + ' has ' + landed.heads.length + ' head row(s) on DOGE, ' +
                landed.valid.length + ' valid; the others: ' +
                landed.heads.filter((h) => String(h.verdict) !== 'valid').map((h) => h.action_index + '=' + h.verdict).join(', '))
        }

        const head = landed.valid[0]
        assert.strictEqual(Number(head.batch_row_count), Number(marker.row_count),
            'the head declares ' + head.batch_row_count + ' rows and the publisher recorded ' +
            marker.row_count)

        const total = Number(head.batch_total_chunks)
        assert.ok(total >= 1, 'the head declares no chunk total')
        if (total > 1) {
            const conts = landed.actions.filter((a) => Number(a.version) === BATCH_CONTINUATION_VERSION)
            assert.ok(conts.length >= total - 1,
                'the head declares ' + total + ' chunks but only ' + conts.length +
                ' continuation(s) landed, so the window cannot be reassembled from chain alone')
            console.log('AT5: window landed as a v5 head plus ' + conts.length + ' v6 continuation(s)')
        } else {
            // Said out loud rather than passed over: the continuation half of this
            // clause did not get exercised on this run.
            console.log('AT5 NOTE: the window fitted in ONE wire, so no v6 continuation was produced ' +
                'and the continuation half of this clause was not exercised. Raise INCOMPRESSIBLE_BYTES ' +
                'or the number of responses per window to force chunking.')
        }

        // AND THE LINK COMES BACK. The DOGE side pushes the batch to the hub, the hub
        // stamps batch_action_index on its mirror row and re-broadcasts it, and the BTC
        // indexer writes it onto the applied response. That whole road is what this
        // single column proves.
        const linked = await untilOrClearDogeStall(async () => {
            // The link travels DOGE parse to hub push to mirror stream, so the DOGE
            // side has to keep confirming for any of it to happen.
            await nudgeDoge()
            const rows = []
            for (const id of ids) {
                const r = await venue.readMirrorRows(0, { requestId: id })
                rows.push(r[0] && r[0].batch_action_index)
            }
            return { ok: rows.every((v) => v !== null && v !== undefined), rows: rows }
        }, { timeoutMs: 20 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(linked.ok,
            'batch_action_index was never set on the mirrored rows: ' + jsonSafe(linked.rows) +
            '. The batch landed, so the gap is on the DOGE-parse to hub-push to mirror road.')
        console.log('AT5: batch_action_index set on every carried row')
    })

    it('publishes an empty window as a row_count 0 head, which is what makes coverage provable', async function () {
        // Nothing is requested here on purpose. Every window publishes, including one
        // with no rows, and that is exactly what lets a chain-only node prove it has
        // missed nothing rather than assume it.
        const empty = await untilOrClearDogeStall(async () => {
            const markers = await readMarkers()
            const hit = markers.filter((m) => Number(m.row_count) === 0 &&
                (String(m.status) === 'sent' || String(m.status) === 'landed'))
            return { ok: hit.length > 0, hit: hit, markers: markers }
        }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(empty.ok,
            'no empty window was ever published. Markers: ' + jsonSafe(empty.markers) +
            '. An empty window that is skipped rather than published leaves a hole a chain-only node ' +
            'cannot tell from a window it simply did not receive.')

        const marker = empty.hit[0]
        const landed = await untilOrClearDogeStall(async () => {
            await nudgeDoge()
            const actions = await readDogeBatchActions()
            const heads = actions.filter((a) => Number(a.version) === BATCH_HEAD_VERSION &&
                Number(a.batch_window_start) === Number(marker.window_start))
            return { ok: heads.length > 0, heads: heads }
        }, { timeoutMs: 20 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(landed.ok, 'the empty window was marked published but never landed on DOGE')
        assert.strictEqual(Number(landed.heads[0].batch_row_count), 0,
            'the empty window landed declaring ' + landed.heads[0].batch_row_count + ' rows')
        assert.strictEqual(String(landed.heads[0].verdict), 'valid',
            'the empty head was judged ' + landed.heads[0].verdict)
        assert.strictEqual(Number(landed.heads[0].batch_total_chunks), 1,
            'an empty window should be a single wire, not ' + landed.heads[0].batch_total_chunks)
        console.log('AT5: empty window ' + marker.window_start + ' landed as a valid row_count 0 head')
    })

    /**
     * NOT DRIVABLE AT ANY REASONABLE COST, and the number is the reason.
     *
     * A window dead-letters when it holds more rows than `ATTEST_BATCH_MAX_ROWS`,
     * which is a frozen protocol constant of 256, compared in the publisher at
     * `rows.length > ATTEST_BATCH_MAX_ROWS` against a read that deliberately
     * over-selects by one so 257 is detectable. Producing 257 terminal responses
     * inside a single window means 257 full PBFT attestation rounds, each with a
     * provider fetch, in one window; on this venue that is hours of drilling to
     * exercise one comparison.
     *
     * The other dead-letter causes are byte-size rather than row count
     * (`ATTEST_BATCH_MAX_INFLATED_BYTES` at 1 MiB, reached at roughly 128 rows at
     * the body cap), so they are no cheaper. None of the three is overridable: they
     * are consensus constants with no environment seam, correctly.
     *
     * WHAT COVERS IT INSTEAD, so this is a judgement rather than a hole: the hub's
     * own unit tier drives the publisher against a synthetic over-cap window and
     * asserts both halves of "loudly", the CRITICAL log and the `deadletter` marker
     * row, which is where a 257-row fixture costs milliseconds instead of hours.
     *
     * The operator's call, and it is a wording question rather than a work question:
     * accept the unit coverage for this clause, or fund the hours.
     */
    it.skip('dead-letters an over-budget window loudly (needs 257 rounds: see comment)', async function () {
        assert.fail('unreachable: 257 attestation rounds in one window')
    })

    /**
     * NEEDS A VENUE THIS HELPER DOES NOT BUILD, and the shape of it is worth naming
     * because it is a real gap rather than a hard one.
     *
     * The clause wants a FRESH CHAIN-ONLY node: a BTC indexer with its mirror
     * DISABLED, which advances only on batch coverage, rebuilds
     * `attestation_responses` from the v5/v6 bodies its DOGE side parses, and
     * re-derives every callback with zero mismatches against a mirror-fed node.
     *
     * `AttestMirrorVenue` stands up indexers that all follow a hub with
     * `HUB_DB_SYNC_ENABLED=true`; there is no option for a mirror-disabled member,
     * and adding one is not a one-line change, because such a node also needs its
     * own DOGE-side indexer to do the parsing and a hub to push the parsed rows to.
     * The road is real and shipped (`price.js`'s batch parse enqueues a hub push,
     * the hub validates and inserts, the ordinary mirror broadcast follows), so
     * what is missing is venue construction, not product.
     *
     * It also inherits the standing caveat that chain-only reconstruction still
     * needs a Bitcoin indexer for capability snapshots, which is why the clause
     * says "with its BTC indexer" rather than "from DOGE alone".
     *
     * Recommended as its own item rather than folded into this drill: a
     * `chainOnlyIndexers` option on the venue plus a DOGE-side child, then this case
     * is a comparison of two databases.
     */
    it.skip('rebuilds the mirror on a chain-only node with 0 mismatches (needs a venue option: see comment)',
        async function () {
            assert.fail('unreachable: the venue builds no mirror-disabled indexer')
        })
})
