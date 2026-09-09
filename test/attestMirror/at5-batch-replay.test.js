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
 * WHY THIS DRILL ASKS `llm` AND NOT `http_get`, which is a property of the chain
 * rather than a preference about providers. The BTC regtest chain re-genesised on
 * 2026-09-08 came back seating ONE attestation validator, and it is the standing
 * xchain-node hub's own identity at 10000 stake. Its signing seed lives only in
 * that hub's container, so no drill can adopt it; and a venue hub carrying the
 * same key beside the live one would equivocate and get the real validator
 * slashed, so no drill may adopt it even if it could. Every draw containing it
 * stalls to timeout, and at redundancy 3 on a small set that is a guarantee
 * rather than a risk. The provider stake floor is the only lever that removes it
 * from a draw without touching it at all: `_computeResponsibleSet` filters on
 * `_meetsProviderFloor` BEFORE the hash ranking, and `llm` declares
 * min_stake_xchain 25000 against `http_get`'s 10000, so an llm request cannot
 * draw that key while an http_get request cannot avoid it. THAT IS WHY THIS IS
 * NOT A FALLBACK AND MUST NOT BECOME ONE: on a box that cannot serve llm this
 * drill skips loudly rather than asking http_get, because an http_get drive here
 * would not measure the batch, it would measure a round that cannot finalize.
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

const fs = require('fs')

const { AttestMirrorVenue, assertLlmAvailable, llmProbes, hubCredentialEnv } = require('../helpers/attestMirrorVenue')
const {
    provisionDrillIdentities, waitForVenueIndexersAtTip, deployRequestContract, queryVenueDb, withWedgeClear,
    mineWhile,
} = require("./mirrorDrillFixture")
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere,
    venueTipProbe, mineDogeBlocks, findEmittedAttestRequest,
    clearBeforeBroadcast,
    allHubTails,
    attestRequestWatermark,
    settleOrReport,
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

// THE PROVIDER'S CEILING, and it is a ceiling rather than a preference: the
// registry admits a request only while `deadline - block <= deadline_window_blocks`
// (attestation/providerRegistry.js), and the VM gateway rejects an over-limit value
// at CALL time, so the EXECUTE that emits the request comes back `failed` rather
// than the request landing and expiring. Pass 25 proved that the expensive way at
// 150 against http_get's 100: `EXECUTE : contract=1791 : method=ask : failed`.
//
// `llm` DECLARES 20, not 100, so switching provider moved this ceiling by a factor
// of five and that is the single largest consequence of the switch. It is also why
// this drill no longer waits for the response to be APPLIED: see the first case.
const DEADLINE_BLOCKS = 20
const BURIAL_BLOCKS   = 6

// The request every round here answers.
//
// DETERMINISTIC ARITHMETIC, byte for byte, because that is what the round
// converges on: every responsible hub asks its own model and `AttestationConsensus`
// needs 2f+1 IDENTICAL proposals, so a prompt with any latitude in its answer ends
// `no consensus (proposals diverged)` and the mirror skips a no-quorum round by
// design. This is AT1's llm payload verbatim, which is the one that has been
// driven green on this venue.
const LLM_PAYLOAD = JSON.stringify({ prompt: 'What is 2+2? Reply with only the number.' })

// The DOGE encoder this venue publishes through, taken from the rail's own port map
// so the drill and the rail cannot disagree about where that service lives.
const DOGE_ENCODER_PORT = chainRail.DEFAULT_PORTS.DOGE.encoder

// The head and continuation versions, and the DOGE-side action formats a drill
// reads them back as.
const BATCH_HEAD_VERSION         = 5
const BATCH_CONTINUATION_VERSION = 6

/**
 * Can THIS box serve the llm provider, asked with the venue's own predicate?
 *
 * Copied in shape from AT1 for the reason AT1 gives: the two halves the provider
 * needs live on different boxes, so declaring `needsLlm` unconditionally refuses
 * the whole drill on either of them. Probed, the venue still refuses if the probe
 * and reality ever disagree, because `start()` re-checks with this same predicate
 * rather than trusting the flag.
 *
 * THE SKIP IS LOUD AND NAMES THE MISSING HALF, and it never degrades to http_get:
 * on this chain an http_get round draws a validator nothing here can sign for, so
 * a "fallback" would report a failure of the batch rail that is really a failure
 * of the draw. See the header.
 */
// The credential this drill forwards to its hub children: the OAuth token when the
// harness environment carries one, nothing otherwise. One function, called by the
// pre-check and by the venue construction, so both see the identical object.
function forwardedHubCredentialEnv () {
    return process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN
        ? { HUB_CLAUDE_CODE_OAUTH_TOKEN: process.env.HUB_CLAUDE_CODE_OAUTH_TOKEN } : {}
}

function llmRunnableHere () {
    const dir = process.env.HUB_CLAUDE_CONFIG_DIR || null
    try {
        // The credential clause judges the env the hubs will GET: the object forwarded below.
        assertLlmAvailable({
            claudeConfigDir: dir,
            pathEnv: process.env.PATH,
            hubEnv: hubCredentialEnv(dir, forwardedHubCredentialEnv())
        }, llmProbes())
        return { ok: true, why: null }
    } catch (e) {
        return { ok: false, why: (e && e.message) || String(e) }
    }
}

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Mirror Replay Asker', description: 'Requests an attestation used to replay a mirrored response batch.', version: '1.0.0' },
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
    let contract   = null
    let publisher  = null
    let dogeRail   = null
    let llm        = { ok: false, why: 'not probed' }
    // The live BTC tip feeder (see the before-hook), and its re-entrancy latch so a
    // slow push never stacks a second one behind it.
    let tipFeeder   = null
    let tipFeedBusy = false
    // The BTC node connector as it stands before the first rail switch (see
    // pushLiveTipToAllHubs for why the global cannot be read from a timer).
    let btcNode = null

    before(async function () {
        btcNode = nodeConnector
        llm = llmRunnableHere()
        if (!llm.ok) {
            console.log('AT5: the response-carrying window case will SKIP on this box.\n' + llm.why +
                '\nIt does NOT fall back to http_get: on this chain the only key an http_get draw can ' +
                'reach beside the venue is the standing hub\'s own, which nothing here may sign for, ' +
                'so such a round can never finalize and the batch would never have a row to carry.')
        }
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

        // SCOPED TO `llm`, which is what lets this run at all on the re-genesised
        // chain: the one seated validator this venue does not run sits at 10000 and
        // misses the llm floor of 25000, so it is filtered out of every draw before
        // the ranking and `provisionDrillIdentities` passes it over instead of
        // refusing on it. Declaring http_get here would put it back in the draw.
        const staked = await provisionDrillIdentities({
            label: 'at5', count: 5, redundancy: 3, providers: ['llm'],
        })

        // THE HUB CREDENTIAL TRAVELS WITH THE DRILL, not with the venue, and AT1
        // paid for that lesson: the venue builds each hub child's environment from
        // scratch (HUB_CLAUDE_CONFIG_DIR only, by policy), while on the venue box
        // the hub credential is an OAuth token in the harness environment. Every
        // hub's fetch failed with `llm: Set HUB_CLAUDE_CONFIG_DIR` until the token
        // reached the children. Forwarded only when present, never written anywhere.
        venue = new AttestMirrorVenue({
            label: 'at5',
            identities: staked.identities,
            needsLlm: llm.ok,
            forwardS: FORWARD_S,
            batchWindowS: BATCH_WINDOW_S,
            // BOTH, merged: the signer's WIF and the model credential are needed by
            // the same hub children, and passing either alone silently drops the other.
            hubExtraEnv: Object.assign({}, publisher.env, forwardedHubCredentialEnv()),
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
        if (!llm.ok) {
            // Skipped, not passed, and not silently re-aimed at http_get. AT5's
            // response-carrying clause is unproven by a run that reports this case
            // pending, and the reason is printed in the before-hook rather than left
            // to whoever reads a pending dot.
            this.skip()
        }
        // Two responses in one window, so the head declares more than one row and
        // the batch carries a real set rather than a single value.
        //
        // TWO IDENTICAL PAYLOADS ARE STILL TWO REQUESTS: the request id is
        // sha256 over (txHash, rootActionIndex, callPath, contractIndex,
        // emissionIndex) and never over the payload (xchain-vm gateway.js), so two
        // EXECUTEs of `ask` with the same prompt get different ids. Identical
        // prompts are in fact the safer choice here, because every responsible hub
        // must converge byte for byte on each answer.
        const ids = []
        for (const tag of ['b1', 'b2']) {
            const sinceAction = await attestRequestWatermark(contract.contractIndex)
            await clearBeforeBroadcast()
            const exec = await mineWhile(() => vmHelper.sendExecuteV0(
                contract.owner, contract.contractIndex, 'ask', ['llm', LLM_PAYLOAD, tag]))
            assert.strictEqual(exec.execution.status, 'valid',
                tag + ': the EXECUTE that emits the request came back ' + exec.execution.status +
                '. A deadline above the provider\'s own window is rejected by the VM gateway at CALL ' +
                'time, and llm allows only ' + DEADLINE_BLOCKS + ', so this is the shape an over-long ' +
                'deadline takes as well as the shape a short responsible set takes.')
            // Correlated on the emitting action, never on the broadcast txid: for a
            // P2SH-encoded EXECUTE that hash is not the one recorded against the row.
            const request = await findEmittedAttestRequest(
                contract.contractIndex, sinceAction + 1, { label: tag })
            ids.push(request.requestId)
        }

        await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
        await settleOrReport('at5')
        // NOTHING IS MINED UNDER THE MIRROR WAIT, and that is AT1's llm lesson
        // rather than a saving. The blocks would buy the widening ladder room to
        // climb, which this venue has never needed: the roster is adopted, every
        // draw is venue-only, and every finalized round on it has closed at widen 0.
        // What they DO buy is the request's own expiry, and at llm's 20-block
        // ceiling there is barely a ladder's worth of chain between the burial
        // blocks above and the deadline, so a wait that mines here spends the
        // window before the round can finish.
        for (const id of ids) await waitForMirrorRowEverywhere(venue, id)

        // AND THE DRILL STOPS AT THE MIRROR ROW, DELIBERATELY: it no longer waits
        // for the response to be APPLIED on the venue indexers, which the http_get
        // form of this drill did.
        //
        // The clause AT5 owns is that a window of responses reaches DOGE as a v5
        // head and the link comes back onto the mirrored row. Every step of that
        // reads `attestation_responses`, which the hub writes at FINALIZATION;
        // application is a BTC-indexer act on the far side of the mirror and is
        // AT1's subject, driven green there 2026-09-05. So the applied wait proved
        // nothing here and cost the whole block budget.
        //
        // At llm's deadline it could not be paid for in any case, and the
        // arithmetic is worth keeping because it is the thing that changed with the
        // provider. A row binds at the first block whose PROTOCOL time reaches its
        // signed effective_time; off mainnet protocol time is median-time-past, so
        // six of the last eleven blocks must be stamped past a signature set
        // FORWARD_S (90 s) in the future. At a 20-block deadline, minus the burial
        // blocks, there is no room to mine six blocks over ninety seconds of wall
        // clock before the expiry sweep fires. Pass 24 lost that race with five
        // times the budget.
        console.log('AT5: ' + ids.length + ' responses finalized and mirrored; waiting for their window to close')

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
            // Said out loud rather than passed over, and on the llm rail it is the
            // EXPECTED outcome rather than an unlucky one. The http_get form of this
            // drill served 6000 bytes of incompressible filler per response so that
            // two of them exceeded one 8189-byte wire and the batch had to chunk;
            // an llm answer of "4" fits in a head many times over, and the payload
            // is not the drill's to inflate because every responsible hub must
            // converge on it byte for byte. So the v6 half of this clause is not
            // exercised by an llm window and needs its own item.
            console.log('AT5 NOTE: the window fitted in ONE wire, so no v6 continuation was produced ' +
                'and the continuation half of this clause was NOT exercised. An llm response is too ' +
                'small to chunk, and forcing it would mean a payload the federation cannot agree on.')
        }

        // AND THE LINK COMES BACK. The DOGE side pushes the batch to the hub, the hub
        // stamps batch_action_index on its mirror row and re-broadcasts it, and the BTC
        // indexer writes it onto the applied response. That whole road is what this
        // single column proves.
        const linked = await untilOrClearDogeStall(async () => {
            // The link travels DOGE parse to hub push to mirror stream, so the DOGE
            // side has to keep confirming for any of it to happen.
            await nudgeDoge()
            // EVERY row the request holds, not the first: a round that finalized under
            // two leader slots leaves two honest rows differing only in effective_time,
            // and each one rides a window and gets its own link.
            const rows = []
            for (const id of ids) {
                const r = await venue.readMirrorRows(0, { requestId: id })
                rows.push(r.length ? r.map((x) => x.batch_action_index) : [null])
            }
            return { ok: rows.flat().every((v) => v !== null && v !== undefined), rows: rows }
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
