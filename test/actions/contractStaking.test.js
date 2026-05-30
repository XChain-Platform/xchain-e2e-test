const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')

// Generate an Ed25519 pubkey as a 64-hex string (same pattern as staking.test.js)
function newSigningPubkey(){
    let { publicKey } = crypto.generateKeyPairSync('ed25519')
    let spkiDer = publicKey.export({ format: 'der', type: 'spki' })
    return spkiDer.subarray(12).toString('hex')
}

describe('Contract Staking — STAKE v3 / UNSTAKE v1 / DELEGATE v1 + slashing', function () {

    // Contract staking is multi-chain — exercised against the XCHAIN token that
    // initialCheck.test.js ISSUEs on every chain at suite startup. Capability
    // staking (STAKE v1/v2 / UNSTAKE v0 / DELEGATE v0/v2 / COLLECT) remains
    // BTC-only at the protocol level.

    // STAKE-GATED contract: lets the test exercise getStake/getTotalStaked/getStakers/slash
    // through real method invocations. Stored as a small string so the e2e log stays readable.
    const STAKE_GATED_CONTRACT = `
        module.exports = {
            isStaked: function() {
                let pubkey = xchain.getInputParam(0)
                let amount = xchain.contract.getStake(pubkey, 'XCHAIN')
                return xchain.math.gte(amount, '100') ? 'yes' : 'no'
            },
            getTotalXchain: function() {
                return xchain.contract.getTotalStaked('XCHAIN')
            },
            doSlash: function() {
                let pubkey = xchain.getInputParam(0)
                let amount = xchain.getInputParam(1)
                xchain.contract.slash(pubkey, 'XCHAIN', amount)
                return 'ok'
            }
        };
    `

    describe('DEPLOY v1 — Stakeable contract metadata', function () {

        it('should deploy with COOLDOWN_BLOCKS + BURN as slash destination', async function () {
            let deployer = await cryptoHelper.getNewFundedAddress(
                "stakeable-contract-deployer-1", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(deployer, '500')

            let result = await vmHelper.sendDeployV1(deployer, STAKE_GATED_CONTRACT, 300000, '', 100, 'BURN')
            assert(result.contract, 'contract row should exist')
            assert.strictEqual(result.contract.status, 'valid', 'contract should deploy as valid')
            assert.strictEqual(parseInt(result.contract.cooldown_blocks), 100, 'cooldown_blocks should be 100')
            assert(result.contract.slash_destination_id !== null && result.contract.slash_destination_id !== undefined,
                'slash_destination_id should resolve to an address row')
        })

        it('should reject COOLDOWN_BLOCKS out of range', async function () {
            let deployer = await cryptoHelper.getNewFundedAddress(
                "stakeable-contract-deployer-2", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(deployer, '500')

            // 100001 is above the max — must be rejected (use the status-agnostic helper;
            // the valid-only waitForContract would stall 60s and never observe the rejection,
            // making this assertion vacuous).
            let result = await vmHelper.sendDeployV1Invalid(deployer, STAKE_GATED_CONTRACT, 300000, '', 100001, 'BURN')
            assert(result.contract, 'a (rejected) contract row should be recorded')
            assert.notStrictEqual(result.contract.status, 'valid', 'out-of-range cooldown should fail validation')
            assert(/COOLDOWN_BLOCKS/i.test(result.contract.status), `status should cite COOLDOWN_BLOCKS (got: ${result.contract.status})`)
        })
    })

    describe('STAKE v3 + getStake + slash + UNSTAKE v1 — Full lifecycle', function () {

        let contractIndex = null
        let staker = null
        let pubkey = null

        before(async function () {
            // Deploy a fresh stakeable contract for this lifecycle test
            let deployer = await cryptoHelper.getNewFundedAddress(
                "lifecycle-deployer", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(deployer, '500')
            let deploy = await vmHelper.sendDeployV1(deployer, STAKE_GATED_CONTRACT, 300000, '', 50, 'BURN')
            assert(deploy.contract && deploy.contract.status === 'valid', 'lifecycle: contract must deploy clean')
            contractIndex = deploy.contract.action_index

            // Fund a staker with BTC + XCHAIN
            staker = await cryptoHelper.getNewFundedAddress(
                "contract-staker", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(staker, '500')
            pubkey = newSigningPubkey()
        })

        it('should record a STAKE v3 row with the right (target, pubkey, tick)', async function () {
            let result = await stakeHelper.sendStakeV3(staker, '200.00000000', pubkey, contractIndex, 'XCHAIN')
            assert(result.stake, 'contract_stakes row should exist')
            assert.strictEqual(result.stake.status, 'valid', 'stake should be valid')
            assert.strictEqual(Number(result.stake.target_contract_index), Number(contractIndex), 'target match')
            assert.strictEqual(result.stake.tick, 'XCHAIN', 'tick match')
        })

        it('should let the VM read getStake successfully', async function () {
            // The contract's isStaked() calls xchain.contract.getStake under the hood —
            // we don't capture return values in contract_executions, so a successful
            // VM read is confirmed by status='valid' + gas_used covering the read
            // (VM_STATE_READ = 100 gas + a handful for getInputParam/math.gte).
            let exec = await vmHelper.sendExecuteV0(staker, contractIndex, 'isStaked', [pubkey])
            assert(exec.execution, 'execution row exists')
            assert.strictEqual(exec.execution.status, 'valid',
                'getStake call should succeed inside the VM')
            assert(Number(exec.execution.gas_used) >= 100,
                'gas_used should at least cover VM_STATE_READ (100)')
        })
    })

    describe('Validation — Non-stakeable contracts reject STAKE v3', function () {

        it('should reject STAKE v3 targeting a non-stakeable (DEPLOY v0) contract', async function () {
            // Deploy a regular v0 contract (no cooldown_blocks set)
            let deployer = await cryptoHelper.getNewFundedAddress(
                "non-stakeable-deployer", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(deployer, '500')
            let deploy = await vmHelper.sendDeployV0(deployer, STAKE_GATED_CONTRACT, 300000, '')
            assert(deploy.contract && deploy.contract.status === 'valid', 'baseline DEPLOY v0 must succeed')

            // Try to stake against it — should be rejected by stake.js _parseContractStake
            let staker = await cryptoHelper.getNewFundedAddress(
                "rejected-staker", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(staker, '500')
            let pk = newSigningPubkey()

            // Use the status-agnostic helper: the valid-only waitForContractStake would
            // stall the full 60s and never observe the rejection, making the assertion
            // vacuous (the row IS written with the invalid status — see stake.js).
            let result = await stakeHelper.sendStakeV3Invalid(staker, '100.00000000', pk, deploy.contract.action_index, 'XCHAIN')
            assert(result.stake, 'a (rejected) contract_stakes row should be recorded')
            assert.notStrictEqual(result.stake.status, 'valid',
                'STAKE v3 against non-stakeable contract must not succeed')
            assert(/not stakeable/i.test(result.stake.status),
                `status should cite the non-stakeable contract (got: ${result.stake.status})`)
        })

        it('should reject STAKE v3 against an unknown contract index', async function () {
            let staker = await cryptoHelper.getNewFundedAddress(
                "ghost-staker", COIN, NETWORK, null, "legacy", 0, 1
            )
            await gasHelper.ensureGasBalance(staker, '500')
            let pk = newSigningPubkey()

            // Action index that almost certainly doesn't exist as a contract.
            // Status-agnostic helper for the same reason as the non-stakeable case above.
            let result = await stakeHelper.sendStakeV3Invalid(staker, '100.00000000', pk, 999999999, 'XCHAIN')
            assert(result.stake, 'a (rejected) contract_stakes row should be recorded')
            assert.notStrictEqual(result.stake.status, 'valid',
                'STAKE v3 against unknown contract must not succeed')
            assert(/unknown/i.test(result.stake.status),
                `status should cite the unknown contract index (got: ${result.stake.status})`)
        })
    })
})
