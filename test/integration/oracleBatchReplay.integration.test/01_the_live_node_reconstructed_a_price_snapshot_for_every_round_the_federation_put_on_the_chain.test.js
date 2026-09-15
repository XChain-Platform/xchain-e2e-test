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

function testLiveReconstruction() {
    const { hubDb, liveNode, replayNode, venue, rounds, expectedPairs, targetHeight, livePrices, replayPrices, liveSnaps, replaySnaps, replayMirror, snapDiff, verdictDiff, feeVerdictDiff, liveIsolation, replayIsolation, liveVerdicts, replayVerdicts, wireVersions, venuePublicationBytes, feeCoordinates, feeStatuses, livePushQueue, replayPushQueue } = support.state;
        const expected = expectedPairs.length;
        if (liveSnaps.length === expected) return;

        // WHICH RUNG IS BLOCKING, named rather than described. A replayed chain can
        // only rebuild what a live chain accepted, and the path from a landed wire to
        // a mirrored snapshot has four rungs. Walking them in order turns "AT2 is
        // still red" into a statement the next session can read as progress or as a
        // regression, and each rung names the store the set it needs comes from,
        // because the node's two judges read two different ones: the INDEXER resolves
        // the Bitcoin-anchored set from its hub-mirrored capability_snapshots, and the
        // HUB resolves it by asking its Bitcoin capability oracle.
        const byStatus = histogram(livePrices, 'status');
        const gapCount = byStatus[CAPABILITY_GAP_STATUS] || 0;
        const valid    = byStatus['valid'] || 0;
        let rung;
        if (livePrices.length === 0) {
            rung = 'RUNG 1 (parse): the node indexed NO PRICE action at all for these rounds, so the ' +
                'wire never reached its parser. The publish landed in a block the node has, so this is a ' +
                'decode or action-registration failure, not a capability one';
        } else if (gapCount === livePrices.length) {
            rung = 'RUNG 2 (signer resolution): every one of the ' + livePrices.length + ' PRICE action(s) it ' +
                'indexed recorded "' + CAPABILITY_GAP_STATUS + '", so the `price` capability set resolved ' +
                'empty at the batch anchor and weighted quorum failed closed on S=0. This is the INDEXER\'s ' +
                'half of the resolution, which off Bitcoin reads the Bitcoin-anchored set from the ' +
                'capability_snapshots rows in the node\'s own HUB MIRROR database; the rig supplies them as ' +
                'setup (oracleBatchVenue, the price capability precondition section, plus ' +
                'oracleBatchReplay._registerPriceCapability). Check that the node registered as a target and ' +
                'that a venue in this process actually seeded a set, before suspecting the resolver itself';
        } else if (valid > 0) {
            const btc = liveNode.btcOracleEvidence() || {};
            rung = 'RUNG 3 (push): ' + valid + ' of the ' + livePrices.length + ' PRICE action(s) validated, ' +
                'so signer resolution is working ON CHAIN, but the hub still holds no snapshot for them. The ' +
                'push is the suspect: its outbox reads ' + JSON.stringify(livePushQueue) + '. An empty outbox ' +
                'with valid actions means the push was made and the hub refused it (PriceAggregator rejects on ' +
                'an unresolvable validator snapshot, a duplicate, or a pair/price bound); a non-empty one means ' +
                'delivery never succeeded. For "validator snapshot unavailable", look at the node\'s BITCOIN ' +
                'CAPABILITY ORACLE and not at the landing chain: the hub resolves the set at the batch\'s signed ' +
                'Bitcoin anchor less the reorg buffer, which for this run is block ' + btc.queriedHeight + ' of ' +
                btc.url + ', where the oracle answered ' + btc.priceSetAtBuried + ' validator(s). Zero there ' +
                'means the federation\'s stake is not visible at the BURIED height (a set that exists only at ' +
                'the anchor itself is not found); a null snapshot with a non-zero set means the hub was refused ' +
                'the read, which is either a missing per-capability MIN_STAKE or the hub\'s own coin check ' +
                'rejecting the endpoint';
        } else {
            rung = 'RUNG 2 (signer resolution), mixed: the ' + livePrices.length + ' PRICE action(s) it ' +
                'indexed recorded: ' + describeHistogram(byStatus);
        }
        assert.fail('the live node rebuilt ' + liveSnaps.length + ' of the ' + expected + ' price_snapshots the ' +
            'federation finalized over ' + rounds.length + ' round(s). ' + rung);
    }

support.addTest('the live node reconstructed a price snapshot for every round the federation put on the chain', testLiveReconstruction, __filename);
