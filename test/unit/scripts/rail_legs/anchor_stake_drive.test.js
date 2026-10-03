'use strict'

const assert = require('assert')
const path = require('path')

const { RAIL_DRIVES } = require('../../../helpers/bridge_rail_legs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const DRIVER = path.join(REPO_ROOT, 'scripts', 'rail_leg_drive.js')
delete require.cache[require.resolve(DRIVER)]
const { buildLegCommand } = require(DRIVER)
const ARM_ENV = {
    XC_ANCHOR_FOLD_REGTEST_ACTIVATION: '701',
    XC_ANCHOR_STAKE_REGTEST_ACTIVATION: '702',
    XC_ANCHOR_SLASH_REGTEST_ACTIVATION: '703',
}
const LEG_SUITES = {
    anchor_fold: 'test/federation/anchor_fold_acceptance.test.js',
    anchor_bundle: 'test/federation/flag_days/anchor_bundle_order.test.js',
    staking: 'test/actions/staking.test.js',
    capability_slash: 'test/actions/capability_slash.test.js',
    vm_contract_slash: 'test/actions/vm_contract_slash.test.js',
    archive_count: 'test/federation/flag_days/archive_match_count.test.js',
}

describe('anchor and stake rail drive', function () {
    it('registers as an enumerable drive', function () {
        assert.ok(Object.hasOwn(RAIL_DRIVES, 'anchor_stake'))
        assert.strictEqual(
            Object.getOwnPropertyDescriptor(RAIL_DRIVES, 'anchor_stake').enumerable,
            true
        )
        assert.ok(Object.keys(RAIL_DRIVES).includes('anchor_stake'))
    })

    it('registers one leg for each acceptance suite', function () {
        const drive = RAIL_DRIVES.anchor_stake

        assert.ok(drive)
        assert.deepStrictEqual(Object.keys(drive.legs), Object.keys(LEG_SUITES))
        for (const [legName, suite] of Object.entries(LEG_SUITES)) {
            assert.deepStrictEqual(drive.legs[legName].files, [suite])
        }
    })

    it('passes every arm height to every leg command', function () {
        for (const [legName, suite] of Object.entries(LEG_SUITES)) {
            const command = buildLegCommand('anchor_stake', legName, {
                journalDir: '/tmp/anchor-stake-drive-test',
                repoRoot: REPO_ROOT,
                env: ARM_ENV,
            })

            assert.deepStrictEqual(command.argv.slice(-1), [suite])
            for (const [envName, value] of Object.entries(ARM_ENV)) {
                assert.strictEqual(command.env[envName], value, legName + ' ' + envName)
                assert.ok(command.envKeys.includes(envName), legName + ' reports ' + envName)
            }
        }
    })

    it('gives the fold, bundle and archive count children a dogecoin COIN over the bitcoin default', function () {
        for (const legName of Object.keys(LEG_SUITES)) {
            const command = buildLegCommand('anchor_stake', legName, {
                journalDir: '/tmp/anchor-stake-drive-test',
                repoRoot: REPO_ROOT,
                env: ARM_ENV,
            })
            const expected = ['anchor_fold', 'anchor_bundle', 'archive_count'].includes(legName) ? 'dogecoin' : 'bitcoin'
            assert.strictEqual(command.env.COIN, expected, legName)
            assert.strictEqual(command.env.NETWORK, 'regtest', legName)
        }
    })
})
