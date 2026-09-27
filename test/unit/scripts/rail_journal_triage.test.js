'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const os = require('os')
const path = require('path')

const { triageJournal } = require('../../../scripts/rail_journal_triage')
const script = path.join(__dirname, '..', '..', '..', 'scripts', 'rail_journal_triage.js')

function line (entry) {
    return JSON.stringify(entry)
}

describe('rail journal triage classification', function () {
    it('keeps only the last entry for a rerun title', function () {
        const result = triageJournal([
            line({ title: 'retries cleanly', state: 'failed', durationMs: 20, error: 'first run' }),
            line({ title: 'retries cleanly', state: 'passed', durationMs: 10 }),
        ].join('\n'), { minPassed: 1 })

        assert.strictEqual(result.passed, 1)
        assert.strictEqual(result.failed, 0)
        assert.strictEqual(result.pass, true)
    })

    it('splits cascade failures from root failures', function () {
        const result = triageJournal([
            line({ title: 'setup breaks', state: 'failed', durationMs: 8, error: 'socket closed' }),
            line({ title: 'dependent case', state: 'failed', durationMs: 1,
                error: 'setup must have run before this case' }),
            line({ title: 'pending case', state: 'skipped', durationMs: 0 }),
        ].join('\n'), { minPassed: 0 })

        assert.strictEqual(result.failed, 2)
        assert.strictEqual(result.root, 1)
        assert.strictEqual(result.cascade, 1)
        assert.strictEqual(result.other, 1)
        assert.deepStrictEqual(result.rootFailures.map((entry) => entry.title), ['setup breaks'])
    })

    it('counts and skips blank and malformed lines', function () {
        const result = triageJournal([
            line({ title: 'valid case', state: 'passed', durationMs: 3 }),
            '',
            '{not json',
        ].join('\n'), { minPassed: 1 })

        assert.strictEqual(result.malformed, 2)
        assert.strictEqual(result.passed, 1)
        assert.strictEqual(result.other, 0)
    })
})

describe('rail journal triage verdicts', function () {
    it('passes at minPassed and fails one below it', function () {
        const text = [
            line({ title: 'one', state: 'passed', durationMs: 1 }),
            line({ title: 'two', state: 'passed', durationMs: 1 }),
        ].join('\n')

        assert.strictEqual(triageJournal(text, { minPassed: 2 }).pass, true)
        assert.strictEqual(triageJournal(text, { minPassed: 3 }).pass, false)
    })

    it('fails on any failure even above minPassed', function () {
        const text = [
            line({ title: 'one', state: 'passed', durationMs: 1 }),
            line({ title: 'two', state: 'passed', durationMs: 1 }),
            line({ title: 'root', state: 'failed', durationMs: 2, error: 'broke' }),
        ].join('\n')

        const result = triageJournal(text, { minPassed: 1 })
        assert.strictEqual(result.passed, 2)
        assert.strictEqual(result.pass, false)
    })

    it('exits one and names a missing journal', function () {
        const missing = path.join(os.tmpdir(), 'rail-journal-missing-' + process.pid + '.jsonl')
        const result = childProcess.spawnSync(process.execPath, [script, missing], { encoding: 'utf8' })

        assert.strictEqual(result.status, 1)
        assert.strictEqual(result.stdout.trim(), 'VERDICT FAIL no journal at ' + missing)
    })
})
