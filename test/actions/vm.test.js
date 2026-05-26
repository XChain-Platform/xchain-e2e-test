const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const issueHelper = require('../helpers/issueHelper')
const mintHelper = require('../helpers/mintHelper')
const gasHelper = require('../helpers/gasHelper')

describe('VM — Smart Contracts', function () {

    // Simple counter contract for testing
    const COUNTER_CONTRACT = `
        module.exports = {
            initialize: function() {
                xchain.state.set('count', '0');
            },
            increment: function() {
                let count = parseInt(xchain.state.get('count') || '0');
                xchain.state.set('count', String(count + 1));
                return String(count + 1);
            },
            getCount: function() {
                return xchain.state.get('count') || '0';
            }
        };
    `

    // Contract that reverts
    const REVERT_CONTRACT = `
        module.exports = function() {
            xchain.revert('intentional revert');
        };
    `

    let deployerAddr = null

    before(async function () {
        // Fund a deployer address with BTC and XCHAIN (for gas fees)
        deployerAddr = await cryptoHelper.getNewFundedAddress(
            "vm-deployer", COIN, NETWORK, null, "legacy", 0, 1
        )
        // Ensure deployer has XCHAIN for gas
        await gasHelper.ensureGasBalance(deployerAddr, '100')
    })

    describe('DEPLOY v0 — Deploy a contract', function () {
        it('should deploy a counter contract and create a contract record', async function () {
            let result = await vmHelper.sendDeployV0(deployerAddr, COUNTER_CONTRACT, 200000, 'init')
            assert(result.contract, 'Contract record should exist in DB')
            assert.strictEqual(result.contract.status, 'valid', 'Contract status should be valid')
        })
    })

    describe('EXECUTE v0 — Execute a contract method', function () {
        let contractIndex = null

        before(async function () {
            // Deploy a fresh contract
            let deploy = await vmHelper.sendDeployV0(deployerAddr, COUNTER_CONTRACT, 200000)
            assert(deploy.contract, 'Deploy should succeed')
            contractIndex = deploy.contract.action_index
        })

        it('should execute increment and create an execution record', async function () {
            let result = await vmHelper.sendExecuteV0(deployerAddr, contractIndex, 'increment', [])
            assert(result.execution, 'Execution record should exist in DB')
            assert.strictEqual(result.execution.status, 'valid', 'Execution status should be valid')
            assert(result.execution.gas_used > 0, 'Gas should be consumed')
        })
    })

    describe('DEPLOY v0 — Deploy with constructor', function () {
        it('should deploy with constructor params and execute initialize', async function () {
            let result = await vmHelper.sendDeployV0(deployerAddr, COUNTER_CONTRACT, 200000, 'init')
            assert(result.contract, 'Contract with constructor should deploy')
            assert.strictEqual(result.contract.status, 'valid')
        })
    })
})
