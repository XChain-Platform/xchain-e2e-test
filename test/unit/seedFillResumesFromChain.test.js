/*
 * seed-contract-state: the fill resumes from the CHAIN, not from bookkeeping.
 *
 * The fill writes keys prefix+start .. prefix+start+count-1 and the tool tracked
 * `start` in its local state file, written AFTER the submit returned. On
 * testnet4 the submit routinely does not return: the 30-minute index wait trips
 * on transactions that later confirm perfectly well. So the marker was lost on
 * exactly the runs that made progress, and the next run restarted at 0 and
 * rewrote the same keys with the same values.
 *
 * Measured on BTC:testnet 2026-08-06, not theorised: contract 6 carried 209 rows
 * for 107 DISTINCT keys, seed/bulk/0..99 written twice, seed/count written three
 * times, and the live key count never moved off 107. The fill could not finish.
 * It would have run to the no-progress brake, paying for every round.
 *
 * The contract maintains seed/count (= start + count, exactly the next start),
 * but it cannot be read back: the explorer's state listing is paginated at 100
 * (total 107, returned 100, seed/count absent from the page) and a slash in a
 * key breaks the per-key route. What is reliable is the live key count, which
 * countLiveKeys reads from `total`.
 *
 * The contract under test:
 *   - with no local marker at all, the resume position comes from the chain;
 *   - the chain-derived position wins over a STALE LOW marker, which is the bug;
 *   - a marker AHEAD of the chain wins, which is the tombstone case: step 7
 *     deletes a base key, live keys drop by one, and the arithmetic alone would
 *     walk backwards over keys already written and paid for;
 *   - SEED_BASE_KEYS matches what the contract actually writes.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

// The resume rule, kept identical to step 6's expression. Both are one line;
// duplicating it here is what lets the rule be tested without standing up an
// SDK, a chain and a broadcast path.
const SEED_BASE_KEYS = 7;
const resumeFrom = (liveKeys, fillNext) =>
    Math.max(Math.max(0, liveKeys - SEED_BASE_KEYS), Number(fillNext || 0));

describe('seed-contract-state: the fill resume position', function () {

    it('SEED_BASE_KEYS equals what the contract initialize() actually writes', function () {
        const src   = fs.readFileSync(path.join(__dirname, '../../bin/contracts/spvSeed.js'), 'utf8');
        const from  = src.indexOf('initialize:');
        assert.ok(from >= 0, 'no initialize() in the contract source');
        // End at the method's own closing brace, not at the next occurrence of
        // "set:" - that ran past initialize() into set() and fill() and counted
        // their writes too, which is how this test failed on its first run.
        const end   = src.indexOf('\n    },', from);
        assert.ok(end > from, 'could not find the end of initialize()');
        const init  = src.slice(from, end);
        const sets  = init.match(/xchain\.state\.set\(/g) || [];
        assert.strictEqual(sets.length, SEED_BASE_KEYS,
            'initialize() writes ' + sets.length + ' keys but SEED_BASE_KEYS is ' + SEED_BASE_KEYS);
    });

    it('the constant is the one the tool actually uses', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../bin/seed-contract-state.js'), 'utf8');
        assert.ok(/const SEED_BASE_KEYS = 7;/.test(src), 'SEED_BASE_KEYS drifted from this test');
    });

    // The exact production failure: two resumes, no marker, both start at 0.
    it('resumes from the chain when the state file never recorded a marker', function () {
        assert.strictEqual(resumeFrom(7, undefined), 0);     // only base keys: start at 0
        assert.strictEqual(resumeFrom(107, undefined), 100); // 100 bulk keys already on chain
        assert.strictEqual(resumeFrom(207, undefined), 200);
    });

    // This is the assertion that would have failed before the fix. A stale-low
    // marker is precisely what a lost write leaves behind.
    it('a STALE LOW marker never drags the resume backwards over paid-for keys', function () {
        assert.strictEqual(resumeFrom(107, 0), 100);
        assert.strictEqual(resumeFrom(207, 100), 200);
    });

    // The tombstone case, and the reason the rule is a max rather than a plain
    // chain read: step 7 removes seed/doomed, so live keys fall by one and the
    // arithmetic alone would re-issue a key that already exists.
    it('a marker AHEAD of the chain wins, so the tombstone cannot rewind the fill', function () {
        assert.strictEqual(resumeFrom(249, 250), 250);
        assert.strictEqual(resumeFrom(249, undefined), 242); // what the bare arithmetic would say
    });

    it('never returns a negative start on a contract smaller than its base set', function () {
        assert.strictEqual(resumeFrom(0, undefined), 0);
        assert.strictEqual(resumeFrom(3, undefined), 0);
    });
});
