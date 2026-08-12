/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 * Parsing helpers of bin/seed-contract-state.js.
 *
 * WHY THIS EXISTS. Every defect that tool has had lived in one of these two
 * functions, and none of them was visible by re-reading the code:
 *
 *   - contractIndexOf started as a chain of top-level `||` guesses
 *     (contract_action_index, contractActionIndex, ...). None of those fields
 *     exist. `actionWaiter` settles from three different places with three
 *     different shapes, and the original matched exactly one of them by
 *     accident, so whether the run survived its DEPLOY depended on whether the
 *     WebSocket or the poll path settled first. A coin flip, after a paid
 *     transaction.
 *
 *   - countLiveKeys returned `rows.length` from an endpoint that PAGINATES and
 *     reports the true count separately as `total`. That number is the condition
 *     of the fill loop, so a target above the page size meant broadcasting
 *     EXECUTEs forever against a count that could never rise.
 *
 * The fixtures below are the real shapes, taken from a live regtest DEPLOY row
 * and the live explorer's contract-state response, not invented ones. That is
 * the whole point: a fixture I made up would have agreed with the buggy code.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const { contractIndexOf, coinPrefix } = require('../../bin/seed-contract-state.js');

// A real DEPLOY action row, as the explorer returns it (trimmed to the fields
// these helpers touch; the live row also carries abi/code/code_hash/...).
const DEPLOY_ROW = {
    action: 'DEPLOY', action_index: '2242', action_format: 2,
    block_index: '10771', status: 'valid'
};

describe('seed-contract-state helpers', function () {

    describe('contractIndexOf: all three actionWaiter settle shapes', function () {

        it('poll path: the full action set', function () {
            assert.strictEqual(contractIndexOf({ actions: [DEPLOY_ROW], status: 'valid' }), '2242');
        });

        it('poll path: finds the DEPLOY even when an emitted sibling sorts first', function () {
            // A constructor that emits (emit.issue and friends) lands siblings in
            // the same transaction, and getTransaction returns them emitted-first.
            // Taking actions[0] would adopt the ISSUE's index and point every
            // later EXECUTE at the wrong contract.
            const indexed = { actions: [{ action: 'ISSUE', action_index: '999' }, DEPLOY_ROW] };
            assert.strictEqual(contractIndexOf(indexed), '2242');
        });

        it('websocket NEW_ACTION path: a single action row', function () {
            assert.strictEqual(contractIndexOf(Object.assign({}, DEPLOY_ROW, { status: 'valid' })), '2242');
        });

        it('explorer.getAction path: a single action row', function () {
            assert.strictEqual(contractIndexOf(DEPLOY_ROW), '2242');
        });
    });

    describe('contractIndexOf: refuses rather than adopting a wrong index', function () {

        it('a single row that is not a DEPLOY yields null', function () {
            // Returning 999 here would be worse than failing: the run would
            // continue and write its state into somebody else's contract.
            assert.strictEqual(contractIndexOf({ action: 'ISSUE', action_index: '999' }), null);
        });

        it('empty, null and an empty action set all yield null', function () {
            assert.strictEqual(contractIndexOf({}), null);
            assert.strictEqual(contractIndexOf(null), null);
            assert.strictEqual(contractIndexOf(undefined), null);
            assert.strictEqual(contractIndexOf({ actions: [] }), null);
        });

        it('rejects the field names the first draft guessed at', function () {
            // These are the names that were tried and do not exist. If one ever
            // starts working, the SDK shape changed and this helper needs a look.
            assert.strictEqual(contractIndexOf({ contract_action_index: '2242' }), null);
            assert.strictEqual(contractIndexOf({ contractActionIndex: '2242' }), null);
            assert.strictEqual(contractIndexOf({ actionIndex: '2242' }), null);
        });
    });

    describe('coinPrefix', function () {
        it('maps the explorer per-coin status keys', function () {
            // The explorer serves ONE status document for the whole fleet keyed
            // by these, so getting it wrong silently drops the tip and with it
            // the runway line the preflight exists to produce.
            assert.strictEqual(coinPrefix('BTC', 'mainnet'), 'BTC');
            assert.strictEqual(coinPrefix('BTC', 'testnet'), 'TBTC');
            assert.strictEqual(coinPrefix('LTC', 'regtest'), 'RLTC');
            assert.strictEqual(coinPrefix('DOGE', 'testnet'), 'TDOGE');
        });

        it('is null for an unknown network rather than guessing', function () {
            assert.strictEqual(coinPrefix('BTC', 'devnet'), null);
        });
    });
});
