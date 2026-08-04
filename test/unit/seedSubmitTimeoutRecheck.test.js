/*
 * seed-contract-state: a CONFIRMATION_TIMEOUT is a wall clock, not evidence.
 *
 * The tool waits 30 minutes for a transaction to be indexed. On testnet4 that
 * clock is the wrong instrument: miners ride the 20-minute min-difficulty rule
 * until the tip timestamp walks into the future and the chain then defers a
 * block for up to two hours, so a broadcast, accepted, not-yet-mined
 * transaction trips the timeout and the run exits "FAILED: Timed out waiting
 * for transaction ... to be indexed" for an action that later confirms fine.
 * That message has misled this work in BOTH directions, which is why the
 * recovery has to be pinned in both directions too.
 *
 * The contract under test:
 *   - a non-timeout error is re-thrown untouched (the wrapper is not a catch-all);
 *   - a timeout whose transaction IS indexed and wholly valid becomes a success,
 *     shaped as the SDK's own settled result (callers read res.indexed.status
 *     and res.indexed.actions);
 *   - a timeout whose transaction is absent, action-less, or carries ANY
 *     non-valid action re-throws the ORIGINAL error, so a genuine failure still
 *     reads as one;
 *   - the explorer is asked exactly ONCE, because the point is to settle the
 *     question, not to start a second poll loop.
 */

const assert = require('assert');
const { makeSubmitChecked } = require('../../bin/seed-contract-state.js');

const TXID = 'a'.repeat(64);

function timeoutErr(txid = TXID, withDetails = true) {
    const e = new Error('Timed out waiting for transaction ' + txid + ' to be indexed (1800000ms)');
    e.code = 'CONFIRMATION_TIMEOUT';
    if (withDetails) e.details = { txid, timeout: 1800000 };
    return e;
}

// A stub SDK whose submitAction throws `thrown` and whose explorer answers
// `txDoc`. Counts the explorer reads so "exactly once" is checkable.
function stubSdk(thrown, txDoc) {
    const calls = { getTransaction: 0 };
    return {
        calls,
        submitAction: async () => { throw thrown; },
        explorer: {
            getTransaction: async () => {
                calls.getTransaction++;
                if (txDoc instanceof Error) throw txDoc;
                return txDoc;
            }
        }
    };
}

const quiet = () => {};

describe('seed-contract-state submitChecked: the timeout is not evidence', function () {

    it('passes a successful submit straight through and never asks the explorer', async function () {
        const calls = { getTransaction: 0 };
        const sdk = {
            submitAction: async () => ({ txid: TXID, indexed: { status: 'valid' } }),
            explorer: { getTransaction: async () => { calls.getTransaction++; return null; } }
        };
        const res = await makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT');
        assert.strictEqual(res.txid, TXID);
        assert.strictEqual(res.recheckedAfterTimeout, undefined);
        assert.strictEqual(calls.getTransaction, 0);
    });

    it('re-throws a NON-timeout error untouched rather than swallowing it', async function () {
        const boom = new Error('insufficient funds');
        boom.code = 'INSUFFICIENT_FUNDS';
        const sdk = stubSdk(boom, { tx_hash: TXID, actions: [{ status: 'valid' }] });
        await assert.rejects(
            () => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT'),
            e => e === boom
        );
        // The recovery path must not run for an error it was never meant to handle.
        assert.strictEqual(sdk.calls.getTransaction, 0);
    });

    // The obvious version of the test above does NOT pin the code guard: a
    // non-timeout error usually carries no txid, so it falls out of the
    // recovery at the txid check and re-throws for the wrong reason. Deleting
    // `err.code !== 'CONFIRMATION_TIMEOUT'` therefore survived it. This is the
    // case that kills that mutant: a non-timeout error that DOES carry a txid
    // whose transaction is indexed and valid. Only the code guard stops the
    // wrapper reporting success for a broadcast that failed for some other
    // reason entirely.
    it('re-throws a non-timeout error EVEN WHEN its txid is indexed and valid', async function () {
        const boom = new Error('nonce reuse detected');
        boom.code = 'BROADCAST_REJECTED';
        boom.details = { txid: TXID };
        const sdk = stubSdk(boom, {
            tx_hash: TXID, block_index: 42, actions: [{ action: 'MINT', status: 'valid' }]
        });
        await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT'), e => e === boom);
        assert.strictEqual(sdk.calls.getTransaction, 0, 'a non-timeout error never reaches the re-check');
    });

    it('RECOVERS when the chain shows the transaction indexed and valid', async function () {
        const sdk = stubSdk(timeoutErr(), {
            tx_hash: TXID,
            block_index: 146981,
            actions: [{ action: 'MINT', action_index: 4, status: 'valid' }]
        });
        const res = await makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT XCHAIN');
        assert.strictEqual(res.txid, TXID);
        assert.strictEqual(res.recheckedAfterTimeout, true);
        // Shaped for the real callers, not for this test.
        assert.strictEqual(res.indexed.status, 'valid');
        assert.strictEqual(res.indexed.block_index, 146981);
        assert.strictEqual(res.indexed.actions[0].action_index, 4);
        assert.strictEqual(sdk.calls.getTransaction, 1, 'the explorer is asked exactly once');
    });

    it('recovers a DEPLOY well enough for contractIndexOf to read the action_index', async function () {
        const { contractIndexOf } = require('../../bin/seed-contract-state.js');
        const sdk = stubSdk(timeoutErr(), {
            tx_hash: TXID,
            block_index: 5,
            actions: [{ action: 'DEPLOY', action_index: 77, status: 'valid' }]
        });
        const res = await makeSubmitChecked(sdk, quiet)({}, {}, {}, 'DEPLOY');
        assert.strictEqual(contractIndexOf(res.indexed), 77);
    });

    it('still FAILS when the explorer does not carry the transaction', async function () {
        const err = timeoutErr();
        const sdk = stubSdk(err, null);
        await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT'), e => e === err);
        assert.strictEqual(sdk.calls.getTransaction, 1);
    });

    it('still FAILS when the transaction is indexed but an action is INVALID', async function () {
        const err = timeoutErr();
        const sdk = stubSdk(err, {
            tx_hash: TXID,
            block_index: 9,
            actions: [
                { action: 'EXECUTE', status: 'valid' },
                { action: 'EXECUTE', status: 'invalid: insufficient funds (FEE)' }
            ]
        });
        await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'EXECUTE fill'), e => e === err);
    });

    it('still FAILS when the transaction is indexed but carries NO actions', async function () {
        const err = timeoutErr();
        const sdk = stubSdk(err, { tx_hash: TXID, block_index: 9, actions: [] });
        await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT'), e => e === err);
    });

    it('still FAILS when the explorer read itself throws', async function () {
        const err = timeoutErr();
        const sdk = stubSdk(err, new Error('ECONNREFUSED'));
        // The explorer error must not replace the timeout: the caller is told
        // what actually went wrong first.
        await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT'), e => e === err);
    });

    it('recovers the txid from the message when the error carries no details', async function () {
        const err = timeoutErr(TXID, false);
        const sdk = stubSdk(err, {
            tx_hash: TXID, block_index: 1, actions: [{ action: 'MINT', status: 'valid' }]
        });
        const res = await makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT');
        assert.strictEqual(res.txid, TXID);
    });

    // The in-flight ledger. A chain read cannot see a transaction that is
    // broadcast but not yet mined, so the step that made it reads as "not done"
    // and a re-run duplicates it. The txid is recorded at the broadcast
    // boundary and cleared only once the chain has settled the question.
    describe('the in-flight ledger', function () {

        function ledgerSpy() {
            const seen = { remembered: [], forgotten: [] };
            return {
                seen,
                rememberPending: (l, t) => seen.remembered.push([l, t]),
                forgetPending:   (l)    => seen.forgotten.push(l)
            };
        }

        // A stub that fires the SDK's own progress('waiting', {txid}) callback
        // before settling, which is what the real lifecycleManager does.
        function broadcastingSdk(outcome, txDoc) {
            const calls = { getTransaction: 0 };
            return {
                calls,
                submitAction: async (a, io, opts) => {
                    if (opts && opts.onProgress) opts.onProgress('waiting', { txid: TXID });
                    if (outcome instanceof Error) throw outcome;
                    return outcome;
                },
                explorer: {
                    getTransaction: async () => { calls.getTransaction++; return txDoc; }
                }
            };
        }

        it('records the txid at BROADCAST, before the outcome is known', async function () {
            const L = ledgerSpy();
            const sdk = broadcastingSdk({ txid: TXID, indexed: { status: 'valid' } });
            await makeSubmitChecked(sdk, quiet, L)({}, {}, {}, 'MINT');
            assert.deepStrictEqual(L.seen.remembered, [['MINT', TXID]]);
        });

        it('clears it once the submit succeeds', async function () {
            const L = ledgerSpy();
            const sdk = broadcastingSdk({ txid: TXID, indexed: { status: 'valid' } });
            await makeSubmitChecked(sdk, quiet, L)({}, {}, {}, 'MINT');
            assert.deepStrictEqual(L.seen.forgotten, ['MINT']);
        });

        it('clears it when a timeout is RECOVERED, so the next run does not report a phantom in-flight', async function () {
            const L = ledgerSpy();
            const sdk = broadcastingSdk(timeoutErr(), {
                tx_hash: TXID, block_index: 3, actions: [{ action: 'MINT', status: 'valid' }]
            });
            const res = await makeSubmitChecked(sdk, quiet, L)({}, {}, {}, 'MINT');
            assert.strictEqual(res.recheckedAfterTimeout, true);
            assert.deepStrictEqual(L.seen.forgotten, ['MINT']);
        });

        it('KEEPS it when the timeout is real, which is the whole point', async function () {
            const L = ledgerSpy();
            const sdk = broadcastingSdk(timeoutErr(), null);
            await assert.rejects(() => makeSubmitChecked(sdk, quiet, L)({}, {}, {}, 'MINT'));
            assert.deepStrictEqual(L.seen.remembered, [['MINT', TXID]]);
            assert.deepStrictEqual(L.seen.forgotten, [], 'an unsettled broadcast must stay recorded');
        });

        it('KEEPS it when the transaction is indexed but invalid', async function () {
            const L = ledgerSpy();
            const sdk = broadcastingSdk(timeoutErr(), {
                tx_hash: TXID, block_index: 3, actions: [{ status: 'invalid: insufficient funds (FEE)' }]
            });
            await assert.rejects(() => makeSubmitChecked(sdk, quiet, L)({}, {}, {}, 'MINT'));
            assert.deepStrictEqual(L.seen.forgotten, []);
        });

        it('still passes a caller-supplied onProgress through', async function () {
            const L = ledgerSpy();
            const steps = [];
            const sdk = broadcastingSdk({ txid: TXID, indexed: { status: 'valid' } });
            await makeSubmitChecked(sdk, quiet, L)({}, {}, { onProgress: (s) => steps.push(s) }, 'MINT');
            assert.deepStrictEqual(steps, ['waiting'], 'the ledger hook must not swallow the caller hook');
        });

        it('works with no ledger at all, so the wrapper stays usable standalone', async function () {
            const sdk = broadcastingSdk({ txid: TXID, indexed: { status: 'valid' } });
            const res = await makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT');
            assert.strictEqual(res.txid, TXID);
        });
    });

    it('fails rather than guessing when no txid can be recovered at all', async function () {
        const err = new Error('Timed out waiting for transaction  to be indexed');
        err.code = 'CONFIRMATION_TIMEOUT';
        const sdk = stubSdk(err, { tx_hash: TXID, actions: [{ status: 'valid' }] });
        await assert.rejects(() => makeSubmitChecked(sdk, quiet)({}, {}, {}, 'MINT'), e => e === err);
        assert.strictEqual(sdk.calls.getTransaction, 0);
    });
});
