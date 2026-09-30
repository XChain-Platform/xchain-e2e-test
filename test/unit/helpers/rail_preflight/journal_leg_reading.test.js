'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const {
    readJournalLeg,
} = require('../../../helpers/rail_preflight/journal_leg_reading')

const SCRIPT = path.resolve(__dirname, '../../../helpers/rail_preflight/journal_leg_reading.js')
const SECRET = ['password', 'not-a-real-secret'].join('=')
const DRIVES = {
    token: {
        legs: {
            at1: { grep: 'token T0:|token AT1:', minPassed: 3 },
            at2: { grep: 'token T0:|token AT2:', minPassed: 3 },
            missing: { grep: 'token AT3:', minPassed: 4 },
            full: { grep: null, minPassed: 6 },
        },
    },
}

function entry (title, state, error, durationMs) {
    return JSON.stringify({ title, state, error, durationMs })
}

describe('journal leg reading', function () {
    it('uses the last result when a failed title passes on a rerun', function () {
        const journal = [
            entry('token AT1: rerun', 'failed', 'first failure', 10),
            entry('token AT1: rerun', 'passed', undefined, 11),
            entry('token T0: one', 'passed', undefined, 12),
            entry('token T0: two', 'passed', undefined, 13),
        ].join('\n')
        const reading = readJournalLeg(journal, 'token', 'at1', DRIVES)
        assert.deepStrictEqual(reading.line, {
            drive: 'token', leg: 'at1', verdict: 'PASS',
            passed: 3, failed: 0, root: 0, cascade: 0, missing: 0,
        })
        assert.strictEqual(reading.clean, true)
        assert.deepStrictEqual(reading.rootFailures, [])
    })

    it('counts must-have-run failures as cascade failures only', function () {
        const journal = entry('token AT1: blocked', 'failed',
            'dependency must have run before this case', 21)
        const reading = readJournalLeg(journal, 'token', 'at1', DRIVES)
        assert.strictEqual(reading.line.failed, 1)
        assert.strictEqual(reading.line.root, 0)
        assert.strictEqual(reading.line.cascade, 1)
        assert.strictEqual(reading.clean, true)
        assert.deepStrictEqual(reading.rootFailures, [])
    })

    it('shares a matching token T0 title across matching legs', function () {
        const journal = entry('token T0: shared setup', 'failed', 'setup failed', 31)
        const at1 = readJournalLeg(journal, 'token', 'at1', DRIVES)
        const at2 = readJournalLeg(journal, 'token', 'at2', DRIVES)
        assert.deepStrictEqual(at1.rootFailures, [
            { title: 'token T0: shared setup', durationMs: 31 },
        ])
        assert.deepStrictEqual(at2.rootFailures, at1.rootFailures)
    })

    it('keeps every parseable entry for the full leg', function () {
        const journal = [
            entry('token AT1: one', 'passed', undefined, 41),
            entry('unrelated title', 'passed', undefined, 42),
            entry('another title', 'failed', 'root cause', 43),
        ].join('\n')
        const reading = readJournalLeg(journal, 'token', 'full', DRIVES)
        assert.strictEqual(reading.line.passed, 2)
        assert.strictEqual(reading.line.failed, 1)
        assert.deepStrictEqual(reading.rootFailures, [
            { title: 'another title', durationMs: 43 },
        ])
    })

    it('counts missing cases when too few matching cases ran', function () {
        const journal = [
            entry('token AT3: one', 'passed', undefined, 51),
            entry('token AT3: two', 'failed', 'root cause', 52),
        ].join('\n')
        const reading = readJournalLeg(journal, 'token', 'missing', DRIVES)
        assert.strictEqual(reading.line.verdict, 'FAIL')
        assert.strictEqual(reading.line.missing, 2)
    })

    it('ignores malformed lines', function () {
        const journal = [
            '{not json',
            entry('token AT3: valid', 'passed', undefined, 61),
        ].join('\n')
        const reading = readJournalLeg(journal, 'token', 'missing', DRIVES)
        assert.strictEqual(reading.line.passed, 1)
        assert.strictEqual(reading.line.missing, 3)
    })

    it('returns an absent reading when no title matches', function () {
        const journal = entry('token AT2: only', 'passed', undefined, 71)
        assert.deepStrictEqual(readJournalLeg(journal, 'token', 'missing', DRIVES), {
            line: null,
            clean: false,
            rootFailures: [],
        })
    })

    it('throws with the name of an unknown leg', function () {
        assert.throws(
            () => readJournalLeg('', 'token', 'not_there', DRIVES),
            /unknown token bridge rail leg: not_there/
        )
    })
})

describe('journal leg reading CLI', function () {
    let tempDir
    let journalPath
    let journal

    beforeEach(function () {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-leg-reading-'))
        journalPath = path.join(tempDir, 'journal.jsonl')
        journal = entry('token AT3: root failure', 'failed', SECRET, 81)
        fs.writeFileSync(journalPath, journal)
    })

    afterEach(function () {
        fs.rmSync(tempDir, { recursive: true, force: true })
    })

    function run (args, input) {
        return spawnSync(process.execPath, [SCRIPT, ...args], {
            encoding: 'utf8',
            input,
        })
    }

    it('exits zero for a file reading and never prints the failure error', function () {
        const result = run(['--journal', journalPath, '--drive', 'token',
            '--leg', 'at3_at4'])
        assert.strictEqual(result.status, 0)
        assert.strictEqual(result.stdout,
            'LEG token at3_at4 FAIL passed=0 failed=1 root=1 cascade=0 missing=9\n' +
            'ROOT token AT3: root failure durationMs=81\nCLEAN no\n')
        assert.strictEqual(result.stderr, '')
        assert.ok(!(result.stdout + result.stderr).includes(SECRET))
    })

    it('exits one for an absent stdin reading', function () {
        const result = run(['--journal', '-', '--drive', 'token', '--leg', 'at7_at8'],
            journal)
        assert.strictEqual(result.status, 1)
        assert.strictEqual(result.stdout, 'LEG token at7_at8 ABSENT\nCLEAN no\n')
        assert.strictEqual(result.stderr, '')
        assert.ok(!(result.stdout + result.stderr).includes(SECRET))
    })

    it('exits two for invalid arguments', function () {
        const result = run([])
        assert.strictEqual(result.status, 2)
        assert.strictEqual(result.stdout, '')
        assert.ok(!result.stderr.includes(SECRET))
    })

    it('exits two for an unreadable journal', function () {
        const result = run(['--journal', path.join(tempDir, 'missing.jsonl'),
            '--drive', 'token', '--leg', 'full'])
        assert.strictEqual(result.status, 2)
        assert.strictEqual(result.stdout, '')
        assert.strictEqual(result.stderr, 'cannot read journal\n')
    })
})
