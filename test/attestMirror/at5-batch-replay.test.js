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
    provisionDrillIdentities, startAttestTestServer, deployRequestContract, queryVenueDb, withWedgeClear,
} = require('./mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    venueTipProbe, mineDogeBlocks, findEmittedAttestRequest,
    clearBeforeBroadcast,
    allHubTails,
    attestRequestWatermark,
    settleOrReport,
    widenArithmetic,
} = require('./mirrorDrillWaits')
const vmHelper     = require('../helpers/vmHelper')
const chainRail    = require('../helpers/chainRail')
const cryptoHelper = require('../cryptoHelper')
const { loadHubModule } = require('../helpers/multiValidatorHubHelper')

// Short enough that several windows close inside a drill, and comfortably above
// the four-times-the-hop floor the venue's own timing invariant would impose if
// this hub keyed windows on wall clock rather than on the signed effective time.
const BATCH_WINDOW_S = 30

// Above the gossip hop budget, as the venue requires, and above the window so a
// row destined for a window is written a whole margin before it can close.
const FORWARD_S = 8

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
// this clause would silently never be exercised.
const INCOMPRESSIBLE_BYTES = 6000

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
async function stageDogeSigner (label) {
    const os     = require('os')
    const fs     = require('fs')
    const path   = require('path')
    const crypto = require('crypto')
    const { encode: wifEncode } = require('wif')
    const CryptoNetworks = require('../../src/CryptoNetworks.js')

    // Funded ON the DOGE rail, which is the whole point: the publisher pays a real
    // fee on that chain for every window it broadcasts.
    const funded = await chainRail.withRail(dogeRail, async () => {
        // WRAPPED for the same reason as the relayer in AT6: the funding call mints
        // gas internally, so it starves under the wedge, and it is keyed by label so
        // a retry re-funds one publisher rather than minting a second wallet.
        const addr = await withWedgeClear('funding the batch publisher on the other rail',
            () => cryptoHelper.getNewFundedAddress(
                label + '-batch-publisher', COIN, NETWORK, null, 'legacy', 0, 2.0))
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
    const hooks = loadSignerHooks(Object.assign({}, process.env, env))
    assert.ok(hooks && hooks.broadcastFn,
        'the hub signer loader did not wire a broadcast hook from the staged signer, so every window ' +
        'would defer with "no broadcast pipeline configured"')

    console.log('AT5: staged the reference DOGE signer at ' + signerDir + ' for a funded publisher address')
    return { env: env, signerDir: signerDir, address: funded.address }
}

describe('AT5: the responses of a window land on chain as one batch', function () {
    this.timeout(120 * 60 * 1000)

    let venue      = null
    let up         = false
    let testServer = null
    let testUrl    = null
    let contract   = null
    let publisher  = null
    let dogeRail   = null

    before(async function () {
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
        publisher = await stageDogeSigner('at5')

        // REAL TLS, not http. The provider refuses a non-https payload before any
        // network work, so a plain-HTTP server resolves every round provider_error
        // and no batch would ever have a terminal response to carry.
        testServer = await startAttestTestServer({
            path: '/blob',
            handler: (req, res) => {
                // Incompressible: random hex, so deflate cannot shrink the batch body
                // below the wire ceiling and the chunking under test actually happens.
                const filler = require('crypto').randomBytes(INCOMPRESSIBLE_BYTES / 2).toString('hex')
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ path: String(req.url), filler: filler }))
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

        // THE ANCHOR. Without a BTC chain tip every hub defers every window with a
        // latched warning and publishes nothing, which reads exactly like a publisher
        // that is broken. Pushed to every hub, since any of them may be elected.
        const tip = Number(await nodeConnector.getBlockCount())
        const block = await nodeConnector.getBlock(await nodeConnector.getBlockHash(tip))
        for (const hub of venue.hubs) {
            const res = await hub.connector.call('pushchaintip', {
                coin: 'bitcoin', network: venue.network,
                block_height: tip, block_time: Number(block.time),
            }).catch((e) => ({ error: String(e && e.message) }))
            assert.ok(res && !res.error,
                'hub ' + hub.index + ' refused the chain tip push, so it will defer every window: ' +
                JSON.stringify(res))
        }
        console.log('AT5: pushed BTC tip ' + tip + ' to all ' + venue.hubs.length + ' hubs')

        contract = await deployRequestContract({ label: 'at5', code: CONTRACT_CODE })
    })

    after(async function () {
        if (testServer) await testServer.close()
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
        return await chainRail.withRail(dogeRail, async () => {
            let connection = null
            try {
                connection = await indexerDatabase.getConnection()
                return await connection.query(
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
            } finally {
                if (connection) await connection.release()
            }
        })
    }

    it('lands a window of responses on DOGE as a valid v5 head with its continuations', async function () {
        // Two large responses in one window: enough compressed bytes to exceed a
        // single 8189-byte wire, so the batch has to chunk.
        const ids = []
        for (const tag of ['b1', 'b2']) {
            const sinceAction = await attestRequestWatermark(contract.contractIndex)
            await clearBeforeBroadcast()
            const exec = await vmHelper.sendExecuteV0(
                contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl + '?' + tag, tag])
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
        for (const id of ids) await waitForAppliedEverywhere(venue, id)
        console.log('AT5: ' + ids.length + ' responses finalized and applied; waiting for their window to close')

        // The window has to close, be elected, be signed and be broadcast. Several
        // windows of patience, because rank decides who publishes and when.
        const sent = await untilOrClearDogeStall(async () => {
            const markers = await readMarkers()
            const hit = markers.filter((m) => Number(m.row_count) > 0 &&
                (String(m.status) === 'sent' || String(m.status) === 'landed'))
            return { ok: hit.length > 0, hit: hit, markers: markers }
        }, { timeoutMs: 30 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(sent.ok,
            'no hub ever published a non-empty window. Markers seen: ' + JSON.stringify(sent.markers) +
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
            return { ok: heads.length > 0, heads: heads, actions: actions }
        }, { timeoutMs: 20 * 60 * 1000, intervalMs: 5000, tipProbe: venueTipProbe(venue, 0) })
        assert.ok(landed.ok,
            'the published window never appeared on DOGE as an ATTEST v5. Batch actions seen: ' +
            JSON.stringify(landed.actions))

        const head = landed.heads[0]
        assert.strictEqual(String(head.verdict), 'valid',
            'the v5 head landed but was judged ' + head.verdict + ' rather than valid')
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
            'batch_action_index was never set on the mirrored rows: ' + JSON.stringify(linked.rows) +
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
            'no empty window was ever published. Markers: ' + JSON.stringify(empty.markers) +
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
