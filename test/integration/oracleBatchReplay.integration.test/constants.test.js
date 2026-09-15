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

// Four validators, three rounds: the same shape the venue's own smoke drill
// uses, so a failure here is about replay and not about the publish rail.
const VALIDATORS = 4;
const ROUNDS     = 3;

// The one verdict a well-formed PRICE can legitimately receive on a non-BTC
// chain today besides an accept. Named as a constant so the failure message can
// quote it verbatim.
const CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// The price-sync grace BOTH nodes run at, in seconds.
//
// MEASURED, and the reason this is not left at the frozen constant: at
// HUB_SYNC_WATERMARK_GRACE_S.price = 4800 a chain-only node replays the whole
// history in minutes and then stops at the first block younger than 4800
// seconds, deferring it once a minute until the hub's wall clock is 80 minutes
// past that block's time. Both nodes here read a freshly published block, so at
// the frozen value neither could reach the target inside any sensible budget.
// 600 is the value the platform ran on until this spec moved it, so it is a real
// barrier with real mirror-coverage semantics rather than a barrier switched off.
// It is applied IDENTICALLY to both nodes, which is what keeps the comparison
// sound; the indexer honours the override on regtest only. The drill that must
// exercise the barrier at 4800 is AT5, not this one.
const PRICE_GRACE_S = 600;

// Batch window knobs, set on the PROCESS before the venue builds its publishers
// (OraclePublisher reads them in its constructor) and restored afterwards.
//
// WHY A ONE-ROUND WINDOW. PRICE v0 has landed in the hub, PRICE_BATCH_ACTIVATION
// is genesis on regtest, and `onRoundFinalized` now buffers every finalized round
// instead of publishing it. The publish venue drives rounds one at a time and
// waits for each one to reach the chain, so at the shipped six-round window it
// waits forever and throws: the first five rounds of a window produce no
// transaction at all. A window of one makes every finalized round its own batch,
// which still puts a REAL `PRICE|0|` wire on the chain (the thing AT2 has to
// replay) while keeping the venue's one-round-at-a-time contract intact. Window
// COMPOSITION is AT1's question, not this suite's.
const BATCH_WINDOW_ROUNDS = 1;
// The window's post-close grace, shipped at 300000ms. Nothing arrives late in a
// one-round window, so the whole 5 minutes would be dead time per round.
const BATCH_GRACE_MS = 3000;

function histogram(rows, field) {
    const out = {};
    for (const r of rows) out[String(r[field])] = (out[String(r[field])] || 0) + 1;
    return out;
}

function describeHistogram(h) {
    return Object.keys(h).map((k) => h[k] + ' x "' + k + '"').join(', ') || 'nothing';
}

module.exports = {
    VALIDATORS, ROUNDS, CAPABILITY_GAP_STATUS, PRICE_GRACE_S,
    BATCH_WINDOW_ROUNDS, BATCH_GRACE_MS, histogram, describeHistogram
};
