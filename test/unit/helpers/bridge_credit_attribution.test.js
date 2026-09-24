'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const requireRow = require('../../helpers/requireRow')

const expected = {
    lockTxHash: '943e12baba913660f8a64a368ed563f914bda8ebe1d4db6e5adbda3f61b60cb6',
    destCoin: 'DOGE',
    destAddress: 'mosGAKW3KXbLsDVh5WSw6DAbcf6DzzcKu9',
    tick: 'XCHAIN',
    amount: '100'
}
const originalFailure = 'bridgeGasIn: destination credit wait gave up'

async function runGiveUp(checkCredit){
    const database = { checkCredit }
    return await requireRow.withProbe(null, originalFailure,
        () => requireRow.bridgeCreditAttribution(database, expected),
        requireRow.bridgeCreditEvidence(expected))
}

async function rejectionFrom(fn){
    try {
        await fn()
    } catch (err) {
        return err
    }
    assert.fail('expected the give-up path to reject')
}

describe('AT5 bridge credit attribution', function(){
    it('reports ABSENT with the lock txid when no destination row exists', async function(){
        const err = await rejectionFrom(() => runGiveUp(async () => null))

        assert.match(err.message, /indexer verdict: ABSENT/)
        assert.match(err.message, new RegExp(expected.lockTxHash))
        assert.match(err.message, /destination DOGE/)
        assert.match(err.message, /address mosGAKW3/)
        assert.match(err.message, /tick XCHAIN/)
        assert.match(err.message, /expected amount 100/)
    })

    it('reports WRONG STATUS with the found and expected statuses', async function(){
        const err = await rejectionFrom(() => runGiveUp(async () => ({
            status: 'invalid: escrow proof',
            amount: '100'
        })))

        assert.match(err.message, /indexer verdict: WRONG STATUS/)
        assert.match(err.message, /found status invalid: escrow proof/)
        assert.match(err.message, /expected status valid/)
        assert.match(err.message, /amount 100/)
    })

    it('reports a valid row with the wrong amount instead of calling it ABSENT', async function(){
        const err = await rejectionFrom(() => runGiveUp(async () => ({
            status: 'valid',
            amount: '99.00000000'
        })))

        assert.match(err.message, /indexer verdict: WRONG STATUS/)
        assert.match(err.message, /found status valid, amount 99\.00000000/)
        assert.match(err.message, /expected status valid, amount 100/)
        assert.doesNotMatch(err.message, /indexer verdict: ABSENT/)
    })

    it('reports a sanitized UNREACHABLE cause without replacing the give-up failure', async function(){
        const err = await rejectionFrom(() => runGiveUp(async () => {
            throw new Error('credits table does not exist; DOGE_INDEXER_DB_PASS=hunter2')
        }))

        assert.match(err.message, /^bridgeGasIn: destination credit wait gave up never landed/)
        assert.match(err.message, /indexer verdict: UNREACHABLE/)
        assert.match(err.message, /credits table does not exist/)
        assert.match(err.message, /DOGE_INDEXER_DB_PASS=\[REDACTED\]/)
        assert.doesNotMatch(err.message, /hunter2/)
        assert.match(err.message, new RegExp(expected.lockTxHash))
    })

    it('returns a truthy wait result without running the probe', async function(){
        const row = { action_index: 42, amount: '100.00000000' }
        let calls = 0
        const database = {
            checkCredit: async () => {
                calls++
                throw new Error('must not run')
            }
        }

        const result = await requireRow.withProbe(row, originalFailure,
            () => requireRow.bridgeCreditAttribution(database, expected),
            requireRow.bridgeCreditEvidence(expected))

        assert.strictEqual(result, row)
        assert.strictEqual(calls, 0)
    })

    it('treats equivalent decimal spellings as the expected amount', async function(){
        const verdict = await requireRow.bridgeCreditAttribution({
            checkCredit: async () => ({ amount: '100.00000000' })
        }, expected)

        assert.match(verdict, /row appeared only after the wait gave up/)
        assert.match(verdict, /found status valid, amount 100\.00000000/)
    })

    it('preserves the two-argument requireRow contract', function(){
        const row = { id: 7 }
        assert.strictEqual(requireRow(row, 'unused'), row)
        assert.throws(() => requireRow(null, 'missing fixture'), {
            message: 'missing fixture never landed; the GAVE UP line above, from the matching '
                + 'check* poll, says whether the row is absent or landed with another status '
                + '- read the indexer verdict for this tx'
        })
    })
})
