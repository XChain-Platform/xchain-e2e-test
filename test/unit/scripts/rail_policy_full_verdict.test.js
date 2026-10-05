'use strict'

// GENERATED TEST CONTRACT

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.join(__dirname, '../../..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'rail_policy_full_verdict.js')
const POLICY_SUITES = path.join(REPO_ROOT, 'test', 'integration', 'bridge_rail_policy.test')
const { staticSkipTitles, judgePolicyDrive } = require('../../../scripts/rail_policy_full_verdict')

function report ({ passes = 28, failures = [], pending = [] } = {}) {
    return {
        stats: { passes, failures: failures.length, pending: pending.length },
        passes: Array.from({ length: passes }, (internal, index) => ({ title: 'pass ' + index })),
        failures,
        pending,
    }
}

function pending (title, fullTitle = title) {
    return { title, fullTitle }
}

function failure (title, message) {
    return { title, fullTitle: 'policy suite ' + title, err: { message } }
}

describe('policy full-drive verdict', function () {
    const staticTitles = ['policy static: ']

    it('marks a report with a missing reporter field unreadable', function () {
        const value = report()
        delete value.pending
        assert.deepStrictEqual(judgePolicyDrive(value, staticTitles), {
            verdict: 'UNREADABLE', passes: 0, failures: 0, staticPending: 0, gatedPending: 0,
        })
    })

    it('fails a report containing a failure', function () {
        const value = judgePolicyDrive(report({ failures: [failure('breaks', 'bad result')] }), staticTitles)
        assert.deepStrictEqual(value, {
            verdict: 'FAIL', passes: 28, failures: 1, staticPending: 0, gatedPending: 0,
        })
    })

    it('gates a report containing a non-static pending case', function () {
        const value = judgePolicyDrive(report({ pending: [pending('policy venue gate')] }), staticTitles)
        assert.deepStrictEqual(value, {
            verdict: 'GATED', passes: 28, failures: 0, staticPending: 0, gatedPending: 1,
        })
    })

    it('marks a report below the required pass count short', function () {
        const value = judgePolicyDrive(report({ passes: 27 }), staticTitles)
        assert.deepStrictEqual(value, {
            verdict: 'SHORT', passes: 27, failures: 0, staticPending: 0, gatedPending: 0,
        })
    })

    it('passes at the threshold while allowing static pending cases', function () {
        const value = judgePolicyDrive(report({
            pending: [pending('policy static: explanatory suffix')],
        }), staticTitles)
        assert.deepStrictEqual(value, {
            verdict: 'PASS', passes: 28, failures: 0, staticPending: 1, gatedPending: 0,
        })
    })

    it('orders failures before gates and gates before a short report', function () {
        const gated = pending('policy venue gate')
        const short = { passes: 2, pending: [gated] }
        assert.strictEqual(judgePolicyDrive(report({ ...short, failures: [failure('breaks', 'bad')] }), staticTitles).verdict, 'FAIL')
        assert.strictEqual(judgePolicyDrive(report(short), staticTitles).verdict, 'GATED')
        assert.strictEqual(judgePolicyDrive(report({ passes: 2 }), staticTitles).verdict, 'SHORT')
    })

    it('accepts a non-negative integer minimum and rejects invalid minima', function () {
        assert.strictEqual(judgePolicyDrive(report({ passes: 0 }), staticTitles, { minPasses: 0 }).verdict, 'PASS')
        assert.throws(() => judgePolicyDrive(report(), staticTitles, { minPasses: -1 }), /non-negative integer/)
        assert.throws(() => judgePolicyDrive(report(), staticTitles, { minPasses: 1.5 }), /non-negative integer/)
    })
})

describe('static policy skip discovery', function () {
    let suiteDir

    beforeEach(function () {
        suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-static-skips-'))
    })

    afterEach(function () {
        fs.rmSync(suiteDir, { recursive: true, force: true })
    })

    it('reads direct test files and keeps the literal prefix before concatenation', function () {
        fs.writeFileSync(path.join(suiteDir, 'one.test.js'), [
            "it.skip('concatenated prefix: ' + detail, function () {})",
            "it.skip(\"second prefix\", function () {})",
            "// it.skip('comment is not a call', function () {})",
        ].join('\n'))
        fs.writeFileSync(path.join(suiteDir, 'not-a-test.js'), "it.skip('ignored', function () {})")
        fs.mkdirSync(path.join(suiteDir, 'nested'))
        fs.writeFileSync(path.join(suiteDir, 'nested', 'nested.test.js'), "it.skip('ignored nested', function () {})")

        assert.deepStrictEqual(staticSkipTitles(suiteDir), ['concatenated prefix: ', 'second prefix'])
    })

    it('finds the seven declared static policy prefixes', function () {
        const titles = staticSkipTitles(POLICY_SUITES)
        const expected = [
            'policy AT1 (below the flag):',
            'policy AT7 (below the flag):',
            'policy AT7 (replay):',
            'policy AT8 (reorg, across nodes):',
            'policy AT10 (gates):',
            'policy AT10 (sentinel):',
            'policy AT10 (ordering asserts):',
        ]
        assert.strictEqual(titles.length, 7)
        for (const prefix of expected) assert.ok(titles.some((title) => title.startsWith(prefix)), prefix)
    })
})

describe('policy full-drive verdict CLI', function () {
    let tempDir

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-full-verdict-'))
    })

    afterEach(function () {
        fs.rmSync(tempDir, { recursive: true, force: true })
    })

    function run (value, args = []) {
        const reportPath = path.join(tempDir, 'report.json')
        if (value !== null) fs.writeFileSync(reportPath, typeof value === 'string' ? value : JSON.stringify(value))
        return spawnSync(process.execPath, [SCRIPT, reportPath, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
    }

    it('uses statuses zero, one, and 64 for pass, verdict failure, and usage failure', function () {
        assert.strictEqual(run(report({ passes: 0 }), ['--min-passes', '0']).status, 0)
        assert.strictEqual(run(report({ passes: 0 })).status, 1)
        assert.strictEqual(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 64)
        assert.strictEqual(run(report(), ['--min-passes', '1', '--min-passes', '2']).status, 64)
        assert.strictEqual(run(report(), ['--unknown', 'x']).status, 64)
    })

    it('prints gated and failed first-line details after the summary', function () {
        const value = report({
            passes: 1,
            pending: [pending('venue case', 'policy suite venue case\nsecond line')],
            failures: [failure('failure', 'first message\nsecond message')],
        })
        const result = run(value, ['--min-passes', '2'])
        assert.strictEqual(result.status, 1)
        assert.strictEqual(result.stderr, '')
        assert.strictEqual(result.stdout, [
            'DRIVE policy FAIL passes=1 failures=1 static=0 gated=1',
            'GATED policy suite venue case',
            'FAILED policy suite failure: first message',
            '',
        ].join('\n'))
    })

    it('returns an unreadable verdict for missing or malformed JSON', function () {
        const malformed = run('{bad json')
        const missing = run(null)
        assert.strictEqual(malformed.status, 1)
        assert.strictEqual(missing.status, 1)
        assert.strictEqual(malformed.stdout, 'DRIVE policy UNREADABLE passes=0 failures=0 static=0 gated=0\n')
        assert.strictEqual(missing.stdout, malformed.stdout)
    })
})
