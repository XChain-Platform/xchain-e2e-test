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

function feeCoverageEvidence() {
    const { liveSnaps, liveVerdicts, feeStatuses } = support.state;
    // AGREEING ON NOTHING IS NOT THE PROPERTY. Two nodes that both failed every
    // fee for want of a price agree perfectly and demonstrate nothing, and
    // getLatestPrice has nothing to value a fee against on EITHER node whenever
    // the reconstruction does not COVER that fee. The identity above only means
    // something once the fees were actually priced, so say so rather than bank a
    // vacuous green. This guard is deliberate and stays whatever the run does.
    const pricelessStatuses = Object.keys(feeStatuses(liveVerdicts)).filter((s) => /no current oracle price/.test(s));
    const priceless = pricelessStatuses.reduce((n, s) => n + feeStatuses(liveVerdicts)[s], 0);
    // WHICH KIND OF VACUOUS, because the two have different fixes and a message
    // that names the wrong one costs the next session a whole run. Rebuilding
    // nothing is a reconstruction failure. Rebuilding something the fees cannot
    // be valued against is a REACH failure, and the reach is bounded by time
    // rather than by which pairs the federation chose.
    //
    // HOW A FEE REACHES A PRICE, stated exactly, because the obvious remedies do
    // not work and each costs a run to disprove. `getLatestPrice` on a
    // non-reference chain takes the newest snapshot FOR THAT PAIR whose
    // `block_timestamp <= the action's own block time`, then rejects it when
    // `blockTime - block_timestamp` exceeds ORACLE_MAX_PRICE_AGE (1800s). So a
    // fee is priced only by a round for its own pair, timestamped inside a
    // 30-minute window ending at that action's block time.
    //
    // MEASURED on the standing regtest chains 2026-08-27: the fee-bearing
    // actions want <COIN>/USD for the LANDING coin, this venue publishes its own
    // pairs at `anchorTimeBase + round * 600`, and the two do not meet on either
    // axis. Even matching the pair leaves the window: DOGE carries 235
    // fee-bearing actions spread over 2,968,459 seconds of block time (LTC 1541
    // over a comparable span), so blanketing them at 1800-second spacing needs on
    // the order of 1650 finalized-and-published rounds against the 3 this drill
    // publishes per run.
    //
    // So this is NOT closable by publishing the landing coin's pair, and NOT
    // closable by driving fresh fee-bearing actions after the rounds land: those
    // ADD priced coordinates, they do not reach back into the historical ones
    // this count is made of. Publishing the landing coin's own pair is also the
    // one thing the venue deliberately refuses, because the fee output of its own
    // publish re-seeds that pair underneath it.
    const rebuiltPairs = [...new Set(liveSnaps.map((r) => r.coin_pair))];
    const roundTimestamps = liveSnaps.map((r) => Number(r.block_timestamp));
    const roundTsRange = roundTimestamps.length > 0
        ? Math.min(...roundTimestamps) + '..' + Math.max(...roundTimestamps) : 'none';
    const cause = liveSnaps.length === 0
        ? 'NOTHING was reconstructed on either node, so this is the reconstruction failing one step upstream'
        : 'the reconstruction WORKED (' + liveSnaps.length + ' snapshot(s) on ' + rebuiltPairs.join(', ') +
          ', round timestamps ' + roundTsRange + ') but cannot REACH these fees, which want ' +
          pricelessStatuses.join(' / ') + '. No round was published for that pair, and matching the pair ' +
          'alone would not be enough: a fee is priced only by a round timestamped within 1800s at or ' +
          'before its own block time, and this chain\'s fee-bearing actions are spread over weeks of ' +
          'block time. Closing it needs a landing chain carrying no fee history older than the rounds, ' +
          'or an explicit decision to scope this guard to the coordinates the reconstruction covers. ' +
          'Neither is a change to this assertion';
    return { priceless, cause };
}

function test05() {
    const { hubDb, liveNode, replayNode, venue, rounds, expectedPairs, targetHeight, livePrices, replayPrices, liveSnaps, replaySnaps, replayMirror, snapDiff, verdictDiff, feeVerdictDiff, liveIsolation, replayIsolation, liveVerdicts, replayVerdicts, wireVersions, venuePublicationBytes, feeCoordinates, feeStatuses, livePushQueue, replayPushQueue } = support.state;
        assert.ok(feeVerdictDiff, 'the run produced no fee verdict comparison');
        assert.ok(feeVerdictDiff.compared > 0,
            'the standing chain records no fee-bearing action at or below block ' + targetHeight +
            ' (' + feeCoordinates.size + ' coordinate(s) found), so nothing was compared and this assertion ' +
            'proved nothing');
        assert.strictEqual(feeVerdictDiff.disagreed.length, 0,
            feeVerdictDiff.disagreed.length + ' of ' + feeVerdictDiff.compared + ' fee-bearing action(s) reached a ' +
            'DIFFERENT verdict on a node that replayed the chain than on the node that was live. Fee validation is ' +
            'supposed to be chain-time and not arrival-time (getLatestPrice selects on block_timestamp <= blockTime ' +
            'and applies staleness as blockTime - snapshot.block_timestamp, both chain-derived), so a node that ' +
            'waits must reach the verdict a node that was live reached. Divergences: ' +
            feeVerdictDiff.disagreed.slice(0, 15).map((d) =>
                d.action + ' @' + d.blockIndex + ' live "' + d.live + '" vs replay "' + d.replay + '"').join('; '));
        assert.strictEqual(feeVerdictDiff.missing.length, 0,
            feeVerdictDiff.missing.length + ' fee-bearing action(s) the live node recorded are absent from the ' +
            'replay node entirely, which is a bigger divergence than a differing verdict: ' +
            feeVerdictDiff.missing.slice(0, 10).map((m) => m.key).join(', '));

        const { priceless, cause } = feeCoverageEvidence();
        assert.strictEqual(priceless, 0,
            priceless + ' of the ' + feeVerdictDiff.compared + ' fee-bearing action(s) reached the SAME verdict on ' +
            'both nodes only because neither could price the fee at all ("no current oracle price for ...", the ' +
            'staleness guard with no usable price behind it). ' + cause + '. The agreement is real but vacuous, ' +
            'and this assertion is what keeps it from reading as proof that fee validation is chain-time rather ' +
            'than arrival-time.');
    }

support.addTest('every fee-bearing action on the chain replays to the identical validity verdict', test05, __filename);
