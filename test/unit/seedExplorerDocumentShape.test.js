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
 * seed-contract-state: the explorer returns DOCUMENTS, not scalars.
 *
 * WHY THIS EXISTS. bin/seed-contract-state.js has been bitten twice by one
 * mistake wearing two faces:
 *
 *   - `last_block` is a MAP keyed by coin prefix (TBTC, RLTC, ...), not a
 *     number. Read as a scalar it yields null, and the runway line the
 *     preflight exists to produce silently disappears.
 *   - the token document nests identity under `info` and carries NO top-level
 *     `tick`, so `!!(token.tick || token.TICK)` was false for every token that
 *     EXISTS. On BTC:testnet 2026-08-04 the preflight announced "DOES NOT EXIST"
 *     against a live token and the run broadcast a SECOND ISSUE.
 *
 * Both are the same failure: a guess at the top level returns falsy, and falsy
 * reads as "the chain does not have this" rather than "I looked in the wrong
 * place". Nothing throws, so the first symptom is a paid transaction.
 *
 * The fixtures below are the shapes the live explorer actually serves, and the
 * tests pin BOTH halves: that the helper finds the field where it really lives,
 * and that a document which answers WITHOUT the field is reported as a shape
 * change rather than as an absence.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');
const {
    explorerField, isExplorerError, EXPLORER_ENVELOPES, makeSubmitChecked, requireValid
} = require('../../bin/seed-contract-state.js');

// The SDK's own ActionWaiter, resolved through the same candidate paths the
// tool's loadSDK uses (this repo's node_modules/xchain-sdk is a link to a
// checkout that is not always populated). Null when it cannot be resolved, and
// the tests that need it skip rather than passing vacuously.
function loadActionWaiter() {
    for (const c of ['xchain-sdk/src/actionWaiter.js',
                     '../../xchain-sdk/src/actionWaiter.js',
                     '../../../xchain-sdk/src/actionWaiter.js']) {
        try {
            return c.startsWith('.') ? require(path.resolve(__dirname, c)) : require(c);
        } catch (e) { /* next */ }
    }
    return null;
}

// The live explorer's /token/XCHAIN document, trimmed to its envelopes.
const TOKEN_DOC = {
    info:   { coin: 'TBTC', tick: 'XCHAIN', owner: 'mkH...', decimals: 8, description: 'XChain gas token' },
    supply: { supply: '0', max_supply: '100000000' },
    mints:  { count: 0, max_mint: '100000' }
};

// The live explorer's fleet-wide /status document (trimmed; read from
// https://explorer.xchain.io/TBTC/api/status on 2026-08-04, where last_block
// carried all nine coins: BTC/TBTC/RBTC, LTC/TLTC/RLTC, DOGE/TDOGE/RDOGE).
const STATUS_DOC = {
    last_block:  { TBTC: 146986, RLTC: 101, TDOGE: 66498605 },
    decoder_tip: { TBTC: 146985 }
};

const TXID = 'b'.repeat(64);
const quiet = () => {};

describe('seed-contract-state explorerField: documents, not scalars', function () {

    describe('the token document', function () {

        it('pins the shape the tool got wrong: there is NO top-level tick', function () {
            // If this ever fails the explorer changed, and the nested read below
            // is the thing to revisit. It is asserted rather than assumed
            // because the whole bug was an assumption about this line.
            assert.strictEqual(TOKEN_DOC.tick, undefined);
            assert.strictEqual(TOKEN_DOC.TICK, undefined);
        });

        it('finds the tick under info and says where it read it', function () {
            const r = explorerField(TOKEN_DOC, 'tick');
            assert.strictEqual(r.found, true);
            assert.strictEqual(r.value, 'XCHAIN');
            assert.strictEqual(r.at, 'info.tick');
            assert.strictEqual(r.document, true);
        });

        it('reads an UPPERCASE field name just the same', function () {
            const r = explorerField({ info: { TICK: 'XCHAIN' } }, 'tick');
            assert.strictEqual(r.value, 'XCHAIN');
            assert.strictEqual(r.at, 'info.TICK');
        });

        it('prefers a real top-level value when there is one', function () {
            const r = explorerField({ tick: 'FLAT', info: { tick: 'NESTED' } }, 'tick');
            assert.strictEqual(r.value, 'FLAT');
            assert.strictEqual(r.at, 'tick');
        });

        it('falls through a present-but-null top level to the envelope', function () {
            // A null is not a value. Stopping at it would reproduce the bug with
            // an extra step.
            const r = explorerField({ tick: null, info: { tick: 'XCHAIN' } }, 'tick');
            assert.strictEqual(r.value, 'XCHAIN');
            assert.strictEqual(r.at, 'info.tick');
        });

        it('separates "the explorer said nothing" from "the field moved"', function () {
            // Nothing to read: an absent token, legitimately.
            for (const empty of [null, undefined, {}, 'XCHAIN', 0]) {
                const r = explorerField(empty, 'tick');
                assert.strictEqual(r.document, false, JSON.stringify(empty));
                assert.strictEqual(r.found, false);
            }
            // A document that ANSWERED and carries no tick anywhere. This is the
            // case the old code could not see: it reported absent, and the run
            // re-ISSUEd a token that already existed.
            const moved = explorerField({ asset: { symbol: 'XCHAIN' }, supply: {} }, 'tick');
            assert.strictEqual(moved.document, true);
            assert.strictEqual(moved.found, false);
        });

        it('does not accept a list of documents as one document', function () {
            const r = explorerField([{ tick: 'XCHAIN' }], 'tick');
            assert.strictEqual(r.found, false);
            assert.strictEqual(r.document, true);
            assert.ok(/list of 1 documents/.test(r.surprise), r.surprise);
        });

        it('searches every envelope the explorer uses', function () {
            for (const env of EXPLORER_ENVELOPES) {
                const doc = {};
                doc[env] = { tick: 'XCHAIN' };
                assert.strictEqual(explorerField(doc, 'tick').value, 'XCHAIN', env);
            }
        });

        it('ignores the OTHER tick in the live document (callback.tick, which is null)', function () {
            // Read from https://explorer.xchain.io/TBTC/api/token/XCHAIN on
            // 2026-08-04, trimmed. The document carries TWO fields named `tick`:
            // the token's, under `info`, and the callback's, which is null. A
            // helper that swept every nested object would find the callback's
            // first as often as not and report the token absent again, one
            // generalisation later. The envelope list is fixed for that reason.
            const LIVE = {
                callback:    { tick: null, price: null, block: '0', amount: '0' },
                controllers: [],
                info:        { coin: 'TBTC', tick: 'XCHAIN', description: 'XChain gas token',
                               owner: 'mgassdEpzH2AuKGK9W5FZh8drWYKrpXk6D', tick_id: 1, decimals: 8 },
                locks:       { mint: false, max_supply: false },
                mints:       { max: 100000, start_block: 1 }
            };
            const r = explorerField(LIVE, 'tick');
            assert.strictEqual(r.value, 'XCHAIN');
            assert.strictEqual(r.at, 'info.tick');
        });
    });

    describe('the fleet status document (the map-valued read)', function () {

        it('indexes last_block by coin prefix', function () {
            const r = explorerField(STATUS_DOC, 'last_block', { key: 'TBTC' });
            assert.strictEqual(r.found, true);
            assert.strictEqual(Number(r.value), 146986);
            assert.strictEqual(r.at, 'last_block.TBTC');
        });

        it('is a plain absence for a coin the fleet does not carry', function () {
            const r = explorerField(STATUS_DOC, 'last_block', { key: 'TLTC' });
            assert.strictEqual(r.found, false);
            assert.strictEqual(r.surprise, null, 'a missing coin is not a shape change');
        });

        it('reports a SCALAR where the per-coin map belongs', function () {
            // The inverse of the original bug: if the explorer ever flattened
            // this, "no tip" would be silently wrong rather than loud.
            const r = explorerField({ last_block: 146956 }, 'last_block', { key: 'TBTC' });
            assert.strictEqual(r.found, false);
            assert.ok(/not the per-key map/.test(r.surprise), r.surprise);
        });

        it('reads the map out of an envelope too', function () {
            const r = explorerField({ data: { last_block: { TBTC: 7 } } }, 'last_block', { key: 'TBTC' });
            assert.strictEqual(Number(r.value), 7);
            assert.strictEqual(r.at, 'data.last_block.TBTC');
        });
    });

    describe('isExplorerError', function () {

        it('an error body is an ABSENCE, not a shape change', function () {
            // Without this the preflight would blocker-out on a perfectly
            // ordinary not-found answer and no run could ever create the token.
            assert.strictEqual(isExplorerError({ error: 'Token not found' }), true);
            assert.strictEqual(isExplorerError({ errors: ['nope'] }), true);
        });

        it('a real document is not an error', function () {
            assert.strictEqual(isExplorerError(TOKEN_DOC), false);
            assert.strictEqual(isExplorerError(null), false);
            assert.strictEqual(isExplorerError([{ error: 'x' }]), false);
        });
    });

    describe('the timeout recovery reads through the same helper', function () {

        it('recovers from an ENVELOPED transaction document', async function () {
            // The recovery is the last thing standing between a genuine failure
            // and a run that continues, so it must not be the one place left
            // guessing at the top level.
            const err = new Error('Timed out waiting for transaction ' + TXID + ' to be indexed (1800000ms)');
            err.code = 'CONFIRMATION_TIMEOUT';
            err.details = { txid: TXID };
            const sdk = {
                submitAction: async () => { throw err; },
                explorer: {
                    getTransaction: async () => ({
                        data: {
                            tx_hash: TXID, block_index: 146981,
                            actions: [{ action: 'MINT', action_index: 4, status: 'valid' }]
                        }
                    })
                }
            };
            const res = await makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT XCHAIN');
            assert.strictEqual(res.txid, TXID);
            assert.strictEqual(res.recheckedAfterTimeout, true);
            assert.strictEqual(res.indexed.status, 'valid');
            assert.strictEqual(res.indexed.block_index, 146981);
        });

        it('an action with NO status is still not valid, enveloped or not', async function () {
            // (see below for the same two directions driven off a REAL SDK timeout)
            // The indexer not having written a verdict is not a verdict.
            const err = new Error('Timed out waiting for transaction ' + TXID + ' to be indexed');
            err.code = 'CONFIRMATION_TIMEOUT';
            err.details = { txid: TXID };
            const sdk = {
                submitAction: async () => { throw err; },
                explorer: {
                    getTransaction: async () => ({
                        data: { tx_hash: TXID, block_index: 5, actions: [{ action: 'MINT' }] }
                    })
                }
            };
            await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT'), e => e === err);
        });
    });

    // The falsification this guards against, driven off a REAL
    // CONFIRMATION_TIMEOUT rather than a hand-written one.
    //
    // A hand-made error is a mock of the SDK's contract, and the recovery is
    // built entirely on that contract: the code string, `details.txid`, and the
    // message the txid is scraped out of when details are missing. So the
    // timeout here is produced by the SDK's own ActionWaiter, against a stub
    // explorer that never shows the transaction, with the clock turned down to
    // milliseconds. If the SDK ever renames the code or drops the txid, these
    // fail rather than the next testnet run.
    // -----------------------------------------------------------------------
    describe('forced against the SDK\'s own timeout (leg b falsification)', function () {

        const ActionWaiter = loadActionWaiter();
        const TX = 'c'.repeat(64);

        // A genuine CONFIRMATION_TIMEOUT: the waiter polls an explorer that
        // does not carry the transaction, and its own clock runs out.
        async function realTimeout() {
            const waiter = new ActionWaiter({}, { explorer: { getTransaction: async () => null } });
            try {
                await waiter.waitForTxid(TX, { timeout: 60, pollInterval: 20 });
            } catch (e) {
                return e;
            }
            throw new Error('the waiter resolved; no timeout to test with');
        }

        beforeEach(function () {
            if (!ActionWaiter) this.skip();   // sibling SDK checkout not present
        });

        it('the SDK still raises the code and the txid this recovery is built on', async function () {
            const err = await realTimeout();
            assert.strictEqual(err.code, 'CONFIRMATION_TIMEOUT');
            assert.strictEqual(err.details.txid, TX);
            // Message reworded when the SDK started distinguishing
            // broadcast-but-not-yet-indexed from a real failure; the recovery
            // keys on the code and txid above, the message is advisory.
            assert.ok(/Transaction c{64} was not indexed within \d+ms/.test(err.message), err.message);
        });

        it('a transaction that IS indexed: the run CONTINUES', async function () {
            const err = await realTimeout();
            let asked = 0;
            const sdk = {
                submitAction: async () => { throw err; },
                explorer: {
                    getTransaction: async (q, type) => {
                        asked++;
                        assert.strictEqual(q, TX);
                        assert.strictEqual(type, 'tx_hash');
                        return { tx_hash: TX, block_index: 146981,
                                 actions: [{ action: 'DEPLOY', action_index: '2242', status: 'valid' }] };
                    }
                }
            };
            const res = await makeSubmitChecked(sdk, quiet)({}, {}, {}, 'DEPLOY');
            // "The run continues" is not "the promise resolved": it is that the
            // next thing every step does with the result does not throw.
            requireValid(res, 'DEPLOY');
            assert.strictEqual(res.txid, TX);
            assert.strictEqual(res.indexed.block_index, 146981);
            assert.strictEqual(asked, 1, 'the chain is asked once, not polled again');
        });

        it('a transaction that is NOT indexed: it still FAILS, with the original error', async function () {
            const err = await realTimeout();
            const sdk = {
                submitAction: async () => { throw err; },
                explorer: { getTransaction: async () => null }
            };
            await assert.rejects(
                () => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'DEPLOY'),
                e => e === err && e.code === 'CONFIRMATION_TIMEOUT'
            );
        });

        it('indexed but REJECTED is a failure, not a recovery', async function () {
            // The dangerous middle case: the chain does have it, and the
            // indexer threw it out. Recovering here would let a seed run
            // "succeed" onto a chain that holds none of its state.
            const err = await realTimeout();
            const sdk = {
                submitAction: async () => { throw err; },
                explorer: {
                    getTransaction: async () => ({
                        tx_hash: TX, block_index: 146981,
                        actions: [{ action: 'DEPLOY', status: 'invalid: MINT_START_BLOCK < BLOCK_INDEX' }]
                    })
                }
            };
            await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'DEPLOY'), e => e === err);
        });
    });
});
