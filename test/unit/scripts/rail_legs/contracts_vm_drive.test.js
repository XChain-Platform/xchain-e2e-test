'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const { RAIL_DRIVES } = require('../../../helpers/bridge_rail_legs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const DRIVER = path.join(REPO_ROOT, 'scripts', 'rail_leg_drive.js')
delete require.cache[require.resolve(DRIVER)]
const { buildLegCommand } = require(DRIVER)
const DRIVE_ENV = {
    XC_JSON_STRINGIFY_HOOK_EXPECT: 'inert',
}
const LEG_SUITES = {
    json_stringify_hook: {
        files: ['test/contracts/json_stringify_hook.test.js'],
        minPassed: 4,
    },
    custody_guard: {
        files: [
            'test/rail/custody_guard/deposit.rail.test.js',
            'test/rail/custody_guard/withdraw.rail.test.js',
        ],
        minPassed: 5,
    },
    broadcast_fee: {
        files: ['test/rail/flag_days/broadcast_fee_length.rail.test.js'],
        minPassed: 3,
    },
    vm_lint: {
        files: ['test/rail/vm_lint/optional_chain_deploy.rail.test.js'],
        minPassed: 2,
    },
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
        for (const [legName, expected] of Object.entries(LEG_SUITES)) {
            const leg = drive.legs[legName]
            assert.deepStrictEqual(leg.files, expected.files)
            assert.strictEqual(leg.minPassed, expected.minPassed)
            assert.ok(Number.isInteger(leg.minPassed), legName + ' minPassed is an integer')
            assert.ok(leg.minPassed > 0, legName + ' minPassed is positive')
            for (const suite of leg.files) {
                assert.ok(fs.existsSync(path.join(REPO_ROOT, suite)), legName + ' ' + suite)
            }
        }
    })

    it('passes the JSON stringify expectation to every leg command', function () {
        const drive = RAIL_DRIVES.contracts_vm

        assert.deepStrictEqual(drive.envKeys, Object.keys(DRIVE_ENV))
        for (const [legName, expected] of Object.entries(LEG_SUITES)) {
            const command = buildLegCommand('contracts_vm', legName, {
                journalDir: '/tmp/contracts-vm-drive-test',
                repoRoot: REPO_ROOT,
                env: DRIVE_ENV,
            })

            assert.deepStrictEqual(command.argv.slice(-expected.files.length), expected.files)
            assert.strictEqual(
                command.env.XC_JSON_STRINGIFY_HOOK_EXPECT,
                DRIVE_ENV.XC_JSON_STRINGIFY_HOOK_EXPECT
            )
            assert.ok(command.envKeys.includes('XC_JSON_STRINGIFY_HOOK_EXPECT'))
        }
    })
})
