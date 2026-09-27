'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
    parseSweepReport,
    readSweepLeg,
} = require('../../../helpers/rail_preflight/sweep_leg_reading')

const SCRIPT = path.resolve(__dirname, '../../../helpers/rail_preflight/sweep_leg_reading.js')
const SECRET = ['password', 'not-a-real-secret'].join('=')
const DRIVES = {
    policy: {
        legs: {
            at1: { grep: 'shared T0:|policy AT1:' },
            at2: { grep: 'shared T0:|policy AT2:' },
            rooted: { grep: 'policy rooted:' },
            missing: { grep: 'policy missing:' },
            full: { grep: null },
        },
    },
    token: { legs: { at1: { grep: 'shared T0:|token AT1:' }, full: { grep: null } } },
}

const REPORT = [
    'LEG policy at1 PASS passed=5 failed=0 root=0 cascade=0 missing=0',
    'LEG policy at2 FAIL passed=5 failed=1 root=0 cascade=1 missing=0',
    'LEG policy rooted FAIL passed=4 failed=1 root=1 cascade=0 missing=0',
    'LEG policy missing FAIL passed=4 failed=0 root=0 cascade=0 missing=2',
    '## token',
    'root failure: shared T0: token-only durationMs=8 error=token failure',
    '## policy',
    'root failure: shared T0: setup durationMs=11 error=setup failure',
    'root failure: policy AT1: unique durationMs=12 error=unique failure',
    'root failure: unrelated title durationMs=13 error=unrelated failure',
    'SWEEP legs=4 pass=1 fail=3',
].join('\n')

describe('sweep report leg reading', function () {
    it('parses leg and sweep counts as numbers', function () {
        const parsed = parseSweepReport(REPORT)
        assert.deepStrictEqual(parsed.legs[0], {
            drive: 'policy', leg: 'at1', verdict: 'PASS',
            passed: 5, failed: 0, root: 0, cascade: 0, missing: 0,
        })
        assert.deepStrictEqual(parsed.sweep, { legs: 4, pass: 1, fail: 3 })
    })

    it('reads a PASS leg as clean', function () {
        assert.strictEqual(readSweepLeg(REPORT, 'policy', 'at1', DRIVES).clean, true)
    })

    it('reads a root-free FAIL with a cascade as clean', function () {
        assert.strictEqual(readSweepLeg(REPORT, 'policy', 'at2', DRIVES).clean, true)
    })

    it('reads a FAIL with a root failure as not clean', function () {
        assert.strictEqual(readSweepLeg(REPORT, 'policy', 'rooted', DRIVES).clean, false)
    })

    it('reads a FAIL with no failures and missing cases as not clean', function () {
        assert.strictEqual(readSweepLeg(REPORT, 'policy', 'missing', DRIVES).clean, false)
    })

    it('keeps root failures within their drive heading', function () {
        const reading = readSweepLeg(REPORT, 'policy', 'at1', DRIVES)
        assert.deepStrictEqual(reading.rootFailures.map((entry) => entry.title), [
            'shared T0: setup',
            'policy AT1: unique',
        ])
    })

    it('shares a matching T0 root failure across matching legs', function () {
        const at1 = readSweepLeg(REPORT, 'policy', 'at1', DRIVES)
        const at2 = readSweepLeg(REPORT, 'policy', 'at2', DRIVES)
        assert.ok(at1.rootFailures.some((entry) => entry.title === 'shared T0: setup'))
        assert.ok(at2.rootFailures.some((entry) => entry.title === 'shared T0: setup'))
    })

    it('keeps every root failure for the full leg', function () {
        const reading = readSweepLeg(REPORT, 'policy', 'full', DRIVES)
        assert.strictEqual(reading.rootFailures.length, 3)
    })

    it('uses the last LEG line when the same leg repeats', function () {
        const repeated = REPORT + '\n' +
            'LEG policy at1 FAIL passed=4 failed=1 root=1 cascade=0 missing=0\n'
        const reading = readSweepLeg(repeated, 'policy', 'at1', DRIVES)
        assert.strictEqual(reading.line.verdict, 'FAIL')
        assert.strictEqual(reading.clean, false)
    })

    it('returns a null line for an absent leg', function () {
        assert.strictEqual(readSweepLeg(REPORT, 'policy', 'full', DRIVES).line, null)
    })

    it('throws with the name of an unknown leg', function () {
        assert.throws(
            () => readSweepLeg(REPORT, 'policy', 'not_there', DRIVES),
            /unknown policy bridge rail leg: not_there/
        )
    })

    it('throws with the name of an unknown drive', function () {
        assert.throws(
            () => readSweepLeg(REPORT, 'not_there', 'at1', DRIVES),
            /unknown bridge rail drive: not_there/
        )
    })
})

describe('sweep report leg reading CLI', function () {
    let tempDir
    let reportPath

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-leg-reading-'))
        reportPath = path.join(tempDir, 'report.md')
        fs.writeFileSync(reportPath, [
            'LEG policy at1 PASS passed=05 failed=0 root=0 cascade=0 missing=0',
            '## policy',
            'root failure: policy T0: setup durationMs=21 ' +
                'error=' + SECRET + ' durationMs=999 error=secondary',
            'SWEEP legs=1 pass=1 fail=0',
        ].join('\n'))
    })

    afterEach(function () {
        fs.rmSync(tempDir, { recursive: true, force: true })
    })

    function run (args) {
        return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    }

    it('exits zero for a present reading without printing error text', function () {
        const result = run(['--report', reportPath, '--drive', 'policy', '--leg', 'at1'])
        assert.strictEqual(result.status, 0)
        assert.strictEqual(result.stdout,
            'LEG policy at1 PASS passed=05 failed=0 root=0 cascade=0 missing=0\n' +
            'ROOT policy T0: setup durationMs=21\nCLEAN yes\n')
        assert.strictEqual(result.stderr, '')
        assert.doesNotMatch(result.stdout + result.stderr, /error=/)
        assert.ok(!(result.stdout + result.stderr).includes(SECRET))
    })

    it('exits one and prints ABSENT for a missing reading', function () {
        const result = run(['--report', reportPath, '--drive', 'policy', '--leg', 'full'])
        assert.strictEqual(result.status, 1)
        assert.strictEqual(result.stdout,
            'LEG policy full ABSENT\nROOT policy T0: setup durationMs=21\nCLEAN no\n')
        assert.strictEqual(result.stderr, '')
    })

    it('exits two for invalid arguments', function () {
        const result = run([])
        assert.strictEqual(result.status, 2)
        assert.strictEqual(result.stdout, '')
        assert.ok(!result.stderr.includes(SECRET))
    })
})
