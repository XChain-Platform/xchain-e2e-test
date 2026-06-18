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
const cryptoHelper = require('../cryptoHelper')
const gasHelper = require('../helpers/gasHelper')
const transactionHelper = require('../transactionHelper')

/**
 * VM Deploy Reject: confirms the indexer rejects malformed/abusive DEPLOYs at the
 * syntax-validation gate (deploy.js -> vm.validateSyntax), recording a contract row
 * with an invalid status. The encoder happily carries any bytes; rejection happens
 * at indexing. (The 64KB code-size limit is exercised in the library suite, not here;
 * a >64KB payload is impractical to broadcast through the P2SH path.)
 */
describe('VM Deploy Reject: malformed/abusive contracts', function () {

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
    async function freshDeployer(label) {
        const a = await cryptoHelper.getNewFundedAddress(label, COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(a, '100')
        return a
    }

    before(async function () {
        deployer = await cryptoHelper.getNewFundedAddress('vmdr-deployer', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(deployer, '100')
    })

    it('rejects a contract with a JavaScript syntax error', async function () {
        const atk = await freshDeployer('vmdr-syntax')
        await deployRaw(atk, `module.exports = function(){ return ( ; };`)
        const row = await waitContractAny(atk.address)
        assert(row, 'a rejected contract row should be recorded')
        assert.notStrictEqual(row.status, 'valid')
        assert(/syntax|CODE_ENCODING/i.test(row.status), `status should cite a syntax error (got: ${row.status})`)
    })

    it('rejects use of the reserved __gas identifier', async function () {
        const atk = await freshDeployer('vmdr-gas')
        await deployRaw(atk, `module.exports = function(){ var __gas = 1; return __gas; };`)
        const row = await waitContractAny(atk.address)
        assert(row, 'a rejected contract row should be recorded')
        assert.notStrictEqual(row.status, 'valid')
        assert(/__gas|reserved|CODE_ENCODING/i.test(row.status), `status should cite __gas (got: ${row.status})`)
    })

    it('rejects a banned non-deterministic Math member (Math.pow)', async function () {
        const atk = await freshDeployer('vmdr-math')
        await deployRaw(atk, `module.exports = function(){ return Math.pow(2, 3); };`)
        const row = await waitContractAny(atk.address)
        assert(row, 'a rejected contract row should be recorded')
        assert.notStrictEqual(row.status, 'valid')
        assert(/Math|banned|CODE_ENCODING/i.test(row.status), `status should cite the banned Math member (got: ${row.status})`)
    })
})
