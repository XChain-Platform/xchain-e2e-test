// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const gasHelper = require('../../helpers/gasHelper')
const vmHelper = require('../../helpers/vmHelper')
const { HIDDEN_SOURCE, CONTROL_SOURCE } = require('./helpers/optional_chain_sources')

const LINT_REFUSAL = 'banned async surface: promise at line 1 (Promise schedules microtasks whose drain timing is isolated-vm version-dependent and unpinned)'

async function freshDeployer(label){
    const deployer = await cryptoHelper.getNewFundedAddress(
        label, COIN, NETWORK, null, 'legacy', 0, 1
    )
    await gasHelper.ensureGasBalance(deployer, '100')
    return deployer
}

describe('VM optional-chain deploy lint', function () {
    it('indexes the control deploy as valid', async function () {
        const deployer = await freshDeployer('vm-lint-optional-chain-control')
        const result = await vmHelper.sendDeployV0(deployer, CONTROL_SOURCE, 200000)
        assert(result.contract, 'control deploy should write a contract row')
        assert.strictEqual(result.contract.status, 'valid')
    })

    it('indexes the hidden optional-chain deploy with the lint refusal', async function () {
        const deployer = await freshDeployer('vm-lint-optional-chain-hidden')
        const result = await vmHelper.sendDeployV1Invalid(
            deployer, HIDDEN_SOURCE, 200000, '', 1, 'BURN'
        )
        assert(result.contract, 'hidden deploy should write a rejected contract row')
        assert.match(result.contract.status, /^invalid/)
        assert(
            result.contract.status.includes(LINT_REFUSAL),
            `status should name the optional-chain lint refusal (got: ${result.contract.status})`
        )
    })
})
