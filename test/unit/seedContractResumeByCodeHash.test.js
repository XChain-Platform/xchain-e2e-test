/*
 * seed-contract-state: the state file is a cache, the chain is the authority.
 *
 * Every step of the seed tool resumes by asking the chain whether its work is
 * already done. The DEPLOY step was the exception: it asked a local JSON file.
 * That is a real difference, not a stylistic one, because there is a window in
 * which the two disagree. A run broadcasts the DEPLOY, waits for it to index,
 * and dies inside that wait (testnet4 defers a block for up to two hours, so
 * the 30-minute index wait trips on transactions that later confirm perfectly
 * well). The contract is now on chain, valid, paid for; the state file never
 * learned its action_index, because the line that records it is downstream of
 * the wait. The next run reads the file, prints "not deployed yet", and
 * deploys a second copy.
 *
 * That happened on BTC:testnet: the DEPLOY settled valid at action_index 6 in
 * block 147007, and the resume the following day broadcast a duplicate.
 *
 * The contract under test:
 *   - an already-deployed contract is found ON CHAIN by matching the explorer's
 *     code_hash to the sha256 of the local source;
 *   - the deploying ADDRESS alone is never enough, because it is free to deploy
 *     other contracts and adopting one would point every later EXECUTE at
 *     somebody else's code;
 *   - a non-valid DEPLOY is not a deployment;
 *   - duplicates resolve to the LOWEST action_index, deterministically, so a
 *     chain that already carries two does not drift between them;
 *   - a lookup that ERRORS is not a lookup that found nothing: it throws, so
 *     the caller can refuse rather than duplicate.
 */

const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { codeHashOf, findDeployedContract } = require('../../bin/seed-contract-state.js');

const ADDR  = 'n3ksrwbSRGXwdXTCHYWjdRux5iD8uEoujg';
const CODE  = 'contract source bytes\n';
const HASH  = crypto.createHash('sha256').update(CODE, 'utf8').digest('hex');
const OTHER = crypto.createHash('sha256').update('some other contract\n', 'utf8').digest('hex');

// A stub explorer that answers `rows` for the source query and counts the
// reads, so "asked the chain" is checkable rather than assumed.
function stubSdk(rows) {
    const calls = { getContracts: 0, args: null };
    return {
        calls,
        explorer: {
            getContracts: async (query, type) => {
                calls.getContracts++;
                calls.args = { query, type };
                if (rows instanceof Error) throw rows;
                return { data: rows, total: Array.isArray(rows) ? rows.length : 0 };
            }
        }
    };
}

function row(over = {}) {
    return Object.assign({
        action: 'DEPLOY', status: 'valid', action_index: '6',
        code_hash: HASH, source: ADDR, block_index: '147007'
    }, over);
}

describe('seed-contract-state findDeployedContract: resume from the chain, not the file', function () {

    it('computes the sha256 the explorer publishes as code_hash', function () {
        assert.strictEqual(codeHashOf(CODE), HASH);
    });

    // The real chain measurement this whole mechanism rests on: the explorer's
    // code_hash for BTC:testnet action_index 6 is the sha256 of the seed
    // contract source shipped in this repo. If the file changes without the
    // chain, this fails - which is correct, because the resume lookup would
    // then stop finding the deployed contract.
    it('agrees with the code_hash BTC:testnet published for the real seed contract', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../bin/contracts/spvSeed.js'), 'utf8');
        assert.strictEqual(
            codeHashOf(src),
            'f304ab588e538d87214191eb33d2cd8fb8862b741d7eb0a2bf56f11b8362f848'
        );
    });

    it('finds a contract the state file never heard of, by content hash', async function () {
        const sdk = stubSdk([row()]);
        assert.strictEqual(await findDeployedContract(sdk, CODE, ADDR), 6);
        assert.strictEqual(sdk.calls.getContracts, 1);
        assert.deepStrictEqual(sdk.calls.args, { query: ADDR, type: 'source' });
    });

    // The address is not the identity. This is the mutant that a
    // "filter by source and take the first" implementation would survive.
    it('ignores a DIFFERENT contract deployed by the SAME address', async function () {
        const sdk = stubSdk([row({ code_hash: OTHER, action_index: '3' })]);
        assert.strictEqual(await findDeployedContract(sdk, CODE, ADDR), null);
    });

    it('ignores a non-valid DEPLOY of the very same code', async function () {
        const sdk = stubSdk([row({ status: 'invalid' })]);
        assert.strictEqual(await findDeployedContract(sdk, CODE, ADDR), null);
    });

    it('ignores a non-DEPLOY action carrying the same hash', async function () {
        const sdk = stubSdk([row({ action: 'EXECUTE' })]);
        assert.strictEqual(await findDeployedContract(sdk, CODE, ADDR), null);
    });

    // A chain that already carries duplicates (this one does) must resolve the
    // same way every run, or two resumes fill two different contracts.
    it('resolves duplicates to the lowest action_index, in either arrival order', async function () {
        const asc  = stubSdk([row({ action_index: '6' }), row({ action_index: '9' })]);
        const desc = stubSdk([row({ action_index: '9' }), row({ action_index: '6' })]);
        assert.strictEqual(await findDeployedContract(asc,  CODE, ADDR), 6);
        assert.strictEqual(await findDeployedContract(desc, CODE, ADDR), 6);
    });

    it('returns null when the address has deployed nothing at all', async function () {
        const sdk = stubSdk([]);
        assert.strictEqual(await findDeployedContract(sdk, CODE, ADDR), null);
    });

    // "Found nothing" and "could not look" are different answers, and only one
    // of them makes deploying safe.
    it('THROWS when the lookup itself fails, rather than reporting "not deployed"', async function () {
        const sdk = stubSdk(new Error('explorer 502'));
        await assert.rejects(
            () => findDeployedContract(sdk, CODE, ADDR),
            e => e.code === 'CONTRACT_LOOKUP_FAILED' && /explorer 502/.test(e.message)
        );
    });

    it('tolerates an explorer envelope that is a bare array', async function () {
        const sdk = {
            explorer: { getContracts: async () => [row()] }
        };
        assert.strictEqual(await findDeployedContract(sdk, CODE, ADDR), 6);
    });
});
