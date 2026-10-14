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
 * DOGE regtest, `valid`, with `batch_action_index` set; an empty window leaves a
 * local `skipped` marker and no head; a fresh chain-only node rebuilds the mirror
 * table from the batches and re-derives every callback with 0 mismatches; an
 * over-budget window dead-letters loudly.
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
 * a venue coordinate pinned in `chainRail`. `stageDogeSigner` (in the parts directory) now builds all
 * three, and the only skip left is a DOGE rail that cannot be reached at all.
 *
 * The general shape, since it has caught more than one lane: "I cannot do X"
 * hardening into "the operator must do X" without a measurement in between.
 *
 * THE SECOND PRECONDITION is the anchor. `resolveAnchor` reads a BTC chain tip
 * that arrives on the hub only through the `pushchaintip` JSON-RPC, and without one
 * the publisher defers every window with a latched warning and publishes nothing.
 * The drill pushes it to every hub itself, because on this venue no production BTC
 * indexer is pointed at these hubs to do it.
 *
 * THE RESPONSE PROVIDER DEFAULTS TO `llm`, preserving the original drive. An
 * isolated stack whose whole seated roster is recoverable from the federation
 * mnemonic can opt in to `http_get` with AT5_RESPONSE_PROVIDER=http_get. That
 * mode serves a deterministic response from the runner's throwaway TLS fixture
 * and hands the fixture CA plus the regtest-only private-address allowance to the
 * venue hubs. It is never an automatic credential fallback. On a standing chain
 * with an inaccessible seated key, `provisionDrillIdentities` still refuses the
 * http_get drive before any request can be made.
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

const { prepareProvider, openDogeRail, bootDrill } = require('./at5_batch_replay.test/venue_boot.test.js')
const { runResponseWindowCase } = require('./at5_batch_replay.test/response_window.test.js')
const { runEmptyWindowCase } = require('./at5_batch_replay.test/empty_window.test.js')
const { RESPONSE_PROVIDER } = require('./at5_batch_replay.test/config.test.js')

describe('AT5: the responses of a window land on chain as one batch', function () {
    this.timeout(120 * 60 * 1000)

    // Everything the parts share. `tipFeeder` and `tipFeedBusy` are the live BTC tip
    // feeder and its re-entrancy latch; `btcNode` is the BTC connector as it stands
    // before the first rail switch (see pushLiveTipToAllHubs in the parts).
    const ctx = {
        venue: null, dogeVenue: null, up: false, contract: null, publisher: null,
        dogeRail: null, testServer: null, llm: { ok: false, why: 'not probed' },
        responseProvider: RESPONSE_PROVIDER, tipFeeder: null, tipFeedBusy: false, btcNode: null,
    }

    before(async function () {
        await prepareProvider(ctx)
        if (!(await openDogeRail(ctx))) return this.skip()
        if (!(await bootDrill(ctx))) return this.skip()
    })

    after(async function () {
        if (ctx.tipFeeder) { clearInterval(ctx.tipFeeder); ctx.tipFeeder = null }
        // The attached venue first: its indexer follows a hub the owner is about to kill.
        if (ctx.dogeVenue) await ctx.dogeVenue.stop()
        if (ctx.venue) await ctx.venue.stop()
        if (ctx.testServer) await ctx.testServer.close()
        // The staged signer holds a WIF only in the hub children's environment, but the
        // directory itself is this drill's litter and goes back.
        if (ctx.publisher && ctx.publisher.signerDir) {
            try { require('fs').rmSync(ctx.publisher.signerDir, { recursive: true, force: true }) }
            catch (internal) { /* already gone */ }
        }
    })

    it('lands a window of responses on DOGE as a valid v5 head with its continuations', async function () {
        if (ctx.responseProvider === 'llm' && !ctx.llm.ok) {
            // Skipped, not passed, and not silently re-aimed at http_get. AT5's
            // response-carrying clause is unproven by a run that reports this case
            // pending, and the reason is printed in the before-hook rather than left
            // to whoever reads a pending dot.
            this.skip()
        }
        await runResponseWindowCase(ctx)
    })

    it('publishes nothing for an empty window', async function () {
        await runEmptyWindowCase(ctx)
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
     * The road is real and shipped (`price/index.js`'s batch parse enqueues a hub push,
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
