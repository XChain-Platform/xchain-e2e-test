'use strict'

const assert = require('assert')

const {
    legVerdicts,
    parseSweepArgs,
    renderSweepReport,
} = require('../../../scripts/rail_drive_sweep')

const DRIVES = {
    policy: {
        legs: {
            alpha: { grep: '^alpha:', minPassed: 2 },
            beta: { grep: '^beta:', minPassed: 1 },
            empty: { grep: '^empty:', minPassed: 3 },
            full: { grep: null, minPassed: 4 },
        },
    },
    token: {
        legs: {
            full: { grep: null, minPassed: 1 },
        },
    },
}

function line (entry) {
    return JSON.stringify(entry)
}

function byLeg (results, name) {
    return results.find((result) => result.leg === name)
}

describe('bridge rail sweep leg verdicts', function () {
    it('keeps the last journal entry for a rerun title', function () {
        const journal = [
            line({ title: 'alpha: rerun', state: 'failed', error: 'first attempt failed' }),
            line({ title: 'alpha: rerun', state: 'passed' }),
            line({ title: 'alpha: stable', state: 'passed' }),
        ].join('\n')

        assert.deepStrictEqual(byLeg(legVerdicts(journal, 'policy', DRIVES), 'alpha'), {
            leg: 'alpha', verdict: 'PASS', passed: 2, failed: 0,
            root: 0, cascade: 0, missing: 0,
        })
    })

    it('counts a non-cascade failure as root', function () {
        const journal = line({ title: 'beta: breaks', state: 'failed', error: 'socket closed' })

        assert.deepStrictEqual(byLeg(legVerdicts(journal, 'policy', DRIVES), 'beta'), {
            leg: 'beta', verdict: 'FAIL', passed: 0, failed: 1,
            root: 1, cascade: 0, missing: 0,
        })
    })

    it('counts a must-have-run failure only as cascade', function () {
        const journal = line({
            title: 'beta: depends on setup',
            state: 'failed',
            error: 'setup must have run before this case',
        })

        assert.deepStrictEqual(byLeg(legVerdicts(journal, 'policy', DRIVES), 'beta'), {
            leg: 'beta', verdict: 'FAIL', passed: 0, failed: 1,
            root: 0, cascade: 1, missing: 0,
        })
    })

    it('reports the full threshold as missing when a leg has no entries', function () {
        assert.deepStrictEqual(byLeg(legVerdicts('', 'policy', DRIVES), 'empty'), {
            leg: 'empty', verdict: 'FAIL', passed: 0, failed: 0,
            root: 0, cascade: 0, missing: 3,
        })
    })

    it('selects every title for the full leg', function () {
        const journal = [
            line({ title: 'alpha: one', state: 'passed' }),
            line({ title: 'beta: one', state: 'passed' }),
            line({ title: 'unmatched title', state: 'failed', error: 'broke' }),
            line({ title: 'another title', state: 'passed' }),
        ].join('\n')

        assert.deepStrictEqual(byLeg(legVerdicts(journal, 'policy', DRIVES), 'full'), {
            leg: 'full', verdict: 'FAIL', passed: 3, failed: 1,
            root: 1, cascade: 0, missing: 0,
        })
    })
})

describe('bridge rail sweep report', function () {
    it('renders exact leg, runner, and sweep lines', function () {
        const report = renderSweepReport([{
            drive: 'policy',
            legs: [
                { leg: 'alpha', verdict: 'PASS', passed: 2, failed: 0,
                    root: 0, cascade: 0, missing: 0 },
                { leg: 'beta', verdict: 'FAIL', passed: 0, failed: 1,
                    root: 0, cascade: 1, missing: 0 },
            ],
            runnerLines: ['triage: passed=2 failed=0', 'VERDICT PASS'],
        }])

        assert.strictEqual(report, [
            'LEG policy alpha PASS passed=2 failed=0 root=0 cascade=0 missing=0',
            'LEG policy beta FAIL passed=0 failed=1 root=0 cascade=1 missing=0',
            '## policy',
            'triage: passed=2 failed=0',
            'VERDICT PASS',
            'SWEEP legs=2 pass=1 fail=1',
            '',
        ].join('\n'))
    })
})

describe('bridge rail sweep arguments', function () {
    it('defaults to both drives and a 180 minute limit', function () {
        assert.deepStrictEqual(parseSweepArgs([
            '--journal-root', '/tmp/journals', '--report', '/tmp/report',
        ], DRIVES), {
            journalRoot: '/tmp/journals',
            report: '/tmp/report',
            drives: ['policy', 'token'],
            limitMinutes: 180,
        })
    })

    it('throws when report is missing', function () {
        assert.throws(() => parseSweepArgs([
            '--journal-root', '/tmp/journals', '--drives', 'policy',
        ], DRIVES), /--report is required/)
    })

    it('throws when a requested drive is absent from the map', function () {
        assert.throws(() => parseSweepArgs([
            '--journal-root', '/tmp/journals', '--report', '/tmp/report',
            '--drives', 'policy,missing',
        ], DRIVES), /unknown bridge rail drive: missing/)
    })
})
