'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { triageJournal } = require('../../../scripts/rail_journal_triage');

const POLICY_SUITE_DIR = path.resolve(__dirname,
    '../../integration/bridge_rail_policy.test');
const MIN_GUARDS = 22;

function collectGuards() {
    const guards = [];
    const names = fs.readdirSync(POLICY_SUITE_DIR)
        .filter((name) => name.endsWith('.test.js'))
        .sort();
    for (const name of names) {
        const source = fs.readFileSync(path.join(POLICY_SUITE_DIR, name), 'utf8');
        for (const match of source.matchAll(/'([^'\n]*must have[^'\n]*)'/g)) {
            guards.push({ file: name, message: match[1] });
        }
    }
    return guards;
}

function journalFor(guards) {
    return guards.map((guard, index) => JSON.stringify({
        suite: 's',
        title: 'guard ' + index,
        state: 'failed',
        durationMs: 1,
        error: guard.message,
    })).join('\n');
}

describe('policy suite precondition guards', function () {
    it('reads every upstream-dependency guard as a cascade, never a root failure', function () {
        const guards = collectGuards();
        assert.ok(guards.length >= MIN_GUARDS,
            'expected at least ' + MIN_GUARDS + ' guards, found ' + guards.length);

        const result = triageJournal(journalFor(guards), { minPassed: 0 });
        const offenders = result.rootFailures.map((entry) => {
            const guard = guards[Number(entry.title.slice('guard '.length))];
            return guard.file + ': ' + guard.message;
        });

        assert.deepStrictEqual(offenders, []);
        assert.strictEqual(result.root, 0);
        assert.strictEqual(result.cascade, guards.length);
    });
});
