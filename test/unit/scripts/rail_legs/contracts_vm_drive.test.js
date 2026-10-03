'use strict'

const assert = require('assert')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const { RAIL_DRIVES } = require('../../../helpers/bridge_rail_legs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const DRIVER = path.join(REPO_ROOT, 'scripts', 'rail_leg_drive.js')
const MOCHA = require.resolve('mocha/bin/mocha.js')
delete require.cache[require.resolve(DRIVER)]
const { buildLegCommand } = require(DRIVER)
const DRIVE_ENV = {
    XC_JSON_STRINGIFY_HOOK_EXPECT: 'inert',
}
const LEG_SUITES = {
    json_stringify_hook: ['test/contracts/json_stringify_hook.test.js'],
    custody_guard: [
        'test/rail/custody_guard/deposit.rail.test.js',
        'test/rail/custody_guard/withdraw.rail.test.js',
    ],
    broadcast_fee: ['test/rail/flag_days/broadcast_fee_length.rail.test.js'],
    vm_lint: ['test/rail/vm_lint/optional_chain_deploy.rail.test.js'],
}

function dryRunNonPendingCount(files) {
    const result = spawnSync(process.execPath, [
        MOCHA,
        '--dry-run',
        '--reporter',
        'json',
        ...files,
    ], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...DRIVE_ENV },
    })

    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.strictEqual(report.stats.failures, 0)
    assert.strictEqual(report.stats.tests, report.stats.passes + report.stats.pending)
    return report.stats.tests - report.stats.pending
}

describe('contracts and VM rail drive', function () {
    it('registers as an enumerable drive', function () {
        assert.ok(Object.hasOwn(RAIL_DRIVES, 'contracts_vm'))
        assert.strictEqual(
            Object.getOwnPropertyDescriptor(RAIL_DRIVES, 'contracts_vm').enumerable,
            true
        )
        assert.ok(Object.keys(RAIL_DRIVES).includes('contracts_vm'))
    })

    it('registers every suite as an existing file with a positive dry-run minimum', function () {
        const drive = RAIL_DRIVES.contracts_vm

        assert.ok(drive)
        assert.deepStrictEqual(Object.keys(drive.legs), Object.keys(LEG_SUITES))
        for (const [legName, files] of Object.entries(LEG_SUITES)) {
            const leg = drive.legs[legName]
            assert.deepStrictEqual(leg.files, files)
            assert.ok(Number.isInteger(leg.minPassed), legName + ' minPassed is an integer')
            assert.ok(leg.minPassed > 0, legName + ' minPassed is positive')
            for (const suite of leg.files) {
                assert.ok(fs.existsSync(path.join(REPO_ROOT, suite)), legName + ' ' + suite)
            }
            assert.strictEqual(
                leg.minPassed,
                dryRunNonPendingCount(files),
                legName + ' minPassed matches its Mocha dry run'
            )
        }
    })

    it('passes the JSON stringify expectation to every leg command', function () {
        const drive = RAIL_DRIVES.contracts_vm

        assert.deepStrictEqual(drive.envKeys, Object.keys(DRIVE_ENV))
        for (const [legName, files] of Object.entries(LEG_SUITES)) {
            const command = buildLegCommand('contracts_vm', legName, {
                journalDir: '/tmp/contracts-vm-drive-test',
                repoRoot: REPO_ROOT,
                env: DRIVE_ENV,
            })

            assert.deepStrictEqual(command.argv.slice(-files.length), files)
            assert.strictEqual(
                command.env.XC_JSON_STRINGIFY_HOOK_EXPECT,
                DRIVE_ENV.XC_JSON_STRINGIFY_HOOK_EXPECT
            )
            assert.ok(command.envKeys.includes('XC_JSON_STRINGIFY_HOOK_EXPECT'))
        }
    })
})
