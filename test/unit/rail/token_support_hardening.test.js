'use strict'

const assert = require('assert')

const tokenSupport = require('../../integration/bridge_rail_token.test/support/token')

function support(overrides){
    const calls = []
    const venue = Object.assign({
        hasTokenRow: async (chain, tick) => {
            calls.push([chain, tick])
            return false
        },
        waitForFinalizedTransfer: async () => ({
            transfer_id: 'transfer-1', snapshot_block: 1, tick: 'TICK', decimals: 4, amount: 1,
        }),
        waitForBridgeApplied: async () => ({ block_index: 2 }),
    }, overrides)
    return { calls, venue, bound: tokenSupport.bind({ tokens: {}, evidence: {}, venue }) }
}

describe('token rail support hardening', function () {
    it('continues through the shared tick family after the listed spellings are taken', async function () {
        const taken = new Set(['FUFU', 'FUFB', 'FUFC', 'FUFD'])
        const { bound } = support({
            hasTokenRow: async (chain, tick) => taken.has(String(tick).replace(/^BTC[.]/, '')),
        })

        assert.strictEqual(await bound.pickFreeTick(Array.from(taken)), 'FUFA')
    })

    it('keeps the first free listed spelling ahead of expanded candidates', async function () {
        const { bound } = support({
            hasTokenRow: async (chain, tick) => String(tick).replace(/^BTC[.]/, '') === 'FUFU',
        })

        assert.strictEqual(await bound.pickFreeTick(['FUFU', 'FUFB', 'FUFC', 'FUFD']), 'FUFB')
    })

    it('walks candidates without a shared prefix exactly as given', async function () {
        const { bound, calls } = support()

        assert.strictEqual(await bound.pickFreeTick(['ABCD', 'WXYZ']), 'ABCD')
        assert.deepStrictEqual(calls, [['BTC', 'ABCD'], ['DOGE', 'BTC.ABCD']])
    })

    for (const [chain, timeoutMs] of [['DOGE', 35 * 60 * 1000], ['BTC', 70 * 60 * 1000]]) {
        it('uses the policy apply budget for ' + chain, async function () {
            let options = null
            const { bound } = support({
                waitForBridgeApplied: async (destChain, transferId, value) => {
                    options = value
                    return { block_index: 2 }
                },
            })

            await bound.settleLeg('a transfer', () => true, chain)
            assert.deepStrictEqual(options, { timeoutMs })
        })
    }

    it('passes an explicit apply budget through unchanged', async function () {
        let options = null
        const { bound } = support({
            waitForBridgeApplied: async (destChain, transferId, value) => {
                options = value
                return { block_index: 2 }
            },
        })

        await bound.settleLeg('a transfer', () => true, 'DOGE', { applyMs: 12345 })
        assert.deepStrictEqual(options, { timeoutMs: 12345 })
    })
})
