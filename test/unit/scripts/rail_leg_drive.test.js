'use strict'

const assert = require('assert')
const path = require('path')
const { spawnSync } = require('child_process')
const proxyquire = require('proxyquire')

const { ancestorPids } = require('../../helpers/rail_preflight/rail_drive_processes')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'rail_leg_drive.js')
const POLICY_ROOT = 'test/integration/bridge_rail_policy.test.js'
const POLICY_GLOB = 'test/integration/bridge_rail_policy.test/*.test.js'
const RAIL_DRIVES = {
    policy: {
        root: POLICY_ROOT,
        glob: POLICY_GLOB,
        legs: {
            at1: { grep: 'policy T0:|policy AT1:', minPassed: 5 },
            full: { grep: null, minPassed: 28 },
        },
    },
}
const runner = proxyquire.noCallThru()(SCRIPT, {
    '../test/helpers/bridge_rail_legs': { RAIL_DRIVES },
})

function build (leg, extra = {}) {
    return runner.buildLegCommand('policy', leg, {
        journalDir: '/tmp/rail-leg-drive-test',
        repoRoot: REPO_ROOT,
        env: {},
        ...extra,
    })
}

function runCli (args, psText, env = {}) {
    const source = [
        "const Module = require('module')",
        "const childProcess = require('child_process')",
        'const RAIL_DRIVES = ' + JSON.stringify(RAIL_DRIVES),
        'const psText = ' + JSON.stringify(psText),
        'const script = ' + JSON.stringify(SCRIPT),
        'const originalLoad = Module._load',
        'Module._load = function (request, parent, isMain) {',
        "  if (request === '../test/helpers/bridge_rail_legs') return { RAIL_DRIVES }",
        "  if (request === 'child_process' && parent && parent.filename === script) {",
        '    return { execFileSync: () => psText, spawn: childProcess.spawn }',
        '  }',
        '  return originalLoad.call(this, request, parent, isMain)',
        '}',
        'process.argv = [process.execPath, script, ...' + JSON.stringify(args) + ']',
        'Module._load(script, null, true)',
    ].join('\n')
    return spawnSync(process.execPath, ['-e', source], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...env },
    })
}

describe('bridge rail leg drive command', function () {
    it('places a policy leg grep before the root and glob', function () {
        const command = build('at1')
        const grepAt = command.argv.indexOf('--grep')
        const rootAt = command.argv.indexOf(POLICY_ROOT)
        const globAt = command.argv.indexOf(POLICY_GLOB)

        assert.ok(grepAt >= 0)
        assert.strictEqual(command.argv[grepAt + 1], RAIL_DRIVES.policy.legs.at1.grep)
        assert.ok(rootAt > grepAt)
        assert.ok(globAt > rootAt)
    })

    it('leaves grep out of the full leg command', function () {
        const command = build('full')

        assert.strictEqual(command.argv.includes('--grep'), false)
        assert.ok(command.argv.indexOf(POLICY_ROOT) < command.argv.indexOf(POLICY_GLOB))
    })

    it('sets journal destinations and drops idle generation', function () {
        const command = build('at1', {
            env: { XC_ROLLCALL_IDLE_GENERATION: '1', KEEP_ME: 'yes' },
        })

        assert.strictEqual(command.env.ATTEST_VENUE_LOG_DIR, '/tmp/rail-leg-drive-test')
        assert.strictEqual(command.env.BRIDGE_RAIL_JOURNAL_DIR, '/tmp/rail-leg-drive-test')
        assert.strictEqual(command.env.COIN, 'bitcoin')
        assert.strictEqual(command.env.NETWORK, 'regtest')
        assert.strictEqual(command.env.XC_ROLLCALL_IDLE_GENERATION, undefined)
        assert.strictEqual(command.env.KEEP_ME, 'yes')
    })

    it('throws an error naming an unknown leg', function () {
        assert.throws(() => build('missing'), /unknown policy bridge rail leg: missing/)
    })
})

describe('bridge rail overlap detection', function () {
    it('finds a foreign mocha rail process only', function () {
        const psText = [
            ' 101 node ./node_modules/.bin/mocha test/integration/bridge_rail_policy.test.js',
            ' 202 node ./node_modules/.bin/mocha test/integration/bridge_rail_token.test.js',
            ' 303 node scripts/bridge_rail_policy.test.js',
            ' 404 node ./node_modules/.bin/mocha test/integration/ordinary.test.js',
        ].join('\n')

        assert.deepStrictEqual(runner.otherRailDrives(psText, [202]), [{
            pid: 101,
            args: 'node ./node_modules/.bin/mocha test/integration/bridge_rail_policy.test.js',
        }])
    })
})

describe('bridge rail overlap detection over the process tree', function () {
    it('counts only a foreign node-executed rail drive', function () {
        const psText = [
            ' 1 0 /sbin/init',
            ' 500 1 sshd: rail@notty',
            ' 501 500 bash -c while pgrep -f ^node.*mocha.*bridge_rail_ >/dev/null; do sleep 60; done; env A=1 ./node_modules/.bin/mocha --timeout 0 test/integration/bridge_rail_token.test.js',
            ' 502 501 npm exec mocha --timeout 0 test/integration/bridge_rail_token.test.js',
            ' 503 502 sh -c mocha --timeout 0 test/integration/bridge_rail_token.test.js',
            ' 504 503 node ./node_modules/.bin/mocha --timeout 0 test/integration/bridge_rail_token.test.js',
            ' 600 1 bash -c while pgrep -f mocha.*bridge_rail_ >/dev/null; do sleep 60; done; ./node_modules/.bin/mocha test/integration/bridge_rail_policy.test.js',
            ' 601 600 sleep 60',
            ' 602 600 pgrep -c -f mocha.*bridge_rail_',
            ' 700 1 node ./node_modules/.bin/mocha --timeout 0 test/integration/bridge_rail_policy.test.js',
        ].join('\n')
        const ownPids = ancestorPids(psText, 504)

        assert.deepStrictEqual(ownPids, [504, 503, 502, 501, 500, 1])
        assert.deepStrictEqual(runner.otherRailDrives(psText, ownPids), [{
            pid: 700,
            args: 'node ./node_modules/.bin/mocha --timeout 0 test/integration/bridge_rail_policy.test.js',
        }])
    })
})

describe('bridge rail leg drive CLI', function () {
    it('refuses a competing drive with exit two and its pid', function () {
        const result = runCli([
            'policy', 'at1', '--journal-dir', '/tmp/rail-leg-dry-run', '--dry-run',
        ], ' 919191 node mocha test/integration/bridge_rail_policy.test.js')

        assert.strictEqual(result.status, 2, result.stdout + result.stderr)
        assert.match(result.stderr, /pid 919191/)
    })

    it('does not print inherited secret values in a dry run', function () {
        const result = runCli([
            'policy', 'at1', '--journal-dir', '/tmp/rail-leg-dry-run', '--dry-run',
        ], '', { HUB_DB_PASS: 'stub-password-that-must-not-print' })
        const output = result.stdout + result.stderr

        assert.strictEqual(result.status, 0, output)
        assert.match(result.stdout, /mocha argv:/)
        assert.match(result.stdout, /env keys set:/)
        assert.doesNotMatch(output, /stub-password-that-must-not-print/)
    })
})
