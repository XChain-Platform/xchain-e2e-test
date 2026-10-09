'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { triageJournal } = require('../../../../scripts/rail_journal_triage')
const { main, renderDriveReport } = require('../../../../scripts/rail_leg/token_bridge_drive_report')

function journal (count, state = 'passed') {
    const entries = []
    for (let i = 0; i < count; i++) {
        entries.push(JSON.stringify({ title: 'case ' + i, state, error: state === 'failed' ? 'boom' : undefined }))
    }
    return entries.join('\n') + '\n'
}

function result (text, minPassed = 1) {
    return triageJournal(text, { minPassed })
}

function reportInput (overrides = {}) {
    return {
        date: '2026-01-02',
        heads: { platform: 'aaaa111', indexer: 'bbbb222', e2eTest: 'cccc333' },
        token: result(journal(1)),
        base: result(journal(1)),
        ...overrides,
    }
}

function cliArgs (dir, overrides = {}) {
    return [
        '--token-journal', overrides.token || path.join(dir, 'token.jsonl'),
        '--base-journal', overrides.base || path.join(dir, 'base.jsonl'),
        '--platform-head', 'aaaa111',
        '--indexer-head', 'bbbb222',
        '--e2e-head', 'cccc333',
        '--date', '2026-01-02',
        '--out', overrides.out || path.join(dir, 'report.md'),
    ]
}

function withTempDir (run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-bridge-drive-report-'))
    try {
        return run(dir)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

describe('token bridge rail drive report', function () {
    it('renders both drives green with heads, counts and a trailing newline', function () {
        const report = renderDriveReport(reportInput())

        assert.match(report, /^# Token bridge rail drive\n/)
        assert.match(report, /date: 2026-01-02/)
        assert.match(report, /platform head: aaaa111/)
        assert.match(report, /indexer head: bbbb222/)
        assert.match(report, /e2e-test head: cccc333/)
        assert.match(report, /^token drive: PASS$/m)
        assert.match(report, /^base drive: PASS$/m)
        assert.match(report, /token counts: passed=1 failed=0 root=0 cascade=0 other=0 malformed=0/)
        assert.ok(report.endsWith('\n'))
    })

    it('names a token root failure and prints its error', function () {
        const token = result(JSON.stringify({ title: 'token AT3: lock', state: 'failed', error: 'boom\nmore' }) + '\n')
        const report = renderDriveReport(reportInput({ token }))

        assert.match(report, /^token drive: FAIL \(token AT3: lock\)$/m)
        assert.match(report, /^token root failure: token AT3: lock \| boom more$/m)
        assert.doesNotMatch(report, /^token drive: PASS$/m)
        assert.match(report, /^base drive: PASS$/m)
    })

    it('uses the drive reason when it is below minPassed without a root failure', function () {
        const base = result(journal(1), 2)
        const report = renderDriveReport(reportInput({ base }))

        assert.match(report, /^base drive: FAIL \(passed=1 below minPassed=2\)$/m)
        assert.doesNotMatch(report, /^base drive: PASS$/m)
    })

    it('rejects every missing required report field by name', function () {
        const cases = [
            [reportInput({ date: undefined }), /date/],
            [reportInput({ heads: undefined }), /heads/],
            [reportInput({ heads: { platform: '', indexer: 'b', e2eTest: 'c' } }), /heads\.platform/],
            [reportInput({ heads: { platform: 'a', indexer: '', e2eTest: 'c' } }), /heads\.indexer/],
            [reportInput({ heads: { platform: 'a', indexer: 'b', e2eTest: '' } }), /heads\.e2eTest/],
            [reportInput({ token: undefined }), /token/],
            [reportInput({ base: undefined }), /base/],
        ]
        for (const [input, expected] of cases) assert.throws(() => renderDriveReport(input), expected)
    })

    it('writes a passing report and exits 0', function () {
        withTempDir((dir) => {
            fs.writeFileSync(path.join(dir, 'token.jsonl'), journal(28))
            fs.writeFileSync(path.join(dir, 'base.jsonl'), journal(16))

            assert.strictEqual(main(cliArgs(dir)), 0)
            const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8')
            assert.match(report, /^token drive: PASS$/m)
            assert.match(report, /^base drive: PASS$/m)
        })
    })

    it('writes a failed report and exits 1', function () {
        withTempDir((dir) => {
            fs.writeFileSync(path.join(dir, 'token.jsonl'), journal(28))
            fs.writeFileSync(path.join(dir, 'base.jsonl'), journal(1, 'failed'))

            assert.strictEqual(main(cliArgs(dir)), 1)
            const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8')
            assert.match(report, /^base drive: FAIL \(case 0\)$/m)
        })
    })

    it('writes no journal as the first failure and exits 1', function () {
        withTempDir((dir) => {
            fs.writeFileSync(path.join(dir, 'base.jsonl'), journal(16))

            assert.strictEqual(main(cliArgs(dir)), 1)
            const report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8')
            assert.match(report, /^token drive: FAIL \(no journal\)$/m)
            assert.match(report, /^base drive: PASS$/m)
        })
    })

    it('names a missing flag on stderr and exits 2', function () {
        const writes = []
        const write = process.stderr.write
        process.stderr.write = (text) => { writes.push(text); return true }
        try {
            assert.strictEqual(main([]), 2)
        } finally {
            process.stderr.write = write
        }
        assert.match(writes.join(''), /--token-journal is required/)
    })
})
