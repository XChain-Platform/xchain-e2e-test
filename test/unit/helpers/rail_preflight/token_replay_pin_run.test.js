'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    REPLAY_PIN_FILES,
    REQUIRED_CASES,
    replayPinArgs,
    judgeReplayPinReport,
    runReplayPin
} = require('../../../helpers/rail_preflight/token_replay_pin_run');

function report(overrides = {}) {
    const passes = REQUIRED_CASES.map(title => ({ title, fullTitle: 'suite ' + title }));
    return Object.assign({
        stats: { passes: passes.length, failures: 0, pending: 0 },
        passes, failures: [], pending: []
    }, overrides);
}

describe('judgeReplayPinReport', function () {
    it('accepts a clean run that passed every required case', function () {
        const verdict = judgeReplayPinReport(report());

        assert.strictEqual(verdict.ok, true);
        assert.deepStrictEqual(verdict.problems, []);
        assert.deepStrictEqual(verdict.counts, { passing: REQUIRED_CASES.length, failing: 0, pending: 0 });
    });

    it('rejects a missing report', function () {
        for (const missing of [null, {}, { stats: {} }]) {
            const verdict = judgeReplayPinReport(missing);
            assert.strictEqual(verdict.ok, false);
            assert.match(verdict.problems[0], /wrote no mocha report/);
        }
    });

    it('rejects a failing case and names it', function () {
        const verdict = judgeReplayPinReport(report({
            stats: { passes: 4, failures: 1, pending: 0 },
            failures: [{ fullTitle: 'pin drifted' }]
        }));

        assert.strictEqual(verdict.ok, false);
        assert.ok(verdict.problems.some(p => p.includes('pin drifted')));
    });

    it('rejects a skipped case, which compared nothing', function () {
        const verdict = judgeReplayPinReport(report({
            stats: { passes: 5, failures: 0, pending: 1 },
            pending: [{ fullTitle: 'skipped pin' }]
        }));

        assert.strictEqual(verdict.ok, false);
        assert.ok(verdict.problems.some(p => p.includes('skipped pin')));
    });

    it('rejects a run where a required case is gone even though everything else is green', function () {
        const gone = REQUIRED_CASES[3];
        const passes = REQUIRED_CASES.filter(t => t !== gone).map(title => ({ title, fullTitle: title }));

        const verdict = judgeReplayPinReport(report({ passes, stats: { passes: passes.length, failures: 0, pending: 0 } }));

        assert.strictEqual(verdict.ok, false);
        assert.deepStrictEqual(verdict.missing, [gone]);
    });

    it('rejects a run that passed nothing', function () {
        const verdict = judgeReplayPinReport(report({ stats: { passes: 0, failures: 0, pending: 0 }, passes: [] }));

        assert.strictEqual(verdict.ok, false);
        assert.ok(verdict.problems.some(p => /passed no case/.test(p)));
    });
});

describe('replayPinArgs', function () {
    it('runs the indexer mocha with its setup file over every pinned file', function () {
        const args = replayPinArgs('/idx', '/tmp/r.json');

        assert.strictEqual(args[0], path.join('/idx', 'node_modules', 'mocha', 'bin', 'mocha.js'));
        assert.ok(args.includes('output=/tmp/r.json'));
        assert.deepStrictEqual(args.slice(-REPLAY_PIN_FILES.length), REPLAY_PIN_FILES);
        assert.strictEqual(args[args.indexOf('--require') + 1], './test/helpers/setup.js');
    });
});

describe('runReplayPin', function () {
    function fakeSpawn(status, json, onReport) {
        return (cmd, args) => {
            const output = args.find(a => a.startsWith('output=')).slice('output='.length);
            if (json) fs.writeFileSync(output, JSON.stringify(json));
            if (onReport) onReport(output);
            return { status, signal: null, stdout: '', stderr: 'tail text' };
        };
    }

    it('is ok when mocha exits 0 with a clean report', function () {
        let reportFile;
        const result = runReplayPin('/idx', {}, fakeSpawn(0, report(), output => { reportFile = output; }));

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.exit, 0);
        assert.strictEqual(fs.existsSync(reportFile), false);
    });

    it('is not ok when mocha exits nonzero even with a clean report', function () {
        const result = runReplayPin('/idx', {}, fakeSpawn(1, report()));

        assert.strictEqual(result.ok, false);
        assert.match(result.problems[0], /exited 1/);
    });

    it('is not ok when no report was written', function () {
        const result = runReplayPin('/idx', {}, fakeSpawn(0, null));

        assert.strictEqual(result.ok, false);
    });
});
