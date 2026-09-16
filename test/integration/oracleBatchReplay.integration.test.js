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

// Two whole nodes, two full chain replays and a live publish rail. The budget
// is per-suite; every wait inside is a poll that returns the moment it can.
support.addTest('both nodes really were isolated: an empty hub, no validators, no peers', testIsolation, __filename);

require('./oracleBatchReplay.integration.test/01_the_live_node_reconstructed_a_price_snapshot_for_every_round_the_federation_put_on_the_chain.test');
require('./oracleBatchReplay.integration.test/02_the_replay_node_rebuilt_the_same_snapshots_the_live_node_did.test');
require('./oracleBatchReplay.integration.test/03_the_replay_nodes_own_indexer_can_read_what_its_hub_rebuilt.test');
require('./oracleBatchReplay.integration.test/04_every_fee_bearing_action_on_the_chain_replays_to_the_identical_validity_verdict.test');
require('./oracleBatchReplay.integration.test/05_every_action_on_the_chain_fee_bearing_or_not_replays_to_the_identical_verdict.test');
