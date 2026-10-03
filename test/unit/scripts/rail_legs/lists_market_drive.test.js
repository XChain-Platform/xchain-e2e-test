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
    XC_LISTS_MARKET_REGTEST_ACTIVATION: '701',
    XC_LISTS_MARKET_REGTEST_TIME: '702',
}
const LEG_SUITES = {
    list: ['test/actions/list.test.js'],
    order: [
        'test/actions/order.test.js',
        'test/actions/order.test/02_v1_cancel.test.js',
        'test/actions/order.test/03_match_full_exchange.test.js',
        'test/actions/order.test/04_match_repeating_decimal_price.test.js',
        'test/actions/order.test/05_match_partial_fill.test.js',
        'test/actions/order.test/06_match_high_precision_decimals.test.js',
        'test/actions/order.test/07_v2_edit.test.js',
    ],
    swap: [
        'test/actions/swap.test.js',
        'test/actions/swap.test/02_v1_cancel.test.js',
        'test/actions/swap.test/03_match_full_exchange.test.js',
        'test/actions/swap.test/04_v2_edit.test.js',
    ],
    dispenser: [
        'test/actions/dispenser.test.js',
        'test/actions/dispenser.test/01_v0_fiat_mode_1_validator_price_oracle.test.js',
        'test/actions/dispenser.test/02_v0_fiat_mode_2_user_oracle_price_v1_cross_conversion.test.js',
        'test/actions/dispenser.test/03_v0_fiat_mode_2_user_oracle_price_v1_per_token.test.js',
        'test/actions/dispenser.test/04_v0_fiat_mode_2_user_oracle_price_v1_oracle_fee.test.js',
        'test/actions/dispenser.test/05_v0_fiat_mode_2_user_oracle_price_v1_price_window.test.js',
        'test/actions/dispenser.test/06_v0_fiat_mode_2_user_oracle_price_v1_activation_delay.test.js',
        'test/actions/dispenser.test/07_v0_fiat_mode_2_user_oracle_price_v1_no_quote.test.js',
        'test/actions/dispenser.test/08_v1_cancel.test.js',
        'test/actions/dispenser.test/09_v2_edit.test.js',
    ],
    callback: ['test/actions/callback.test.js'],
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

describe('lists and market rail drive', function () {
    it('registers as an enumerable drive', function () {
        assert.ok(Object.hasOwn(RAIL_DRIVES, 'lists_market'))
        assert.strictEqual(
            Object.getOwnPropertyDescriptor(RAIL_DRIVES, 'lists_market').enumerable,
            true
        )
        assert.ok(Object.keys(RAIL_DRIVES).includes('lists_market'))
    })

    it('registers every suite as an existing file with a positive dry-run minimum', function () {
        const drive = RAIL_DRIVES.lists_market

        assert.ok(drive)
        assert.deepStrictEqual(Object.keys(drive.legs), Object.keys(LEG_SUITES))
        assert.deepStrictEqual(drive.legs.order.files, RAIL_DRIVES.contracts_price.legs.order.files)
        assert.deepStrictEqual(
            drive.legs.dispenser.files,
            RAIL_DRIVES.contracts_price.legs.dispenser.files
        )
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

    it('passes both drive environment keys to every leg command', function () {
        const drive = RAIL_DRIVES.lists_market

        assert.deepStrictEqual(drive.envKeys, Object.keys(DRIVE_ENV))
        for (const [legName, files] of Object.entries(LEG_SUITES)) {
            const command = buildLegCommand('lists_market', legName, {
                journalDir: '/tmp/lists-market-drive-test',
                repoRoot: REPO_ROOT,
                env: DRIVE_ENV,
            })

            assert.deepStrictEqual(command.argv.slice(-files.length), files)
            for (const [envName, value] of Object.entries(DRIVE_ENV)) {
                assert.strictEqual(command.env[envName], value, legName + ' ' + envName)
                assert.ok(command.envKeys.includes(envName), legName + ' reports ' + envName)
            }
        }
    })
})
