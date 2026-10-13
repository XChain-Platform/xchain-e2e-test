'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Hermetic coverage of the fixture-stake teardown policy.
 * Strict-mode settle re-read: mine to the deactivation burial and re-read
 * before failing, and fail only for LEAKED or NOT SENT keys, never for
 * NOT YET SETTLED ones.
 ********************************************************************/

const assert = require('assert')
const teardown = require('../../helpers/stakeTeardown')

const addr = (a) => ({ address: a, privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) })
const baseline = { capability: 'oracle_publish', blockIndex: 900, pubkeys: ['aa'], sources: ['s0'] }
const strict = () => teardown.policy({ E2E_STAKE_TEARDOWN_STRICT: '1' })

// An indexer whose set drops the given keys once `mined` reaches `settleAt`.
function settlingIndexer(state, keys, settleAt){
    return {
        reads: 0,
        async call(method){
            if(method === 'getblockhashes') return { block_index: 900 + state.mined }
            this.reads++
            const v = [{ pubkey: 'aa', source: 's0', weight: '1' }]
            if(state.mined < settleAt)
                for(const k of keys) v.push({ pubkey: k, source: 's1', weight: '10' })
            return { validators: v }
        }
    }
}

describe('stakeTeardown strict settle re-read', () => {
    beforeEach(() => teardown.reset())
    afterEach(() => teardown.reset())

    it('mines on and re-reads, passing when a sent key settles', async () => {
        teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1' })
        const st = { mined: 0 }
        const indexer = settlingIndexer(st, ['bb'], 20)
        const state = await teardown.runTeardown({
            policy: strict(), baseline: baseline, indexer: indexer,
            unstake: async () => {}, mine: async (n) => { st.mined += n }, log: () => {}
        })
        assert.strictEqual(state.diff.grew, false)
        assert.ok(state.rereads >= 1)
    })

    it('does not throw for a key that is still NOT YET SETTLED after the rounds', async () => {
        teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1' })
        const st = { mined: 0 }
        const lines = []
        const state = await teardown.runTeardown({
            policy: strict(), baseline: baseline, indexer: settlingIndexer(st, ['bb'], 1e9),
            unstake: async () => {}, mine: async (n) => { st.mined += n }, log: (l) => lines.push(l)
        })
        assert.strictEqual(state.rereads, teardown.STRICT_REREAD_ROUNDS)
        assert.ok(lines.join('\n').includes('NOT YET SETTLED'))
    })

    it('throws for a LEAKED key without wasting blocks', async () => {
        const st = { mined: 0 }
        await assert.rejects(teardown.runTeardown({
            policy: strict(), baseline: baseline, indexer: settlingIndexer(st, ['cc'], 1e9),
            unstake: async () => {}, mine: async (n) => { st.mined += n }, log: () => {}
        }), /left 1 key/)
        assert.strictEqual(st.mined, 0)
    })

    it('throws for a NOT SENT key', async () => {
        teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1' })
        const st = { mined: 0 }
        await assert.rejects(teardown.runTeardown({
            policy: strict(), baseline: baseline, indexer: settlingIndexer(st, ['bb'], 1e9),
            unstake: async () => { throw new Error('timed out') },
            mine: async (n) => { st.mined += n }, log: () => {}
        }), /left 1 key/)
    })

    it('throws only for the lost keys when settled and leaked keys mix', async () => {
        teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1' })
        const st = { mined: 0 }
        await assert.rejects(teardown.runTeardown({
            policy: strict(), baseline: baseline, indexer: settlingIndexer(st, ['bb', 'cc'], 1e9),
            unstake: async () => {}, mine: async (n) => { st.mined += n }, log: () => {}
        }), /left 1 key/)
    })

    it('does not re-read outside strict mode', async () => {
        teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1' })
        const st = { mined: 0 }
        const indexer = settlingIndexer(st, ['bb'], 1e9)
        const state = await teardown.runTeardown({
            policy: teardown.policy({}), baseline: baseline, indexer: indexer,
            unstake: async () => {}, mine: async (n) => { st.mined += n }, log: () => {}
        })
        assert.strictEqual(state.rereads, undefined)
        assert.strictEqual(indexer.reads, 1)
    })
})
