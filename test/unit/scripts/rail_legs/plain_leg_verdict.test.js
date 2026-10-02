'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'rail_leg_drive.js')
const RAIL_DRIVES = {
    plain: {
        legs: {
            passing: { files: ['unused-passing.test.js'], minPassed: 2 },
            failing: { files: ['unused-failing.test.js'], minPassed: 1 },
            with_env: {
                files: ['unused-env.test.js'],
                minPassed: 1,
                env: { PLAIN_LEG_MARKER: 'from-leg' },
            },
        },
    },
    rooted: {
        root: 'unused-root.test.js',
        glob: 'unused-root.test/*.test.js',
        legs: { full: { grep: null, minPassed: 1 } },
    },
}

function report (passes, failures, pending = 0) {
    return {
        stats: { passes, failures: failures.length, pending },
        tests: [],
        pending: [],
        failures,
        passes: [],
    }
}

function runCli (drive, leg, journalDir, mochaReport, capturePath) {
    const source = [
        "const Module = require('module')",
        "const fs = require('fs')",
        "const EventEmitter = require('events')",
        'const RAIL_DRIVES = ' + JSON.stringify(RAIL_DRIVES),
        'const mochaReport = ' + JSON.stringify(mochaReport),
        'const capturePath = ' + JSON.stringify(capturePath || ''),
        'const script = ' + JSON.stringify(SCRIPT),
        'const originalLoad = Module._load',
        'Module._load = function (request, parent, isMain) {',
        "  if (request === '../test/helpers/bridge_rail_legs') return { RAIL_DRIVES }",
        "  if (request === 'child_process' && parent && parent.filename === script) {",
        '    return {',
        "      execFileSync: () => '',",
        '      spawn: (command, argv, options) => {',
        '        if (capturePath) fs.writeFileSync(capturePath, options.env.PLAIN_LEG_MARKER || "")',
        '        const reporterAt = argv.indexOf("--reporter")',
        '        if (argv[reporterAt + 1] === "json" && typeof options.stdio[1] === "number") {',
        '          fs.writeSync(options.stdio[1], JSON.stringify(mochaReport, null, 2))',
        '        }',
        '        const child = new EventEmitter()',
        '        child.kill = () => {}',
        '        process.nextTick(() => child.emit("close", mochaReport.stats.failures ? 1 : 0, null))',
        '        return child',
        '      },',
        '    }',
        '  }',
        '  return originalLoad.call(this, request, parent, isMain)',
        '}',
        'process.argv = [process.execPath, script, ' + JSON.stringify(drive) + ', ' +
            JSON.stringify(leg) + ', "--journal-dir", ' + JSON.stringify(journalDir) + ']',
        'Module._load(script, null, true)',
    ].join('\n')
    return spawnSync(process.execPath, ['-e', source], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: process.env,
    })
}

describe('plain rail leg verdict', function () {
    let journalDir

    beforeEach(function () {
        journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-leg-verdict-'))
    })

    afterEach(function () {
        fs.rmSync(journalDir, { recursive: true, force: true })
    })

    it('passes from the mocha report without a case journal at minPassed', function () {
        const result = runCli('plain', 'passing', journalDir, report(2, []))

        assert.strictEqual(result.status, 0, result.stdout + result.stderr)
        assert.match(result.stdout, /triage: passed=2 failed=0 pending=0/)
        assert.match(result.stdout, /VERDICT PASS/)
        assert.strictEqual(fs.existsSync(path.join(journalDir, 'case-journal.jsonl')), false)
        assert.strictEqual(fs.existsSync(path.join(journalDir, 'mocha-report.json')), true)
    })

    it('fails when the mocha report contains a failing case', function () {
        const failures = [{ fullTitle: 'plain case fails', err: { message: 'intentional' } }]
        const result = runCli('plain', 'failing', journalDir, report(1, failures))

        assert.strictEqual(result.status, 1, result.stdout + result.stderr)
        assert.match(result.stdout, /case failure: plain case fails error=intentional/)
        assert.match(result.stdout, /VERDICT FAIL 1 failed case\(s\)/)
    })

    it('still fails a root and glob leg without a case journal', function () {
        const result = runCli('rooted', 'full', journalDir, report(1, []))

        assert.strictEqual(result.status, 1, result.stdout + result.stderr)
        assert.match(result.stdout, /VERDICT FAIL no journal at/)
        assert.strictEqual(fs.existsSync(path.join(journalDir, 'mocha-report.json')), false)
    })

    it('passes leg environment values to the child', function () {
        const capturePath = path.join(journalDir, 'child-env.txt')
        const result = runCli('plain', 'with_env', journalDir, report(1, []), capturePath)

        assert.strictEqual(result.status, 0, result.stdout + result.stderr)
        assert.strictEqual(fs.readFileSync(capturePath, 'utf8'), 'from-leg')
    })
})
