'use strict';

const assert = require('assert');

/**
 * How many blocks deep an orphan at `height` would reach, given the chain's current tip.
 *
 * Pure so the window guard below can be unit-tested without a chain: `height` and `tip`
 * are both heights already read from a node, and this one line of arithmetic is the
 * whole defect class the AT3c case hit on the rail 2026-09-13 - a wait between reading
 * the lock's height and taking the orphan let the tip drift out from under it, and
 * nothing caught that until the guard fired mid-drive.
 *
 * @param {number} height  the height being orphaned
 * @param {number} tip     the chain's current height
 * @returns {number} depth; 1 when `height` IS the tip
 */
function orphanDepth(height, tip) {
    return Number(tip) - Number(height) + 1;
}

/**
 * Refuse an orphan deeper than a reorg-recovery window, naming the numbers rather than
 * just failing. Factored out of the reorg suite's own reorg helper so the one piece of
 * arithmetic - and the one guard built on it - has ONE unit-tested home; the message is
 * kept byte-identical to the inline copies the attestation reorg drills still carry
 * (xchain-utxo-tracker/src/chain/undo_blocks.js names the window itself), so a drive scanning
 * a log for "blocks deep" is never looking at two different sentences for the same fault.
 *
 * @param {number} height    the height being orphaned
 * @param {number} tip       the chain's current height
 * @param {number} maxDepth  the standing tracker's undo window (12 for BTC)
 * @returns {number} the depth, once it is shown to clear the window
 */
function assertShallowOrphan(height, tip, maxDepth) {
    const depth = orphanDepth(height, tip);
    assert.ok(depth <= maxDepth,
        'orphaning from ' + height + ' at tip ' + tip + ' is ' + depth + ' blocks deep, ' +
        'past the standing utxo-tracker\'s ' + maxDepth + '-block undo window; the ' +
        'tracker would halt and need a resync, and it is shared with every other rail lane');
    return depth;
}

/**
 * How many EMPTY blocks a competing chain needs before the node switches to it: every block
 * the invalidation disconnected, plus one to overtake, and never fewer than `atLeast`. A
 * competing chain no longer than the one it replaces leaves the orphan reachable and the
 * reorg unobserved.
 *
 * @param {number} height     the height being orphaned (the first disconnected block)
 * @param {number} tipBefore  the chain's height before the invalidation
 * @param {number} [atLeast]  a floor on the count, default 2
 */
function replacementBlockCount(height, tipBefore, atLeast) {
    return Math.max(Number(atLeast || 2), Number(tipBefore) - (Number(height) - 1) + 1);
}

/**
 * JSON for an assertion message, with BigInt columns rendered as digits.
 *
 * A hub `bridge_transfers` row read through the mariadb driver carries its BIGINT columns as
 * BigInt values, and `JSON.stringify` throws on those. An assertion whose MESSAGE quotes the
 * row would then die on the message instead of stating the finding, and the drive reads a
 * TypeError where the row it needed to see should have been.
 */
function describeRow(row) {
    return JSON.stringify(row, (key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

/**
 * The height a transaction confirmed at, read from the NODE, waiting out the confirmation
 * when it has not happened yet.
 *
 * The standing indexer's tip is not this number. The transaction helper returns once the node
 * merely knows the transaction and the tracker has had a bounded chance to see it confirmed,
 * so an indexer `block_index` read a moment later can still be the block BEFORE the one that
 * holds it. An orphan aimed at that height disconnects the right block only by accident.
 *
 * @param {{getTransaction: function, getBlock: function}} node  the coin node connector
 * @param {string} txid
 * @param {{timeoutMs?: number, everyMs?: number}} [opts]
 * @returns {Promise<number>} the confirming block's height
 */
async function confirmedHeight(node, txid, opts) {
    const o = opts || {};
    const timeoutMs = Number(o.timeoutMs || 120000);
    const everyMs = Number(o.everyMs || 1000);
    const deadline = Date.now() + timeoutMs;
    let tx = null;
    for (;;) {
        tx = await node.getTransaction(String(txid));
        if (tx && tx.blockhash) {
            const block = await node.getBlock(tx.blockhash);
            return Number(block.height);
        }
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, everyMs));
    }
    assert.fail('bridgeRailVenue: transaction ' + txid + ' did not confirm within ' +
        Math.round(timeoutMs / 1000) + 's' +
        (tx ? ' (the node holds it unconfirmed)' : ' (the node has never seen it)'));
}

/**
 * Whether an indexer's tip has reached `height`, as a reading a wait can act on and quote.
 *
 * A tip the RPC did not answer arrives as undefined or null, and a bare
 * `Number(tip) >= height` folds that into "still behind" (or, for null, into height 0), so a
 * wait built on the comparison alone runs its whole budget and then blames a slow indexer for
 * what was an unreadable one. The reading therefore keeps the parsed numbers apart: `have` is
 * null when the tip could not be read, and `behind` says how many blocks remain when it could.
 * A target that is not a block height is refused here rather than waited on.
 *
 * @param {*} indexerBlockIndex  what the indexer answered for its tip
 * @param {*} height             the height the caller needs parsed
 * @returns {{caughtUp: boolean, have: number|null, want: number, behind: number|null}}
 */
function indexerCaughtUp(indexerBlockIndex, height) {
    // `Number(null)` and `Number('')` are both 0, so a caller that lost its height would
    // otherwise wait for block 0 and come straight back; the absent cases are refused by name.
    const want = (height === null || height === undefined || height === '') ? NaN : Number(height);
    assert.ok(Number.isInteger(want) && want >= 0,
        'bridgeRailVenue: the height to catch up to must be a block height, got ' + String(height));
    const have = Number(indexerBlockIndex);
    if (indexerBlockIndex === null || indexerBlockIndex === undefined || !Number.isFinite(have)) {
        return { caughtUp: false, have: null, want: want, behind: null };
    }
    return { caughtUp: have >= want, have: have, want: want, behind: Math.max(0, want - have) };
}

/**
 * Orphan the block at `height` and replace it with a LONGER chain of EMPTY blocks.
 *
 * `invalidateblock` disconnects the block and everything above it, and the node returns the
 * transactions those blocks held to its mempool. A replacement chain mined with
 * `generatetoaddress` (the miner sidecar's lever) takes that mempool with it, so a
 * transaction "orphaned" that way is back in the chain one block later, at a new height and
 * with every effect intact, and a federation that then finalizes it is behaving correctly.
 * `generateblock` with an empty transaction list mines the coinbase alone, and the
 * transaction stays unconfirmed for as long as the caller keeps miners away from the mempool.
 *
 * When `lockTx` is given, the node is asked afterwards whether that transaction is still
 * confirmed, so a replacement chain that carries it fails here, naming the block, rather than
 * as a finalized row three assertions later.
 *
 * @param {object} node  the coin node connector: getBlockCount, getBlockHash, invalidateBlock,
 *                       generateBlock, getTransaction
 * @param {{height: number, coinbase: string, atLeast?: number, lockTx?: string}} opts
 * @returns {Promise<{hash: string, tipBefore: number, tipAfter: number, mined: number}>}
 */
async function orphanWithEmptyBlocks(node, opts) {
    const o = opts || {};
    const height = Number(o.height);
    assert.ok(Number.isFinite(height) && height > 0, 'orphanWithEmptyBlocks: needs a height, got ' + o.height);
    assert.ok(o.coinbase, 'orphanWithEmptyBlocks: needs a coinbase address for the empty blocks');
    const tipBefore = Number(await node.getBlockCount());
    const hash = await node.getBlockHash(height);
    assert.ok(hash, 'the node could not name the block at height ' + height + ' to orphan');
    await node.invalidateBlock(hash);
    const rolled = Number(await node.getBlockCount());
    assert.strictEqual(rolled, height - 1,
        'the node sits at ' + rolled + ' after invalidating block ' + height);
    const mined = replacementBlockCount(height, tipBefore, o.atLeast);
    for (let i = 0; i < mined; i++) await node.generateBlock(String(o.coinbase), []);
    const tipAfter = Number(await node.getBlockCount());
    assert.ok(tipAfter > tipBefore,
        'the competing chain reached ' + tipAfter + ', which does not overtake ' + tipBefore);
    assert.notStrictEqual(await node.getBlockHash(height), hash,
        'block ' + height + ' still has its original hash, so nothing actually reorged');
    if (o.lockTx) {
        const tx = await node.getTransaction(String(o.lockTx));
        assert.ok(!(tx && tx.blockhash),
            'transaction ' + o.lockTx + ' is still confirmed, in block ' + (tx && tx.blockhash) +
            ', after the orphan of block ' + height + ': the replacement chain carried it, so ' +
            'nothing about it is orphaned');
    }
    return { hash: hash, tipBefore: tipBefore, tipAfter: tipAfter, mined: mined };
}

// Slack past the relay margin for a destination to APPLY a finalized leg: the destination's
// block cadence (one block past effective_time is the earliest any indexer can apply, and
// regtest DOGE blocks arrive tens of seconds apart), block_time trailing the wall clock, and
// the caller's own poll interval.
const DEFAULT_APPLY_SLACK_MS = 180000;

/**
 * How long a drive must be prepared to wait for a finalized leg to APPLY on its destination.
 *
 * The leader stamps `effective_time` at its own clock plus the destination chain's relay
 * margin, and the destination indexer applies the leg at its first block whose block_time
 * reaches that stamp. Nothing can apply before the margin has run, so a wait EQUAL to the
 * margin expires at the first second the leg is even eligible, and the block cadence alone
 * turns it into a timeout. The budget is the margin plus `DEFAULT_APPLY_SLACK_MS`.
 *
 * @param {number} relayMarginS  the producer's margin for the destination chain, in seconds
 *                               (`hubRelayMarginFloorS` reads the hub's own)
 * @param {{slackMs?: number}} [opts]
 * @returns {number} milliseconds
 */
function destinationApplyBudgetMs(relayMarginS, opts) {
    const marginS = Number(relayMarginS);
    assert.ok(Number.isFinite(marginS) && marginS > 0,
        'destinationApplyBudgetMs: the relay margin must be a positive number of seconds, got ' + relayMarginS);
    const o = opts || {};
    const slackMs = o.slackMs === undefined ? DEFAULT_APPLY_SLACK_MS : Number(o.slackMs);
    assert.ok(Number.isFinite(slackMs) && slackMs >= 0,
        'destinationApplyBudgetMs: slack must be a non-negative number of milliseconds, got ' + o.slackMs);
    return marginS * 1000 + slackMs;
}

/**
 * The hub's own producer margin for a chain, in seconds, read from the hub's module so the
 * drive's budget moves with the value the venue hubs actually stamp. Resolved at call time
 * rather than at load so the pure layer stays loadable without a hub checkout beside it.
 */
function hubRelayMarginFloorS(chain) {
    const relay = require('../../../../xchain-hub/src/lib/relay_margin.js');
    return Number(relay.relayMarginFloorS(String(chain).toUpperCase()));
}

module.exports = { orphanDepth, assertShallowOrphan, replacementBlockCount, describeRow, confirmedHeight, indexerCaughtUp, orphanWithEmptyBlocks, destinationApplyBudgetMs, hubRelayMarginFloorS, DEFAULT_APPLY_SLACK_MS };
