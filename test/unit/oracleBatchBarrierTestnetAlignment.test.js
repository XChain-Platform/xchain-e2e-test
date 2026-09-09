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
 *
 **********************************************************************
 * The AT5 drill's action alignment (spec row 55), pinned without a chain.
 *
 * WHAT WENT WRONG. The drill compared verdicts by looking origin's action up by
 * THE NODE'S OWN `action_index` and then "checking the coordinate" with
 * `tx_index`. Both are per-node counters, assigned as each node parses from
 * wherever it started, so a chain-only node that begins mid-chain is misaligned
 * from origin by construction. Run 5 (2026-09-09) graded 290 blocks carrying 20
 * actions and reported `verdictsCompared: 0`: every single row came back
 * `coordinateAligned: false`, with nothing in the result saying why.
 *
 * THE FIXTURE IS THAT RUN'S OWN 20 ACTIONS. `REAL_PAIRS` below is the node side
 * as the AT5 node's own database held it, beside the row the public explorer
 * returns for the same transaction, both verbatim (origin's numbers arrive as
 * STRINGS, and they are left as strings here because that is what the code has
 * to cope with). Look at the ORDER at height 67882087: the node calls it
 * `tx_index` 263 and origin calls it 666. All 20 pairs disagree on the counter
 * and all 20 agree on the hash, which is the whole of the defect and the whole
 * of the fix.
 *
 * WHAT THIS FILE REFUSES TO LET HAPPEN. Not just "the predicate returns true":
 * the last block drives the drill's own `observeBlock` and asserts that origin's
 * verdict was fetched with ORIGIN's action index (650, 654, 665) and never with
 * the node's (245, 249, 260). A predicate that is correct but wired to the wrong
 * index would otherwise pass, and cost another four-hour run to find.
 *
 *   npx mocha --no-config test/unit/oracleBatchBarrierTestnetAlignment.test.js
 ********************************************************************/

const assert = require('assert');

const drill = require('../drills/oracleBatchBarrierTestnet.drill.js');

// ---------------------------------------------------------------------------
// Run 5's own 20 actions, node side and origin side
// ---------------------------------------------------------------------------

// node: rows of the AT5 node's `actions` table joined to index_actions and
//       index_transactions, as blockActions() now reads them.
// origin: the row https://explorer.xchain.io/TDOGE/api/actions?limit=200 returns
//       for that transaction, fields verbatim, numbers still strings.
const REAL_PAIRS = [
    { node: { height: 67881904, actionIndex: 245, action: "PRICE", txIndex: 246, txVout: 0, txHash: "09f65851dc9678b9504f2b458a1f10731b7907d677956a88833898927210b19a" },
      origin: { action: "PRICE", action_format: 0, action_index: "650", block_index: "67881904", tx_hash: "09f65851dc9678b9504f2b458a1f10731b7907d677956a88833898927210b19a", tx_index: "649" } },
    { node: { height: 67881915, actionIndex: 246, action: "PRICE", txIndex: 248, txVout: 0, txHash: "2c2780c5044bb78d1544212eec67b382ce015b6a2678b3f0f1a19f7bbc566baa" },
      origin: { action: "PRICE", action_format: 0, action_index: "651", block_index: "67881915", tx_hash: "2c2780c5044bb78d1544212eec67b382ce015b6a2678b3f0f1a19f7bbc566baa", tx_index: "651" } },
    { node: { height: 67881937, actionIndex: 247, action: "PRICE", txIndex: 250, txVout: 0, txHash: "69c2cb00983c944e0575e6305db5e3d9466e3b1554e69d42d01561e29851bc77" },
      origin: { action: "PRICE", action_format: 0, action_index: "652", block_index: "67881937", tx_hash: "69c2cb00983c944e0575e6305db5e3d9466e3b1554e69d42d01561e29851bc77", tx_index: "653" } },
    { node: { height: 67881944, actionIndex: 248, action: "PRICE", txIndex: 251, txVout: 0, txHash: "8f475e3b577d984a5f7b9c40389e41b559f3e0a21428082d8683a7ccf820bd0b" },
      origin: { action: "PRICE", action_format: 0, action_index: "653", block_index: "67881944", tx_hash: "8f475e3b577d984a5f7b9c40389e41b559f3e0a21428082d8683a7ccf820bd0b", tx_index: "654" } },
    { node: { height: 67881946, actionIndex: 249, action: "ATTEST", txIndex: 252, txVout: 0, txHash: "489f2b7a08a5b3bb7ad6f2a4918b18df9af06553f3913d767c712b00cf39d135" },
      origin: { action: "ATTEST", action_format: 5, action_index: "654", block_index: "67881946", tx_hash: "489f2b7a08a5b3bb7ad6f2a4918b18df9af06553f3913d767c712b00cf39d135", tx_index: "655" } },
    { node: { height: 67881946, actionIndex: 250, action: "ATTEST", txIndex: 253, txVout: 0, txHash: "aaeadf60d89854252a3d2bb7536b7c53e9aa3bda89484b71ede95c141e75bd6c" },
      origin: { action: "ATTEST", action_format: 5, action_index: "655", block_index: "67881946", tx_hash: "aaeadf60d89854252a3d2bb7536b7c53e9aa3bda89484b71ede95c141e75bd6c", tx_index: "656" } },
    { node: { height: 67881946, actionIndex: 251, action: "ATTEST", txIndex: 254, txVout: 0, txHash: "81c55eae91486760b27973eeafba36e64bcb517dd4f8778c33d6a9d3d9ab2a7a" },
      origin: { action: "ATTEST", action_format: 5, action_index: "656", block_index: "67881946", tx_hash: "81c55eae91486760b27973eeafba36e64bcb517dd4f8778c33d6a9d3d9ab2a7a", tx_index: "657" } },
    { node: { height: 67881985, actionIndex: 252, action: "PRICE", txIndex: 255, txVout: 0, txHash: "ec9f7cf7497d7365cdc815e4d8c8012cbeefe35936b3f2e4c80c898931cb173f" },
      origin: { action: "PRICE", action_format: 0, action_index: "657", block_index: "67881985", tx_hash: "ec9f7cf7497d7365cdc815e4d8c8012cbeefe35936b3f2e4c80c898931cb173f", tx_index: "658" } },
    { node: { height: 67881996, actionIndex: 253, action: "PRICE", txIndex: 256, txVout: 0, txHash: "f93ca56a0ebd55f6ee4ca5481c65166cf29f3e2ee1968d29a7b0934b47716478" },
      origin: { action: "PRICE", action_format: 0, action_index: "658", block_index: "67881996", tx_hash: "f93ca56a0ebd55f6ee4ca5481c65166cf29f3e2ee1968d29a7b0934b47716478", tx_index: "659" } },
    { node: { height: 67882002, actionIndex: 254, action: "ANCHOR", txIndex: 257, txVout: 0, txHash: "1bf4382f68df9fd4b916302bea0e3c4f19edfa6b546a475ae7ad981012290832" },
      origin: { action: "ANCHOR", action_format: 0, action_index: "659", block_index: "67882002", tx_hash: "1bf4382f68df9fd4b916302bea0e3c4f19edfa6b546a475ae7ad981012290832", tx_index: "660" } },
    { node: { height: 67882023, actionIndex: 255, action: "PRICE", txIndex: 258, txVout: 0, txHash: "8487594f261198d840da2b44f67338978b495b86e343ee852cfd91630db5ceed" },
      origin: { action: "PRICE", action_format: 0, action_index: "660", block_index: "67882023", tx_hash: "8487594f261198d840da2b44f67338978b495b86e343ee852cfd91630db5ceed", tx_index: "661" } },
    { node: { height: 67882040, actionIndex: 256, action: "PRICE", txIndex: 259, txVout: 0, txHash: "33c23730935918d65c5a60f6e2eb0ac05ba9be915df45e420457f4000c45df9d" },
      origin: { action: "PRICE", action_format: 0, action_index: "661", block_index: "67882040", tx_hash: "33c23730935918d65c5a60f6e2eb0ac05ba9be915df45e420457f4000c45df9d", tx_index: "662" } },
    { node: { height: 67882080, actionIndex: 257, action: "ATTEST", txIndex: 260, txVout: 0, txHash: "8cbf12505aec107968a5beec4338542bdd45c547bd61c8d3ac4a6b815a7b0efe" },
      origin: { action: "ATTEST", action_format: 5, action_index: "662", block_index: "67882080", tx_hash: "8cbf12505aec107968a5beec4338542bdd45c547bd61c8d3ac4a6b815a7b0efe", tx_index: "663" } },
    { node: { height: 67882080, actionIndex: 258, action: "ATTEST", txIndex: 261, txVout: 0, txHash: "8fa785d75cb4e2b40170b8e9a1b45406346f74eb327b11b200c2fdb9c7cfd9ea" },
      origin: { action: "ATTEST", action_format: 5, action_index: "663", block_index: "67882080", tx_hash: "8fa785d75cb4e2b40170b8e9a1b45406346f74eb327b11b200c2fdb9c7cfd9ea", tx_index: "664" } },
    { node: { height: 67882084, actionIndex: 259, action: "ORDER", txIndex: 262, txVout: 0, txHash: "5af21b8cab026cf7dc23c4d3443881dd0498935b52346b32efbd05f494801b9a" },
      origin: { action: "ORDER", action_format: 0, action_index: "664", block_index: "67882084", tx_hash: "5af21b8cab026cf7dc23c4d3443881dd0498935b52346b32efbd05f494801b9a", tx_index: "665" } },
    { node: { height: 67882087, actionIndex: 260, action: "ORDER", txIndex: 263, txVout: 0, txHash: "018c4a5285d6292c179b58865287abcd93aaf3ae91ef0aeda53d9b7cff6b6d2c" },
      origin: { action: "ORDER", action_format: 0, action_index: "665", block_index: "67882087", tx_hash: "018c4a5285d6292c179b58865287abcd93aaf3ae91ef0aeda53d9b7cff6b6d2c", tx_index: "666" } },
    { node: { height: 67882120, actionIndex: 261, action: "PRICE", txIndex: 265, txVout: 0, txHash: "d1af6018c6b918d7da4f967f2f25541432b71ba4c4564e37d96914129efd10be" },
      origin: { action: "PRICE", action_format: 0, action_index: "668", block_index: "67882120", tx_hash: "d1af6018c6b918d7da4f967f2f25541432b71ba4c4564e37d96914129efd10be", tx_index: "668" } },
    { node: { height: 67882121, actionIndex: 262, action: "PRICE", txIndex: 266, txVout: 0, txHash: "cbada86af5c0164061bca9a23a824774a9e7dc1de4b3bd8dc83f3981a882e139" },
      origin: { action: "PRICE", action_format: 0, action_index: "669", block_index: "67882121", tx_hash: "cbada86af5c0164061bca9a23a824774a9e7dc1de4b3bd8dc83f3981a882e139", tx_index: "669" } },
    { node: { height: 67882158, actionIndex: 263, action: "PRICE", txIndex: 267, txVout: 0, txHash: "359034fcbab39e63ee4eb47760da699489a7acfc7b070813764f35182d0c7dd4" },
      origin: { action: "PRICE", action_format: 0, action_index: "671", block_index: "67882158", tx_hash: "359034fcbab39e63ee4eb47760da699489a7acfc7b070813764f35182d0c7dd4", tx_index: "670" } },
    { node: { height: 67882168, actionIndex: 264, action: "PRICE", txIndex: 268, txVout: 0, txHash: "9fcd7f102b0a49bb13aa0924da7c0d409a1c7a08b70bb3846f9395d743d6e4ce" },
      origin: { action: "PRICE", action_format: 0, action_index: "672", block_index: "67882168", tx_hash: "9fcd7f102b0a49bb13aa0924da7c0d409a1c7a08b70bb3846f9395d743d6e4ce", tx_index: "671" } }
];

// Two DERIVED actions from the same live window. A derived action is filed by
// origin with no transaction at all: `tx_hash` null AND `tx_index` null. They
// are here because a null must never behave as a wildcard.
const DERIVED_ROWS = [
    { action: "ORDER_MATCH",    action_format: null, action_index: "666", block_index: "67882087", tx_hash: null, tx_index: null },
    { action: "COINPAY_EXPIRE", action_format: null, action_index: "670", block_index: "67882126", tx_hash: null, tx_index: null }
];

// The window all 20 pairs are matched against here. A live one is origin's
// newest actions in one page (the endpoint caps that at 100, which spanned 1,416
// blocks when this was measured); this one carries just the rows those 20
// transactions need, plus the two derived rows, so the file needs no network.
const WINDOW = REAL_PAIRS.map((p) => p.origin).concat(DERIVED_ROWS);

const ORDER_666 = REAL_PAIRS.find((p) => p.origin.tx_index === "666");

function indexOf(rows) { return drill.buildOriginActionIndex(rows); }

// ---------------------------------------------------------------------------

describe('AT5 barrier drill: aligning two nodes on the chain\'s own coordinate (row 55)', function () {

    describe('the fixture is the defect', function () {

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
    });

    describe('alignOnTxHash: the predicate', function () {

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
    });

    describe('a null tx_index, deliberately', function () {

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
    });

    describe('refusals name the cause instead of reporting a bare false', function () {

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
    });

    describe('one transaction carrying more than one action', function () {

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
    });

    describe('buildOriginActionIndex: the window', function () {

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
    });

    // -----------------------------------------------------------------------
    // Wired into the drill, not merely exported
    // -----------------------------------------------------------------------

    describe('observeBlock asks origin for ORIGIN\'s action index', function () {

        // Block 67881946 as run 5 really found it: three ATTESTs on three
        // transactions, which the node numbered 249-251 and origin numbered
        // 654-656. The node's own database answers the actions query; nothing
        // opens a socket. The statuses are assigned here, since what is under test
        // is which action each verdict is read for, not what the verdict was.
        const HEIGHT = 67881946;
        const PICKED = REAL_PAIRS.filter((p) => p.node.height === HEIGHT);
        const NODE_STATUS   = { 249: 'valid', 250: 'valid', 251: 'valid' };
        const ORIGIN_STATUS = { 654: 'valid', 655: 'valid', 656: 'invalid' };

        function conn() {
            return {
                async query(sql) {
                    if (/\.actions a JOIN/.test(sql)) {
                        return PICKED.map((p) => ({
                            action_index: p.node.actionIndex, tx_index: p.node.txIndex,
                            tx_vout: p.node.txVout, action: p.node.action, tx_hash: p.node.txHash
                        }));
                    }
                    if (/index_statuses s/.test(sql)) {
                        return PICKED.map((p) => ({
                            action_index: p.node.actionIndex, status: NODE_STATUS[p.node.actionIndex]
                        }));
                    }
                    return [];
                }
            };
        }

        function origin(asked) {
            return {
                async recentActions() { return { rows: WINDOW, error: null, limit: 200 }; },
                async newestRoundAtOrBefore() { return { round: 41, blockTimestamp: 1, rowsScanned: 1 }; },
                async action(i) {
                    asked.push(i);
                    const status = ORIGIN_STATUS[i];
                    if (status === undefined) {
                        // The node's own index reaching this method is the defect
                        // itself, so it is made unmistakable rather than silent.
                        throw new Error('origin.action was asked for ' + i + ', which is not one of origin\'s indexes');
                    }
                    return { found: true, status: status, action: null, blockIndex: HEIGHT, txIndex: null };
                }
            };
        }

        let observation;
        const asked = [];

        before(async function () {
            observation = await drill.observeBlock({
                node: { mirrorDbName: 'AT5_Mirror', hubDbName: 'AT5_Hub', indexerDbName: 'AT5_Indexer' },
                conn: conn(),
                origin: origin(asked),
                tables: ['prices'],
                height: HEIGHT,
                // The block's own timestamp as origin reports it, seen 18 s later
                // and released one grace after: a live block, held at the barrier.
                blockTime: 1_788_984_029,
                firstSeenAt: 1_788_984_047,
                processedAt: 1_788_988_850,
                deferrals: [],
                originNow: { lag: 0, blockIndex: HEIGHT },
                maxBlockAgeS: 120,
                originActionPage: 200
            });
        });

        it('fetched origin\'s verdicts by origin\'s indexes and never by the node\'s', function () {
            assert.strictEqual(PICKED.length, 3, 'block 67881946 carried three ATTESTs');
            assert.deepStrictEqual(asked.slice().sort((a, b) => a - b), [654, 655, 656]);
            for (const nodeIndex of [249, 250, 251]) {
                assert.ok(!asked.includes(nodeIndex),
                    'the node\'s own action_index ' + nodeIndex + ' must never be sent to origin');
            }
        });

        it('aligned all three and recorded both coordinates', function () {
            assert.strictEqual(observation.actions.length, 3);
            for (const r of observation.actions) {
                assert.strictEqual(r.coordinateAligned, true, r.action + ' at ' + r.actionIndex + ' must align');
                assert.strictEqual(r.alignment, 'aligned');
                assert.ok(r.txHash, 'the chain coordinate is in the record');
                assert.notStrictEqual(r.originActionIndex, r.actionIndex,
                    'the two counters differ, and both are recorded');
            }
            assert.deepStrictEqual(observation.alignmentReasons, { aligned: 3 });
        });

        it('scored two agreements and one divergence, with the rounds beside it', function () {
            assert.strictEqual(observation.verdictAgreements, 2);
            assert.strictEqual(observation.verdictDisagreements.length, 1);
            const d = observation.verdictDisagreements[0];
            assert.strictEqual(d.actionIndex, 251);
            assert.strictEqual(d.originActionIndex, 656);
            assert.strictEqual(d.nodeStatus, 'valid');
            assert.strictEqual(d.originStatus, 'invalid');
            assert.strictEqual(d.originPricedAgainstRound, 41);
        });

        it('feeds comparedVerdicts, so the run\'s parity stop condition sees them', function () {
            assert.strictEqual(observation.usable, true, 'the block arrived live, so it is graded');
            assert.strictEqual(drill.comparedVerdicts([observation]), 3);
            assert.strictEqual(drill.summarize({ observations: [observation] }).verdictsCompared, 3);
        });

        it('records the window each comparison was made against', function () {
            assert.strictEqual(observation.originActions.rowsRead, WINDOW.length);
            assert.strictEqual(observation.originActions.coversThisBlock, true);
            assert.strictEqual(observation.originActions.error, null);
        });
    });

    describe('a block with nothing to compare still stops nothing', function () {

        it('grades the block, compares nothing, and does not call origin at all', async function () {
            const observation = await drill.observeBlock({
                node: { mirrorDbName: 'AT5_Mirror', hubDbName: 'AT5_Hub', indexerDbName: 'AT5_Indexer' },
                conn: { async query() { return []; } },
                origin: {
                    async recentActions() { throw new Error('a block with no action must not read origin\'s window'); },
                    async newestRoundAtOrBefore() { return { round: null, blockTimestamp: null, rowsScanned: 0 }; },
                    async action() { throw new Error('origin.action must not be reached'); }
                },
                tables: [],
                height: 67882090,
                blockTime: 1_788_987_800,
                firstSeenAt: 1_788_987_810,
                processedAt: 1_788_992_700,
                deferrals: [],
                originNow: { lag: 0, blockIndex: 67882090 },
                maxBlockAgeS: 120,
                originActionPage: 200
            });
            assert.strictEqual(observation.actions.length, 0);
            assert.strictEqual(drill.comparedVerdicts([observation]), 0,
                'which is what the insufficient-parity-traffic exit is for');
            assert.deepStrictEqual(observation.alignmentReasons, {});
        });
    });
});
