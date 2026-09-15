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
 * L3 integration: AT2, chain self-sufficiency.
 *
 * THE CLAIM UNDER TEST is the one the whole PRICE v0 spec rests on: the chain
 * alone is enough to rebuild price history. A node that was not there when the
 * federation ran, that has no peer to ask and no database to inherit, must be
 * able to read the chain and arrive at the same price_snapshots and the same fee
 * verdicts as a node that was live the whole time.
 *
 * HOW THE RUN IS SHAPED, and why both sides are built rather than borrowed:
 *
 *   1. a LIVE node comes up first (fresh indexer, its own fresh empty hub, no
 *      peers) and catches up to the chain tip,
 *   2. `oracleBatchVenue` then drives a real quorum federation and publishes
 *      real PRICE transactions onto DOGE regtest, which the live node sees
 *      arrive block by block,
 *   3. the federation is torn down, taking its databases with it,
 *   4. a REPLAY node comes up (the same construction, brand new) and reads the
 *      whole chain from block 0,
 *   5. the two are compared.
 *
 * The live side is BUILT rather than pointed at the standing stack for one
 * measured reason: the only path that writes a chain-derived `price_snapshots`
 * row is `PriceAggregator.receiveValidatedRound`/`receiveValidatedBatch`, whose
 * `reference_block` is the block the PRICE landed in, while a federation hub's
 * own `OracleConsensus` rows put the BTC anchor height in that same column.
 * Comparing those two would be comparing two different quantities on a key AT2
 * explicitly names. Both sides here reconstruct through the same path.
 *
 * WHAT THE CLAIM IS SCOPED TO, and why the scope is the architecture rather than
 * a caveat. Chain-only reconstruction REQUIRES the node to also run a Bitcoin
 * indexer. Capability staking is Bitcoin-only by design, so a node with no
 * Bitcoin view legitimately cannot resolve who was eligible to sign a batch: the
 * qualifying `price` set is anchored to a Bitcoin height, the hub reads it from a
 * BTC indexer, and its indexer twin reads a mirror of that same Bitcoin-anchored
 * set. Inventing a second trust path for validator identity that does not go
 * through Bitcoin would be worse than scoping the claim, so a Bitcoin indexer is
 * a stated PRECONDITION of "chain as backup of last resort", not a workaround
 * for a gap in it.
 *
 * Both nodes here are therefore built with one: a real BTC indexer as their
 * capability oracle, verified to report Bitcoin for itself before either node is
 * trusted, with the hub's own coin check left ON. Nothing is stubbed or skipped
 * past to manufacture a pass, no guard is disabled, and the two halves of the
 * comparison are configured identically, which is what keeps the comparison
 * sound.
 *
 * WHEN IT IS STILL RED, this suite names the rung rather than reporting a vague
 * mismatch: which of parse, signer resolution, push and mirror the reconstruction
 * stopped at, the verdict every PRICE received, and how many received it.
 ********************************************************************/

'use strict';

const support = require('./support.test');
const { assert, histogram, describeHistogram, CAPABILITY_GAP_STATUS, SNAPSHOT_COMPARE_KEYS } = support;

function test06() {
    const { hubDb, liveNode, replayNode, venue, rounds, expectedPairs, targetHeight, livePrices, replayPrices, liveSnaps, replaySnaps, replayMirror, snapDiff, verdictDiff, feeVerdictDiff, liveIsolation, replayIsolation, liveVerdicts, replayVerdicts, wireVersions, venuePublicationBytes, feeCoordinates, feeStatuses, livePushQueue, replayPushQueue } = support.state;
        assert.ok(verdictDiff, 'the run produced no verdict comparison');
        assert.ok(verdictDiff.compared > 0, 'no action verdicts were compared at all');
        assert.strictEqual(verdictDiff.disagreed.length, 0,
            verdictDiff.disagreed.length + ' of ' + verdictDiff.compared + ' action(s) replayed to a different ' +
            'verdict: ' + verdictDiff.disagreed.slice(0, 15).map((d) =>
                d.action + ' @' + d.blockIndex + ' live "' + d.live + '" vs replay "' + d.replay + '"').join('; '));
        assert.strictEqual(verdictDiff.missing.length, 0,
            verdictDiff.missing.length + ' action(s) the live node recorded never appeared on the replay node: ' +
            verdictDiff.missing.slice(0, 10).map((m) => m.key).join(', '));
        assert.strictEqual(verdictDiff.extra.length, 0,
            verdictDiff.extra.length + ' action(s) exist on the replay node and not on the live one: ' +
            verdictDiff.extra.slice(0, 10).map((m) => m.key).join(', '));
    }

support.addTest('every action on the chain, fee-bearing or not, replays to the identical verdict', test06, __filename);
