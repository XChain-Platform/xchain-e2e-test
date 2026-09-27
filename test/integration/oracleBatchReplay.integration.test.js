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

const support = require('./oracleBatchReplay.integration.test/support.test');
const { assert } = support;

function testIsolation() {
    const { liveNode, replayNode, liveIsolation, replayIsolation } = support.state;
        for (const [name, ev] of [['live', liveIsolation], ['replay', replayIsolation]]) {
            assert.ok(ev, name + ' node produced no isolation evidence');
            assert.strictEqual(ev.p2pValidatorAddrSet, false,
                name + ' node was given a P2P validator address, so its hub would run consensus and an oracle round of ' +
                'its own; every snapshot it held would then be suspect');
            assert.strictEqual(ev.seedNodesSet, false, name + ' node was given seed nodes, so its hub had peers to learn from');
            assert.strictEqual(ev.hubSnapshotsAtBoot, 0,
                name + ' node\'s hub already held ' + ev.hubSnapshotsAtBoot + ' price snapshot(s) before a single block ' +
                'reached it; nothing it reconstructs afterwards can be attributed to the chain');
            assert.strictEqual(ev.hubValidators, 0,
                name + ' node\'s hub already knew ' + ev.hubValidators + ' validator(s); it was not built from nothing');
        }
    }

function testLiveReconstruction() {
    const { liveNode, rounds, expectedPairs, livePrices, liveSnaps, livePushQueue } = support.state;
    const expected = expectedPairs.length;
    if (liveSnaps.length === expected) return;

    const byStatus = support.histogram(livePrices, 'status');
    const gapCount = byStatus[support.CAPABILITY_GAP_STATUS] || 0;
    const valid = byStatus.valid || 0;
    let rung;
    if (livePrices.length === 0) {
        rung = 'RUNG 1 (parse): the node indexed NO PRICE action at all for these rounds, so the ' +
            'wire never reached its parser. The publish landed in a block the node has, so this is a ' +
            'decode or action-registration failure, not a capability one';
    } else if (gapCount === livePrices.length) {
        rung = 'RUNG 2 (signer resolution): every one of the ' + livePrices.length + ' PRICE action(s) it ' +
            'indexed recorded "' + support.CAPABILITY_GAP_STATUS + '", so the `price` capability set resolved ' +
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
            'rejecting the endpoint. For "insufficient signer stake (0 verified signers)" the suspect is ' +
            'WHICH resolver: under STAKE_WEIGHTED_QUORUM the hub gates on the SOURCE-KEYED weight read, ' +
            'which answered ' + btc.priceWeightSetAtBuried + ' validator(s) at that same block against the ' +
            'count read\'s ' + btc.priceSetAtBuried + '. A count set the whole federation wide and a weight ' +
            'set of nobody is not a hub defect and not a replay failure: the hub is failing closed on a ' +
            'stake it cannot sum, and the suspect is the SEED. _stakeWeightsSql inner-joins ' +
            'index_addresses on the stake\'s source_id and then drops any source whose aggregate is under ' +
            'the `price` MIN_STAKE, so check that the per-validator source rows ' +
            'oracleBatchVenue.applyPriceCapabilityStakes mints actually landed, and that the seeded ' +
            'per-source amount still clears that floor';
    } else {
        rung = 'RUNG 2 (signer resolution), mixed: the ' + livePrices.length + ' PRICE action(s) it ' +
            'indexed recorded: ' + support.describeHistogram(byStatus);
    }
    assert.fail('the live node rebuilt ' + liveSnaps.length + ' of the ' + expected + ' price_snapshots the ' +
        'federation finalized over ' + rounds.length + ' round(s). ' + rung);
}

// Two whole nodes, two full chain replays and a live publish rail. The budget
// is per-suite; every wait inside is a poll that returns the moment it can.
support.addTest('both nodes really were isolated: an empty hub, no validators, no peers', testIsolation, __filename);
support.addTest('the live node reconstructed a price snapshot for every round the federation put on the chain',
    testLiveReconstruction, __filename);

require('./oracleBatchReplay.integration.test/02_the_replay_node_rebuilt_the_same_snapshots_the_live_node_did.test');
require('./oracleBatchReplay.integration.test/03_the_replay_nodes_own_indexer_can_read_what_its_hub_rebuilt.test');
require('./oracleBatchReplay.integration.test/04_every_fee_bearing_action_on_the_chain_replays_to_the_identical_validity_verdict.test');
require('./oracleBatchReplay.integration.test/05_every_action_on_the_chain_fee_bearing_or_not_replays_to_the_identical_verdict.test');
