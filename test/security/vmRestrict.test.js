// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const vmHelper = require('../helpers/vmHelper')
const gasHelper = require('../helpers/gasHelper')
const transactionHelper = require('../transactionHelper')

/**
 * VM Restrict — confirms on-chain that contracts containing the banned native-DoS
 * literals (BigInt, RegExp) are rejected at DEPLOY, while benign contracts still
 * deploy. These literals expose unmetered native CPU (a block packed with such
 * EXECUTEs could halt the indexer), so they are blocked at the syntax layer.
 */
describe('VM Restrict — banned native-DoS literals rejected on-chain', function () {

    let deployer = null

    async function deployRaw(addr, code) {
        // Inline CODE_ENCODING is base64 (DEPLOY_BASE64_CODE active from genesis on regtest);
        // hex would be rejected at decode, short-circuiting the syntax checks this suite targets.
        const b64 = Buffer.from(code, 'utf8').toString('base64')
        return await transactionHelper.createAndSendTransaction(addr, 'DEPLOY|0|' + b64 + '|200000', null, [], 'P2SH')
    }
    async function waitContractAny(source, timeMax = 60000) {
        const end = Date.now() + timeMax
        while (Date.now() < end) {
            const r = await indexerDatabase.checkContract({ source })
            if (r) return r
            await new Promise(res => setTimeout(res, 1000))
        }
        return null
    }

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vmr-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '300')
    })

    it('a benign contract still deploys (regression)', async function () {
        const dep = await vmHelper.sendDeployV0(deployer,
            `module.exports = { inc: function(){ var c=parseInt(xchain.state.get('n')||'0'); xchain.state.set('n',String(c+1)); return String(c+1); } };`,
            200000)
        assert(dep.contract, 'benign contract should deploy')
        assert.strictEqual(dep.contract.status, 'valid')
    })

    it('a contract with a BigInt literal is rejected at deploy', async function () {
        const atk = await cryptoHelper.getNewFundedAddress('vmr-bigint', COIN, NETWORK, null, 'legacy', 0, 1)
        await deployRaw(atk, `module.exports = function(){ return (2n ** 5000000n).toString(); };`)
        const row = await waitContractAny(atk.address)
        assert(row, 'a rejected contract row should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'BigInt-literal contract must be rejected')
        assert(/bigint|literal|CODE_ENCODING/i.test(row.status), `status should cite the banned literal (got: ${row.status})`)
    })

    it('a contract with a RegExp literal is rejected at deploy', async function () {
        const atk = await cryptoHelper.getNewFundedAddress('vmr-regex', COIN, NETWORK, null, 'legacy', 0, 1)
        await deployRaw(atk, `module.exports = function(){ return /(a+)+$/.test('aaaa!'); };`)
        const row = await waitContractAny(atk.address)
        assert(row, 'a rejected contract row should be recorded')
        assert.notStrictEqual(row.status, 'valid', 'RegExp-literal contract must be rejected')
        assert(/regex|literal|CODE_ENCODING/i.test(row.status), `status should cite the banned literal (got: ${row.status})`)
    })
})
