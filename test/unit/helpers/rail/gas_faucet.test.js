'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const path = require('path')
const faucet = require('../../../helpers/rail/gas_faucet')
const { DRILL_KEYS_DIR } = require('../../../helpers/rail/drill_keys_dir')

const SPENT = { supply: '99999796', maxSupply: '100000000' }
const FRESH = { supply: '0', maxSupply: '100000000' }

describe('gas_faucet.planGasFunding', function () {
    it('SENDs from a holder that covers the amount, even while MINT would still fit', function () {
        const plan = faucet.planGasFunding({ amount: '5000', supply: FRESH,
            holders: [{ address: 'a', balance: '100' }, { address: 'b', balance: '26244473' }] })
        assert.deepStrictEqual(plan, { kind: 'send', address: 'b' })
    })

    it('SENDs on a spent chain (99,999,796 of 100,000,000 minted)', function () {
        const plan = faucet.planGasFunding({ amount: '5000', supply: SPENT,
            holders: [{ address: 'b', balance: '3304671' }] })
        assert.strictEqual(plan.kind, 'send')
    })

    it('rotates to the least recently used holder that can cover the amount', function () {
        const holders = [{ address: 'a', balance: '1000000' }, { address: 'b', balance: '2000000' }]
        const lastUsed = new Map([['b', 5]])
        assert.deepStrictEqual(faucet.planGasFunding({ amount: '100', holders, lastUsed }), { kind: 'send', address: 'a' })
        lastUsed.set('a', 9)
        assert.deepStrictEqual(faucet.planGasFunding({ amount: '100', holders, lastUsed }), { kind: 'send', address: 'b' })
    })

    it('MINTs on a fresh chain with no faucet holders', function () {
        assert.deepStrictEqual(faucet.planGasFunding({ amount: '100', holders: [], supply: FRESH }), { kind: 'mint' })
    })

    it('MINTs when the supply cannot be read, as before this module', function () {
        assert.deepStrictEqual(faucet.planGasFunding({ amount: '100', holders: [], supply: null }), { kind: 'mint' })
    })

    it('MINTs exactly up to MAX_SUPPLY and refuses one unit past it', function () {
        assert.strictEqual(faucet.planGasFunding({ amount: '204', supply: SPENT }).kind, 'mint')
        const refused = faucet.planGasFunding({ amount: '205', supply: SPENT, holders: [{ address: 'a', balance: '100' }] })
        assert.strictEqual(refused.kind, 'refuse')
        assert.match(refused.reason, /largest 100/)
        assert.match(refused.reason, /supply 99999796 of 100000000/)
    })

    it('never counts a malformed balance as enough', function () {
        const plan = faucet.planGasFunding({ amount: '1', supply: SPENT,
            holders: [{ address: 'a', balance: 'NaN' }, { address: 'b', balance: '-5' }] })
        assert.strictEqual(plan.kind, 'mint', 'one unit still fits under MAX_SUPPLY')
        assert.throws(() => faucet.planGasFunding({ amount: 'lots' }), /not a gas amount/)
    })

    it('compares fractional amounts in base units', function () {
        const plan = faucet.planGasFunding({ amount: '0.5', holders: [{ address: 'a', balance: '0.49999999' }],
            supply: { supply: '100000000', maxSupply: '100000000' } })
        assert.strictEqual(plan.kind, 'refuse')
    })
})

describe('gas_faucet file and chain reads', function () {
    const fsWith = (files) => ({
        existsSync: (p) => p in files,
        readFileSync: (p) => files[p]
    })

    it('reads { address, mnemonic } records and drops anything else', function () {
        const recs = faucet.readFaucetRecords('/f', fsWith({ '/f': JSON.stringify([
            { address: 'a', mnemonic: 'm' }, { address: 'b' }, null, { staker: 'x', address: 'c', mnemonic: 'n' }]) }))
        assert.deepStrictEqual(recs.map((r) => r.address), ['a', 'c'])
    })

    it('treats a missing file as an empty faucet and a broken one as an error', function () {
        assert.deepStrictEqual(faucet.readFaucetRecords('/none', fsWith({})), [])
        assert.throws(() => faucet.readFaucetRecords('/f', fsWith({ '/f': '{' })), /not valid JSON/)
        assert.throws(() => faucet.readFaucetRecords('/f', fsWith({ '/f': '{}' })), /JSON array/)
    })

    it('honours E2E_GAS_FAUCET_FILE', function () {
        assert.strictEqual(faucet.faucetFile({ E2E_GAS_FAUCET_FILE: '/x.json' }), '/x.json')
        assert.strictEqual(faucet.faucetFile({}), faucet.DEFAULT_FAUCET_FILE)
        assert.strictEqual(faucet.DEFAULT_FAUCET_FILE, path.join(DRILL_KEYS_DIR, 'gas-faucet.json'))
    })

    it('reads the gas supply off the tokens row, and null when it cannot', async function () {
        let released = 0
        const db = { async getConnection(){ return {
            async query(sql, params){ assert.deepStrictEqual(params, ['XCHAIN']); return [{ supply: '7', max_supply: '9' }] },
            async release(){ released++ } } } }
        assert.deepStrictEqual(await faucet.readGasSupply(db, 'XCHAIN'), { supply: '7', maxSupply: '9' })
        assert.strictEqual(released, 1)
        assert.strictEqual(await faucet.readGasSupply({}, 'XCHAIN'), null)
        const failing = { async getConnection(){ return { async query(){ throw new Error('x') }, async release(){} } } }
        assert.strictEqual(await faucet.readGasSupply(failing, 'XCHAIN'), null)
    })

    it('reads each holder balance, an unreadable one as zero', async function () {
        const db = { async getBalance({ address }){ if (address === 'b') throw new Error('x'); return address === 'a' ? '12' : null } }
        assert.deepStrictEqual(await faucet.readHolderBalances(db, [{ address: 'a' }, { address: 'b' }, { address: 'c' }], 'XCHAIN'),
            [{ address: 'a', balance: '12' }, { address: 'b', balance: '0' }, { address: 'c', balance: '0' }])
    })
})
