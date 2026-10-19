'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
    captureHeads,
    legDriveArgs,
    main,
    parseArgs,
    readJournal,
    runFullDrive,
} = require('../../../../bin/rail_leg/token_bridge_full_drive')

const DRIVES = { token: { legs: { full: { minPassed: 2 } } }, base: { legs: { full: { minPassed: 1 } } } }

function journal (count, state = 'passed') {
    const lines = []
    for (let i = 0; i < count; i++) {
        lines.push(JSON.stringify({ title: 'case ' + i, state, error: state === 'failed' ? 'boom' : undefined }))
    }
    return lines.join('\n') + '\n'
}

function withTempDir (run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-bridge-full-drive-'))
    try {
        return run(dir)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

// Fake leg drive: writes a journal and a venue log into the --journal-dir it is given.
function fakeLegDrive (journals, calls = []) {
    return (args) => {
        const name = args[1]
        const dir = args[args.indexOf('--journal-dir') + 1]
        calls.push(name)
        fs.writeFileSync(path.join(dir, 'case-journal.jsonl'), journals[name])
        fs.writeFileSync(path.join(dir, 'venue.log'), name + ' venue\n')
        return 0
    }
}

const fakeExec = (command, args) => 'head-' + path.basename(args[1])

describe('token bridge full drive runner', function () {
    it('parses flags and requires --run-dir', function () {
        const options = parseArgs(['--run-dir', '/r', '--date', '2026-01-02', '--limit-minutes', '30'])
        assert.strictEqual(options.runDir, '/r')
        assert.strictEqual(options.date, '2026-01-02')
        assert.strictEqual(options.limitMinutes, '30')
        assert.throws(() => parseArgs([]), /--run-dir is required/)
        assert.throws(() => parseArgs(['--run-dir', '/r', '--bogus', 'x']), /unknown or incomplete/)
        assert.throws(() => parseArgs(['--run-dir', '/r', '--date', 'today']), /YYYY-MM-DD/)
        assert.throws(() => parseArgs(['--run-dir', '/r', '--limit-minutes', '0']), /greater than zero/)
    })

    it('captures heads and falls back to unknown when git fails', function () {
        const options = { platformRoot: '/p', indexerRoot: '/i' }
        const heads = captureHeads(options, fakeExec)
        assert.strictEqual(heads.platform, 'head-p')
        assert.strictEqual(heads.indexer, 'head-i')
        assert.ok(heads.e2eTest.startsWith('head-'))
        const broken = captureHeads(options, () => { throw new Error('no git') })
        assert.deepStrictEqual(broken, { platform: 'unknown', indexer: 'unknown', e2eTest: 'unknown' })
    })

    it('builds leg drive args into a per-drive directory', function () {
        const args = legDriveArgs('base', { runDir: '/r', limitMinutes: '12' })
        assert.deepStrictEqual(args.slice(1), ['base', 'full', '--journal-dir', path.join('/r', 'base'),
            '--limit-minutes', '12'])
        assert.ok(!legDriveArgs('token', { runDir: '/r', limitMinutes: null }).includes('--limit-minutes'))
    })

    it('drives token then base into one run directory and writes the report', function () {
        withTempDir((dir) => {
            const calls = []
            const outcome = runFullDrive(
                { runDir: dir, date: '2026-01-02', platformRoot: '/p', indexerRoot: '/i', limitMinutes: null },
                { runLegDrive: fakeLegDrive({ token: journal(2), base: journal(1) }, calls), exec: fakeExec, drives: DRIVES })

            assert.deepStrictEqual(calls, ['token', 'base'])
            assert.strictEqual(outcome.pass, true)
            assert.ok(fs.existsSync(path.join(dir, 'token', 'venue.log')))
            assert.ok(fs.existsSync(path.join(dir, 'base', 'venue.log')))
            const report = fs.readFileSync(outcome.reportPath, 'utf8')
            assert.match(report, /date: 2026-01-02/)
            assert.match(report, /platform head: head-p/)
            assert.match(report, /token drive: PASS/)
            assert.match(report, /base drive: PASS/)
        })
    })

    it('still drives base after token fails and reports both', function () {
        withTempDir((dir) => {
            const calls = []
            const outcome = runFullDrive(
                { runDir: dir, date: '2026-01-02', platformRoot: '/p', indexerRoot: '/i', limitMinutes: null },
                { runLegDrive: fakeLegDrive({ token: journal(1, 'failed'), base: journal(1) }, calls), exec: fakeExec, drives: DRIVES })

            assert.deepStrictEqual(calls, ['token', 'base'])
            assert.strictEqual(outcome.pass, false)
            const report = fs.readFileSync(outcome.reportPath, 'utf8')
            assert.match(report, /token drive: FAIL/)
            assert.match(report, /base drive: PASS/)
        })
    })

    it('fails a drive that exits nonzero even with a passing journal', function () {
        withTempDir((dir) => {
            const good = fakeLegDrive({ token: journal(2), base: journal(1) })
            const runLegDrive = (args) => (good(args) === 0 && args[1] === 'base' ? 3 : 0)
            const outcome = runFullDrive(
                { runDir: dir, date: '2026-01-02', platformRoot: '/p', indexerRoot: '/i', limitMinutes: null },
                { runLegDrive, exec: fakeExec, drives: DRIVES })
            assert.strictEqual(outcome.pass, false)
            assert.strictEqual(outcome.token.pass, true)
            assert.strictEqual(outcome.base.pass, false)
            assert.match(fs.readFileSync(outcome.reportPath, 'utf8'), /base drive: FAIL/)
        })
    })

    it('ignores stale passing journals from an earlier run', function () {
        withTempDir((dir) => {
            for (const name of ['token', 'base']) {
                fs.mkdirSync(path.join(dir, name), { recursive: true })
                fs.writeFileSync(path.join(dir, name, 'case-journal.jsonl'), journal(2))
            }
            const outcome = runFullDrive(
                { runDir: dir, date: '2026-01-02', platformRoot: '/p', indexerRoot: '/i', limitMinutes: null },
                { runLegDrive: () => 1, exec: fakeExec, drives: DRIVES })
            assert.strictEqual(outcome.pass, false)
            assert.ok(outcome.token.reason.includes('no journal'))
            assert.strictEqual(outcome.base.pass, false)
        })
    })

    it('reads a missing journal as a failed drive', function () {
        withTempDir((dir) => {
            const result = readJournal(dir, 'token', DRIVES)
            assert.strictEqual(result.pass, false)
            assert.strictEqual(result.reason, 'no journal')
        })
    })

    it('main returns 2 on usage error and exit codes from the outcome', function () {
        assert.strictEqual(main([]), 2)
        withTempDir((dir) => {
            const io = { runLegDrive: fakeLegDrive({ token: journal(2), base: journal(1) }), exec: fakeExec, drives: DRIVES }
            assert.strictEqual(main(['--run-dir', path.join(dir, 'ok'), '--date', '2026-01-02'], io), 0)
            const bad = { ...io, runLegDrive: fakeLegDrive({ token: journal(1, 'failed'), base: journal(1) }) }
            assert.strictEqual(main(['--run-dir', path.join(dir, 'bad'), '--date', '2026-01-02'], bad), 1)
        })
    })
})
