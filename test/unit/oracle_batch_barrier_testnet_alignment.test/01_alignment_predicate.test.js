'use strict';

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
 **********************************************************************
 * Part of test/unit/oracle_batch_barrier_testnet_alignment.test.js
 ********************************************************************/

const assert = require('assert');
const { drill, REAL_PAIRS, DERIVED_ROWS, WINDOW, ORDER_666, indexOf } = require('./helpers/fixtures.js');

function registerFixtureIsTheDefect() {

    it('has all 20 pairs disagreeing on tx_index while agreeing on tx_hash', function () {
        let sameHash = 0;
        let sameTxIndex = 0;
        for (const p of REAL_PAIRS) {
            if (p.node.txHash === p.origin.tx_hash) sameHash++;
            if (p.node.txIndex === Number(p.origin.tx_index)) sameTxIndex++;
        }
        assert.strictEqual(sameHash, 20, 'the chain gives both nodes the same hash for all 20');
        assert.strictEqual(sameTxIndex, 0,
            'not one of the 20 shares a tx_index, which is why run 5 compared nothing');
    });

    it('carries the ORDER the node numbered 263 and origin numbered 666', function () {
        assert.ok(ORDER_666, 'the measured pair must be in the fixture');
        assert.strictEqual(ORDER_666.node.txIndex, 263);
        assert.strictEqual(ORDER_666.node.height, 67882087);
    });
}

function registerAlignOnTxHashPredicate() {

    it('aligns all 20 real pairs, which the tx_index comparison aligned none of', function () {
        const ix = indexOf(WINDOW);
        const refused = [];
        let aligned = 0;
        for (const p of REAL_PAIRS) {
            const m = drill.alignOnTxHash(p.node, ix, p.node.height);
            if (m.aligned) {
                aligned++;
                assert.strictEqual(m.origin.actionIndex, Number(p.origin.action_index),
                    'alignment must hand back ORIGIN\'s action index, not the node\'s');
            } else {
                refused.push({ height: p.node.height, action: p.node.action, reason: m.reason });
            }
        }
        assert.deepStrictEqual(refused, [], 'no real pair may be refused');
        assert.strictEqual(aligned, 20);
    });

    it('aligns the same tx_hash when the two tx_index values differ', function () {
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf(WINDOW), ORDER_666.node.height);
        assert.strictEqual(m.aligned, true, '263 against 666 on one hash is one action');
        assert.strictEqual(m.reason, 'aligned');
        assert.strictEqual(m.origin.txIndex, 666);
        assert.notStrictEqual(m.origin.txIndex, ORDER_666.node.txIndex);
    });

    registerAlignOnTxHashRefusals();
}

function registerAlignOnTxHashRefusals() {

    it('refuses a different tx_hash inside a window that covers the block', function () {
        const ix = indexOf(WINDOW);
        // A hash of the right shape that this window does not carry. The height
        // is well inside the window, so the refusal is about the coordinate and
        // not about how much of the chain was read.
        const stranger = Object.assign({}, ORDER_666.node,
            { txHash: '0'.repeat(63) + '1' });
        const m = drill.alignOnTxHash(stranger, ix, stranger.height);
        assert.strictEqual(m.aligned, false);
        assert.strictEqual(m.reason, 'origin-has-no-action-on-this-tx');
        assert.strictEqual(m.origin, null);
    });

    it('refuses one real pair\'s node action against another pair\'s hash', function () {
        const a = REAL_PAIRS[0];
        const b = REAL_PAIRS[1];
        // b's transaction, a's action: the same block, the same window, a
        // different transaction, and therefore not a pair.
        const ix = indexOf([b.origin]);
        const m = drill.alignOnTxHash(a.node, ix, b.node.height);
        assert.strictEqual(m.aligned, false);
        assert.notStrictEqual(m.reason, 'aligned');
    });

    it('is case-insensitive about the hash, which is not a chain fact', function () {
        const upper = Object.assign({}, ORDER_666.origin,
            { tx_hash: ORDER_666.origin.tx_hash.toUpperCase() });
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf([upper]), ORDER_666.node.height);
        assert.strictEqual(m.aligned, true);
    });
}

function registerNullTxIndex() {

    it('does not block alignment: the counter is never consulted', function () {
        // Origin's row for the ORDER, with its tx_index absent. The hash still
        // names the transaction, so the pair is still the same action.
        const noCounter = Object.assign({}, ORDER_666.origin, { tx_index: null });
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf([noCounter]), ORDER_666.node.height);
        assert.strictEqual(m.aligned, true, 'a missing counter is not a missing coordinate');
        assert.strictEqual(m.origin.txIndex, null, 'and it is recorded as null, never coerced');
    });

    it('is not a wildcard: a null tx_index on ANOTHER transaction still refuses', function () {
        // This is exactly what the replaced predicate got wrong: it read
        // `o.txIndex === null || o.txIndex === a.txIndex` and so aligned any
        // action whose counter happened to be absent.
        const other = Object.assign({}, REAL_PAIRS[0].origin,
            { tx_index: null, block_index: String(ORDER_666.node.height) });
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf([other]), ORDER_666.node.height);
        assert.strictEqual(m.aligned, false);
        assert.strictEqual(m.reason, 'origin-has-no-action-on-this-tx');
    });

    it('keeps origin\'s real derived actions out of the index entirely', function () {
        // ORDER_MATCH and COINPAY_EXPIRE carry no transaction, so there is no
        // coordinate to key them on and they can never be matched by accident.
        const ix = indexOf(DERIVED_ROWS);
        assert.strictEqual(ix.rowCount, 2, 'they are counted, so the window span stays honest');
        assert.strictEqual(ix.hashCount, 0, 'but nothing is keyed on a null hash');
    });

    it('refuses a NODE action that carries no tx_hash, and says which side failed', function () {
        const derived = { height: 67882087, actionIndex: 999, action: 'ORDER_MATCH', txIndex: null, txVout: null, txHash: null };
        const m = drill.alignOnTxHash(derived, indexOf(WINDOW), derived.height);
        assert.strictEqual(m.aligned, false);
        assert.strictEqual(m.reason, 'node-action-has-no-tx-hash');
    });
}

function registerNamedRefusals() {

    it('separates a short window from a chain that holds nothing', function () {
        const ix = indexOf(WINDOW);
        const older = drill.alignOnTxHash(
            Object.assign({}, ORDER_666.node, { txHash: '0'.repeat(64) }), ix, ix.oldestBlock - 1);
        assert.strictEqual(older.reason, 'origin-window-does-not-cover-block');
        const newer = drill.alignOnTxHash(
            Object.assign({}, ORDER_666.node, { txHash: '0'.repeat(64) }), ix, ix.newestBlock + 1);
        assert.strictEqual(newer.reason, 'origin-has-not-reached-this-block');
    });

    it('names a transaction the two sides filed under different heights', function () {
        const moved = Object.assign({}, ORDER_666.origin, { block_index: String(ORDER_666.node.height + 3) });
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf([moved]), ORDER_666.node.height);
        assert.strictEqual(m.aligned, false);
        assert.strictEqual(m.reason, 'origin-filed-this-tx-in-another-block');
        assert.deepStrictEqual(m.originBlocks, [ORDER_666.node.height + 3]);
    });

    it('refuses when origin has no action of that kind on the transaction', function () {
        const other = Object.assign({}, ORDER_666.origin, { action: 'ORDER_CANCEL' });
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf([other]), ORDER_666.node.height);
        assert.strictEqual(m.aligned, false);
        assert.strictEqual(m.reason, 'origin-has-no-such-action-on-this-tx');
        assert.deepStrictEqual(m.originActionNames, ['ORDER_CANCEL']);
    });

    it('refuses an empty window rather than treating it as absence from the chain', function () {
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf([]), ORDER_666.node.height);
        assert.strictEqual(m.aligned, false);
        assert.strictEqual(m.reason, 'origin-actions-unavailable');
    });
}

function registerMultiActionTransaction() {

    const hash = ORDER_666.origin.tx_hash;
    const height = ORDER_666.node.height;

    it('picks the action of the right kind', function () {
        const rows = [
            Object.assign({}, ORDER_666.origin, { action: 'ORDER', action_index: '665' }),
            Object.assign({}, ORDER_666.origin, { action: 'ATTEST', action_index: '667' })
        ];
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf(rows), height);
        assert.strictEqual(m.aligned, true);
        assert.strictEqual(m.origin.actionIndex, 665);
    });

    it('falls to tx_vout when the kind does not discriminate', function () {
        const rows = [
            Object.assign({}, ORDER_666.origin, { action_index: '665', tx_vout: '0' }),
            Object.assign({}, ORDER_666.origin, { action_index: '667', tx_vout: '1' })
        ];
        const m = drill.alignOnTxHash(Object.assign({}, ORDER_666.node, { txVout: 1 }), indexOf(rows), height);
        assert.strictEqual(m.aligned, true);
        assert.strictEqual(m.origin.actionIndex, 667);
    });

    it('refuses rather than guessing when neither discriminates', function () {
        const rows = [
            Object.assign({}, ORDER_666.origin, { action_index: '665' }),
            Object.assign({}, ORDER_666.origin, { action_index: '667' })
        ];
        const m = drill.alignOnTxHash(ORDER_666.node, indexOf(rows), height);
        assert.strictEqual(m.aligned, false);
        assert.strictEqual(m.reason, 'ambiguous-tx-hash-candidates');
        assert.deepStrictEqual(m.candidates, [665, 667]);
        assert.ok(hash, 'the ambiguity is on one hash');
    });
}

function registerOriginActionIndexWindow() {

    it('reports the block span it actually covers', function () {
        const ix = indexOf(WINDOW);
        assert.strictEqual(ix.oldestBlock, 67881904);
        assert.strictEqual(ix.newestBlock, 67882168);
        assert.strictEqual(ix.rowCount, WINDOW.length);
    });

    it('coerces the explorer\'s strings, which never compare equal to a number', function () {
        const ix = indexOf([ORDER_666.origin]);
        const row = ix.byHash.get(ORDER_666.origin.tx_hash)[0];
        assert.strictEqual(row.actionIndex, 665);
        assert.strictEqual(row.blockIndex, 67882087);
        assert.strictEqual(typeof row.actionIndex, 'number');
    });
}


describe('AT5 barrier drill: aligning two nodes on the chain\'s own coordinate (row 55)', function () {
    describe('the fixture is the defect', registerFixtureIsTheDefect);
    describe('alignOnTxHash: the predicate', registerAlignOnTxHashPredicate);
    describe('a null tx_index, deliberately', registerNullTxIndex);
    describe('refusals name the cause instead of reporting a bare false', registerNamedRefusals);
    describe('one transaction carrying more than one action', registerMultiActionTransaction);
    describe('buildOriginActionIndex: the window', registerOriginActionIndexWindow);
});
