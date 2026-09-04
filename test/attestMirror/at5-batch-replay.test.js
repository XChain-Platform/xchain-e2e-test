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
 * THE PRECONDITION THAT GATES ALL OF IT, and it is not a code defect. The hub's
 * `AttestationBatchPublisher` is constructed and started on every real hub boot and
 * regtest is armed at height 0, so the venue's hubs are ALREADY closing windows on
 * the cadence the venue sets. They can publish nothing, because publishing needs
 * three things the venue does not and should not invent: a signer module
 * (`HUB_SIGNER_MODULE`), a DOGE encoder URL, and a funded DOGE address to pay the
 * transaction. Those are operator property. So this drill reads them from the
 * environment, passes them to the hubs through the venue's `hubExtraEnv` seam, and
 * SKIPS LOUDLY naming each missing one rather than pretending a silent publisher is
 * a passing test. A window that never publishes is indistinguishable from a window
 * that published nothing, and that is precisely the confusion this refuses.
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
const http   = require('http')
const dotenv = require('dotenv')
dotenv.config()

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')
const {
    stakeDrillIdentities, deployRequestContract, settleStack, queryVenueDb,
} = require('./mirrorDrillFixture')
const {
    untilOrClearDogeStall, waitForMirrorRowEverywhere, waitForAppliedEverywhere,
    venueTipProbe, mineDogeBlocks,
} = require('./mirrorDrillWaits')
const vmHelper  = require('../helpers/vmHelper')
const chainRail = require('../helpers/chainRail')

// Short enough that several windows close inside a drill, and comfortably above
// the four-times-the-hop floor the venue's own timing invariant would impose if
// this hub keyed windows on wall clock rather than on the signed effective time.
const BATCH_WINDOW_S = 30

// Above the gossip hop budget, as the venue requires, and above the window so a
// row destined for a window is written a whole margin before it can close.
const FORWARD_S = 8

const DEADLINE_BLOCKS = 60
const BURIAL_BLOCKS   = 6

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
 * The hub environment the batch publisher needs, and what is missing from it.
 *
 * Returns `{env, missing}`. Everything is read from the process environment
 * rather than invented: a DOGE address this drill minted would hold no coin, and a
 * signer module it wrote would be a second implementation of a production seam.
 */
function resolveBatchPublisherEnv () {
    const wanted = {
        HUB_SIGNER_MODULE: process.env.HUB_SIGNER_MODULE,
        DOGE_ENCODER_URL:  process.env.DOGE_ENCODER_URL,
        DOGE_ADDRESS:      process.env.DOGE_ADDRESS,
        DOGE_PUBKEY_HEX:   process.env.DOGE_PUBKEY_HEX,
    }
    const missing = Object.keys(wanted).filter((k) => !wanted[k])
    const env = {}
    for (const [k, v] of Object.entries(wanted)) if (v) env[k] = String(v)
    if (process.env.DOGE_ENCODER_API_KEY) env.DOGE_ENCODER_API_KEY = String(process.env.DOGE_ENCODER_API_KEY)
    // Explicitly on, so a drill never depends on the default staying true.
    env.ATTEST_BATCH_PUBLISH_ENABLED = 'true'
    return { env: env, missing: missing }
}

describe('AT5: the responses of a window land on chain as one batch', function () {
    this.timeout(120 * 60 * 1000)

    let venue      = null
    let up         = false
    let httpServer = null
    let testUrl    = null
    let contract   = null
    let publisher  = null
    let dogeRail   = null

    before(async function () {
        publisher = resolveBatchPublisherEnv()
        if (publisher.missing.length > 0) {
            // LOUD, and naming every missing piece at once so an operator wiring this
            // up needs one round trip rather than four.
            console.log('AT5 SKIPPED: the attestation batch publisher is not wired on this box. ' +
                'Missing: ' + publisher.missing.join(', ') + '. The hubs are already closing ' +
                BATCH_WINDOW_S + 's windows (regtest is armed at height 0 and the publisher starts with ' +
                'every hub), but publishing a window needs a signer module, a DOGE encoder and a FUNDED ' +
                'DOGE address, none of which a test may invent. Set those four in the harness environment ' +
                'and this drill runs; the venue passes them straight through to every hub.')
            this.skip()
            return
        }

        await new Promise((resolve) => {
            httpServer = http.createServer((req, res) => {
                // Incompressible: random hex, so deflate cannot shrink the batch body
                // below the wire ceiling and the chunking under test actually happens.
                const filler = require('crypto').randomBytes(INCOMPRESSIBLE_BYTES / 2).toString('hex')
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ path: String(req.url), filler: filler }))
            })
            httpServer.listen(0, '127.0.0.1', () => {
                testUrl = 'http://127.0.0.1:' + httpServer.address().port + '/blob'
                resolve()
            })
        })

        const staked = await stakeDrillIdentities({ label: 'at5', count: 5 })
        venue = new AttestMirrorVenue({
            label: 'at5',
            identities: staked.identities,
            forwardS: FORWARD_S,
            batchWindowS: BATCH_WINDOW_S,
            hubExtraEnv: publisher.env,
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
        dogeRail = await chainRail.createRail('dogecoin', 'regtest')
    })

    after(async function () {
        if (httpServer) await new Promise((r) => httpServer.close(() => r()))
        if (venue) await venue.stop()
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
            const exec = await vmHelper.sendExecuteV0(
                contract.owner, contract.contractIndex, 'ask', ['http_get', testUrl + '?' + tag, tag])
            assert.strictEqual(exec.execution.status, 'valid',
                tag + ': the EXECUTE that emits the request came back ' + exec.execution.status)
            const request = await indexerDatabase.waitForAttestationRequest({
                txHash: exec.txHash, requestStatus: 'pending',
            })
            assert.ok(request, tag + ': no pending request row on the standing indexer')
            ids.push(String(request.request_id))
        }

        await regtestMinerConnector.generateBlocks(BURIAL_BLOCKS)
        await settleStack()
        for (const id of ids) await waitForMirrorRowEverywhere(venue, id)
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
            'unfunded, and the hub logs say which.\n' + venue.logTail('hub0'))
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
