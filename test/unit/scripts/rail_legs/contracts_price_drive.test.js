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
    XC_AMOUNTS_PRICE_REGTEST_ACTIVATION: '701',
    XC_AMOUNTS_PRICE_REGTEST_TIME: '702',
    XC_CONTRACTS_REGTEST_ACTIVATION: '703',
    XC_E2E_PRICE_FEE_BATCH_LANDED: '704',
    XC_VOTE_CALLBACK_BINDING_EXPECT: 'legacy',
}
const LEG_SUITES = {
    dispenser: {
        files: [
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
        minPassed: 13,
    },
    order: {
        files: [
            'test/actions/order.test.js',
            'test/actions/order.test/02_v1_cancel.test.js',
            'test/actions/order.test/03_match_full_exchange.test.js',
            'test/actions/order.test/04_match_repeating_decimal_price.test.js',
            'test/actions/order.test/05_match_partial_fill.test.js',
            'test/actions/order.test/06_match_high_precision_decimals.test.js',
            'test/actions/order.test/07_v2_edit.test.js',
        ],
        minPassed: 7,
    },
    price: {
        files: [
            'test/actions/price.test.js',
            'test/actions/price.test/02_invalid_quotes.test.js',
        ],
        minPassed: 7,
    },
    vote_binding: {
        files: ['test/rail/vote_binding/usable_method.test.js'],
        minPassed: 2,
    },
}

describe('contracts and price rail drive', function () {
    it('registers as an enumerable drive', function () {
        assert.ok(Object.hasOwn(RAIL_DRIVES, 'contracts_price'))
        assert.strictEqual(
            Object.getOwnPropertyDescriptor(RAIL_DRIVES, 'contracts_price').enumerable,
            true
        )
        assert.ok(Object.keys(RAIL_DRIVES).includes('contracts_price'))
    })

    it('registers every suite as an existing file with its dry-run minimum', function () {
        this.timeout(30000)

        const drive = RAIL_DRIVES.contracts_price

        assert.ok(drive)
        assert.deepStrictEqual(Object.keys(drive.legs), Object.keys(LEG_SUITES))
        for (const [legName, expected] of Object.entries(LEG_SUITES)) {
            const leg = drive.legs[legName]
            assert.deepStrictEqual(leg.files, expected.files)
            assert.strictEqual(leg.minPassed, expected.minPassed)
            for (const suite of leg.files) {
                assert.ok(fs.existsSync(path.join(REPO_ROOT, suite)), legName + ' ' + suite)
            }
        }
    })

    it('passes all five drive environment keys to every leg command', function () {
        const drive = RAIL_DRIVES.contracts_price

        assert.deepStrictEqual(drive.envKeys, Object.keys(DRIVE_ENV))
        for (const [legName, expected] of Object.entries(LEG_SUITES)) {
            const command = buildLegCommand('contracts_price', legName, {
                journalDir: '/tmp/contracts-price-drive-test',
                repoRoot: REPO_ROOT,
                env: DRIVE_ENV,
            })

            assert.deepStrictEqual(command.argv.slice(-expected.files.length), expected.files)
            for (const [envName, value] of Object.entries(DRIVE_ENV)) {
                assert.strictEqual(command.env[envName], value, legName + ' ' + envName)
                assert.ok(command.envKeys.includes(envName), legName + ' reports ' + envName)
            }
        }
    })
})
