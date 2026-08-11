/*
 * seed-contract-state: a REMEMBERED contract index is a claim about the chain,
 * and the chain is allowed to disagree.
 *
 * seedContractResumeByCodeHash covers one direction of the state file being
 * wrong: the file forgot a contract that is really there, and the tool must
 * find it rather than deploy a second copy. This file covers the mirror, which
 * is the one that actually fired in production.
 *
 * On 2026-08-10 xchain-decoder 1073d36 moved BTC:testnet's firstBlock from
 * 138000 to 147500. The seed contract had been deployed in block 147007, so it
 * fell below the new genesis and stopped existing as far as the indexer is
 * concerned: contracts, actions, tokens and contract_state all read zero rows.
 * The state file still said action_index 6, and because a cached index used to
 * short-circuit the chain lookup entirely, the tool planned
 *
 *     ISSUE, MINT, EXECUTE fill x3, EXECUTE remove
 *
 * with NO DEPLOY in it, every EXECUTE aimed at an index the chain does not
 * carry. Each one would have been signed, broadcast and paid for out of the
 * working address's remaining testnet coin, and none could have taken effect.
 *
 * The contract under test:
 *   - the chain is asked EVERY time, cache or no cache;
 *   - a cached index the chain does not carry is discarded, and the caller sees
 *     null so that DEPLOY re-enters the plan;
 *   - a cached index the chain confirms is kept, and does not become a second
 *     lookup's worth of doubt;
 *   - when the two disagree about WHICH index, the chain wins;
 *   - a lookup that ERRORS still throws, because "could not look" must never
 *     read as "not deployed" while a stale cache is being second-guessed.
 */

const assert = require('assert');
const crypto = require('crypto');
const { resolveContractIndex } = require('../../bin/seed-contract-state.js');

const ADDR = 'n3ksrwbSRGXwdXTCHYWjdRux5iD8uEoujg';
const CODE = 'contract source bytes\n';
const HASH = crypto.createHash('sha256').update(CODE, 'utf8').digest('hex');
const STATE_PATH = '.seed-BTC-testnet.json';

function stubSdk(rows) {
    const calls = { getContracts: 0 };
    return {
        calls,
        explorer: {
            getContracts: async () => {
                calls.getContracts++;
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

// Collects the log so the operator-facing explanation is assertable: a silent
// correction of a stale index is nearly as bad as trusting it, because the run
// that follows spends money on a plan nobody was told had changed.
function collector() {
    const lines = [];
    const log = (s) => lines.push(s);
    log.text = () => lines.join('\n');
    return log;
}

describe('seed-contract-state resolveContractIndex: the chain outranks the cache', function () {

    it('asks the chain even when the state file already names a contract', async function () {
        const sdk = stubSdk([row()]);
        const out = await resolveContractIndex(sdk, CODE, ADDR, { contractIndex: 6 },
                                               collector(), STATE_PATH);
        assert.strictEqual(out, 6);
        assert.strictEqual(sdk.calls.getContracts, 1);
    });

    // The production case: re-genesis. The cache says 6, the chain carries
    // nothing, and the answer must be null so the caller puts DEPLOY back.
    it('discards a cached index the chain does not carry, and returns null', async function () {
        const sdk = stubSdk([]);
        const log = collector();
        const out = await resolveContractIndex(sdk, CODE, ADDR, { contractIndex: 6 },
                                               log, STATE_PATH);
        assert.strictEqual(out, null);
        assert.match(log.text(), /not deployed on this chain/);
        assert.match(log.text(), /STALE/);
        assert.match(log.text(), /includes a fresh DEPLOY/);
    });

    it('says which index it discarded and where that record lives', async function () {
        const log = collector();
        await resolveContractIndex(stubSdk([]), CODE, ADDR, { contractIndex: 6 }, log, STATE_PATH);
        assert.match(log.text(), /action_index 6/);
        assert.match(log.text(), /\.seed-BTC-testnet\.json/);
    });

    // Not the same thing as a stale cache, and it must not be reported as one:
    // a first run has nothing to discard.
    it('reports a genuinely fresh chain as "not deployed yet", with no stale warning', async function () {
        const log = collector();
        const out = await resolveContractIndex(stubSdk([]), CODE, ADDR, {}, log, STATE_PATH);
        assert.strictEqual(out, null);
        assert.match(log.text(), /not deployed yet/);
        assert.doesNotMatch(log.text(), /STALE/);
    });

    // A reindex can renumber actions. Silently keeping the cached number would
    // point every later EXECUTE at whatever now sits at that index.
    it('prefers the chain when cache and chain name DIFFERENT indexes', async function () {
        const log = collector();
        const out = await resolveContractIndex(stubSdk([row({ action_index: '11' })]),
                                               CODE, ADDR, { contractIndex: 6 }, log, STATE_PATH);
        assert.strictEqual(out, 11);
        assert.match(log.text(), /action_index 11/);
        assert.match(log.text(), /NOT what the/);
    });

    it('keeps a cached index the chain confirms, and says it confirmed it', async function () {
        const log = collector();
        const out = await resolveContractIndex(stubSdk([row()]), CODE, ADDR,
                                               { contractIndex: 6 }, log, STATE_PATH);
        assert.strictEqual(out, 6);
        assert.match(log.text(), /found ON CHAIN by code_hash, confirming/);
    });

    // "Could not look" must not resolve to "not deployed" just because a cache
    // exists to fall back on: falling back is exactly how a duplicate DEPLOY,
    // or an EXECUTE into a void, gets broadcast during an explorer outage.
    it('THROWS on a failed lookup rather than falling back to the cache', async function () {
        await assert.rejects(
            () => resolveContractIndex(stubSdk(new Error('explorer 502')), CODE, ADDR,
                                       { contractIndex: 6 }, collector(), STATE_PATH),
            e => e.code === 'CONTRACT_LOOKUP_FAILED'
        );
    });
});
