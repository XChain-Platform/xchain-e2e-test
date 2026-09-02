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
 *
 * The policy's whole value is that it runs on a venue nobody is watching, so
 * every branch is proved here with fakes: what the run owes, what discharges
 * it, that the release MINES (an UNSTAKE that is never buried changes nothing
 * a capability read can see), and that a leak is reported by name and is fatal
 * under strict mode.
 ********************************************************************/

const assert = require('assert')
const teardown = require('../../helpers/stakeTeardown')

const addr = (a) => ({ address: a, privateKey: Buffer.alloc(32), publicKey: Buffer.alloc(33) })

function fakeIndexer(validators, opts){
    const o = opts || {}
    return {
        calls: [],
        async call(method, params){
            this.calls.push({ method, params })
            if(o.throwOn === method) throw new Error('rpc rejected: ' + method)
            if(o.nullOn === method) return null
            if(method === 'getblockhashes') return { block_index: o.tip === undefined ? 900 : o.tip }
            if(method === 'getstakeweightsbycapability') return { validators: validators }
            return {}
        }
    }
}

describe('stakeTeardown, the fixture-stake teardown policy', () => {

    beforeEach(() => teardown.reset())
    afterEach(() => teardown.reset())

    describe('policy', () => {
        it('releases and checks by default', () => {
            const p = teardown.policy({})
            assert.strictEqual(p.release, true)
            assert.strictEqual(p.check, true)
            assert.strictEqual(p.strict, false)
            assert.strictEqual(p.capability, 'oracle_publish')
            assert.strictEqual(p.settleBlocks, teardown.RELEASE_SETTLE_BLOCKS)
        })

        it('E2E_STAKE_TEARDOWN=off declares a dedicated staking venue and says so', () => {
            for(const off of ['off', '0', 'false', 'no']){
                const p = teardown.policy({ E2E_STAKE_TEARDOWN: off })
                assert.strictEqual(p.release, false, off + ' should disable the release')
                assert.strictEqual(p.check, false, off + ' should disable the check')
                assert.match(p.reason, /dedicated staking venue/)
            }
        })

        it('honours the strict, capability, settle-block and budget overrides', () => {
            const p = teardown.policy({
                E2E_STAKE_TEARDOWN_STRICT: '1',
                E2E_STAKE_TEARDOWN_CAPABILITY: 'attestation',
                E2E_STAKE_TEARDOWN_SETTLE_BLOCKS: '3',
                E2E_STAKE_TEARDOWN_BUDGET_MS: '1234'
            })
            assert.strictEqual(p.strict, true)
            assert.strictEqual(p.capability, 'attestation')
            assert.strictEqual(p.settleBlocks, 3)
            assert.strictEqual(p.budgetMs, 1234)
        })

        it('ignores a non-numeric settle/budget override rather than producing NaN', () => {
            const p = teardown.policy({ E2E_STAKE_TEARDOWN_SETTLE_BLOCKS: 'soon', E2E_STAKE_TEARDOWN_BUDGET_MS: '-5' })
            assert.strictEqual(p.settleBlocks, teardown.RELEASE_SETTLE_BLOCKS)
            assert.strictEqual(p.budgetMs, teardown.DEFAULT_BUDGET_MS)
        })
    })

    describe('the ledger', () => {
        it('books one debt per staked pubkey', () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'AA', amount: '1000' })
            teardown.registerStake({ addressInfo: addr('s2'), signingPubkey: 'bb', amount: '2000' })
            assert.strictEqual(teardown.outstanding().length, 2)
        })

        it('folds a v2 top-up into the stake it tops up (one UNSTAKE sweeps both rows)', () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'AA', amount: '500' })
            const out = teardown.outstanding()
            assert.strictEqual(out.length, 1, 'a top-up is the same debt, not a second one')
            assert.deepStrictEqual(out[0].amounts, ['1000', '500'])
        })

        it('keeps a contract stake distinct from a bare stake on the same pubkey', () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000', contractIndex: 42, tick: 'TOK' })
            assert.strictEqual(teardown.outstanding().length, 2)
        })

        it('ignores a registration with no source or no pubkey', () => {
            assert.strictEqual(teardown.registerStake({ signingPubkey: 'aa' }), null)
            assert.strictEqual(teardown.registerStake({ addressInfo: addr('s1') }), null)
            assert.strictEqual(teardown.outstanding().length, 0)
        })

        it('a FULL unstake discharges the debt', () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            teardown.noteUnstake({ signingPubkey: 'aa' })
            assert.strictEqual(teardown.outstanding().length, 0)
        })

        it('a PARTIAL unstake does not: the residual is re-staked and still a member', () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            teardown.noteUnstake({ signingPubkey: 'aa', amount: '400' })
            assert.strictEqual(teardown.outstanding().length, 1)
        })

        it('a contract unstake discharges only its own contract stake', () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1', contractIndex: 7, tick: 'TOK' })
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1' })
            teardown.noteUnstake({ signingPubkey: 'aa', contractIndex: 7, tick: 'TOK' })
            const out = teardown.outstanding()
            assert.strictEqual(out.length, 1)
            assert.strictEqual(out[0].contractIndex, null)
        })

        it('re-staking a released pubkey revives the debt', () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            teardown.noteUnstake({ signingPubkey: 'aa' })
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            assert.strictEqual(teardown.outstanding().length, 1)
        })
    })

    describe('readCapabilitySet', () => {
        it('reads the set at the tip through the source-keyed view', async () => {
            const indexer = fakeIndexer([
                { pubkey: 'AA', source: 's1', weight: '1000' },
                { pubkey: 'bb', source: 's1', weight: '1000' }
            ])
            const set = await teardown.readCapabilitySet({ indexer, capability: 'oracle_publish' })
            assert.deepStrictEqual(set.pubkeys, ['aa', 'bb'])
            assert.deepStrictEqual(set.sources, ['s1'])
            assert.strictEqual(set.blockIndex, 900)
            assert.strictEqual(indexer.calls[1].params.capability, 'oracle_publish')
            assert.strictEqual(indexer.calls[1].params.block_index, 900)
        })

        it('reports the rejection instead of throwing, so a run still finishes', async () => {
            const set = await teardown.readCapabilitySet({
                indexer: fakeIndexer([], { throwOn: 'getstakeweightsbycapability' })
            })
            assert.match(set.error, /rpc rejected/)
        })

        it('returns null on a transport failure rather than an empty baseline', async () => {
            const set = await teardown.readCapabilitySet({ indexer: fakeIndexer([], { nullOn: 'getblockhashes' }) })
            assert.strictEqual(set, null, 'an unreadable tip must not read as "the set was empty"')
        })
    })

    describe('diffAgainstBaseline', () => {
        const base = { pubkeys: ['aa', 'bb'] }

        it('names the keys the run added', () => {
            const d = teardown.diffAgainstBaseline(base, { pubkeys: ['aa', 'bb', 'cc'] })
            assert.deepStrictEqual(d.added, ['cc'])
            assert.strictEqual(d.grew, true)
        })

        it('a set that shrank is not a leak', () => {
            const d = teardown.diffAgainstBaseline(base, { pubkeys: ['aa'] })
            assert.deepStrictEqual(d.added, [])
            assert.deepStrictEqual(d.removed, ['bb'])
            assert.strictEqual(d.grew, false)
        })

        it('a swap of equal size is still a leak', () => {
            const d = teardown.diffAgainstBaseline(base, { pubkeys: ['aa', 'cc'] })
            assert.deepStrictEqual(d.added, ['cc'])
            assert.strictEqual(d.grew, true, 'same count, different members: the run still left a key behind')
        })

        it('declines to diff when either side is unreadable', () => {
            assert.strictEqual(teardown.diffAgainstBaseline(null, { pubkeys: [] }), null)
            assert.strictEqual(teardown.diffAgainstBaseline({ error: 'x' }, { pubkeys: [] }), null)
            assert.strictEqual(teardown.diffAgainstBaseline(base, { error: 'x' }), null)
        })
    })

    describe('releaseStakes', () => {
        it('unstakes every outstanding stake and mines the settle blocks', async () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            teardown.registerStake({ addressInfo: addr('s2'), signingPubkey: 'bb', amount: '2000' })
            const unstaked = [], mined = []
            let synced = false

            const r = await teardown.releaseStakes({
                unstake:      async (e) => { unstaked.push(e.signingPubkey) },
                mine:         async (n) => { mined.push(n) },
                waitForSync:  async ()  => { synced = true },
                settleBlocks: 14,
                log:          () => {}
            })

            assert.deepStrictEqual(unstaked, ['aa', 'bb'])
            assert.deepStrictEqual(mined, [14], 'the release must bury the deactivation, not just broadcast it')
            assert.strictEqual(synced, true)
            assert.strictEqual(r.released.length, 2)
            assert.strictEqual(teardown.outstanding().length, 0)
        })

        it('a stake that will not release is reported, and the rest still go back', async () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            teardown.registerStake({ addressInfo: addr('s2'), signingPubkey: 'bb', amount: '2000' })

            const r = await teardown.releaseStakes({
                unstake: async (e) => { if(e.signingPubkey === 'aa') throw new Error('no utxos') },
                mine:    async () => {},
                settleBlocks: 14,
                log:     () => {}
            })

            assert.strictEqual(r.released.length, 1)
            assert.strictEqual(r.failed.length, 1)
            assert.match(r.failed[0].error, /no utxos/)
            assert.strictEqual(teardown.outstanding().length, 1, 'the unreleased stake stays on the books')
        })

        it('does not mine when nothing was released', async () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            let mined = 0
            await teardown.releaseStakes({
                unstake: async () => { throw new Error('nope') },
                mine:    async () => { mined++ },
                settleBlocks: 14,
                log:     () => {}
            })
            assert.strictEqual(mined, 0)
        })

        it('stops at the budget and says what it did not get to', async () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'aa', amount: '1000' })
            const r = await teardown.releaseStakes({
                unstake:  async () => {},
                budgetMs: -1000,
                log:      () => {}
            })
            assert.strictEqual(r.attempted, 0)
            assert.strictEqual(r.skipped.length, 1)
            assert.match(r.skipped[0].reason, /budget/)
        })

        it('is a no-op when the run staked nothing', async () => {
            let called = false
            const r = await teardown.releaseStakes({ unstake: async () => { called = true }, log: () => {} })
            assert.strictEqual(called, false)
            assert.strictEqual(r.released.length, 0)
        })
    })

    describe('runTeardown', () => {
        const baseline = { capability: 'oracle_publish', blockIndex: 900, pubkeys: ['aa'], sources: ['s0'] }

        it('leaves a dedicated staking venue alone and says why', async () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1000' })
            let called = false
            const state = await teardown.runTeardown({
                policy:  teardown.policy({ E2E_STAKE_TEARDOWN: 'off' }),
                unstake: async () => { called = true },
                log:     () => {}
            })
            assert.strictEqual(called, false)
            assert.strictEqual(state.declined, true)
            assert.strictEqual(teardown.outstanding().length, 1)
        })

        it('releases, re-reads the set, and reports a clean run', async () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1000' })
            const lines = []
            const state = await teardown.runTeardown({
                policy:   teardown.policy({}),
                baseline: baseline,
                indexer:  fakeIndexer([{ pubkey: 'aa', source: 's0', weight: '1' }]),
                unstake:  async () => {},
                mine:     async () => {},
                log:      (l) => lines.push(l)
            })
            assert.strictEqual(state.diff.grew, false)
            assert.ok(!lines.join('\n').includes('LEAK'))
        })

        it('names every key a leaking run left behind', async () => {
            const lines = []
            const state = await teardown.runTeardown({
                policy:   teardown.policy({}),
                baseline: baseline,
                indexer:  fakeIndexer([
                    { pubkey: 'aa', source: 's0', weight: '1' },
                    { pubkey: 'cc', source: 's1', weight: '250000' }
                ]),
                log: (l) => lines.push(l)
            })
            assert.deepStrictEqual(state.diff.added, ['cc'])
            const out = lines.join('\n')
            assert.match(out, /LEAK/)
            assert.match(out, /LEAKED  cc/)
        })

        it('fails the run under strict mode when the set grew', async () => {
            await assert.rejects(
                teardown.runTeardown({
                    policy:   teardown.policy({ E2E_STAKE_TEARDOWN_STRICT: '1' }),
                    baseline: baseline,
                    indexer:  fakeIndexer([
                        { pubkey: 'aa', source: 's0', weight: '1' },
                        { pubkey: 'cc', source: 's1', weight: '1' }
                    ]),
                    log: () => {}
                }),
                /left 1 key\(s\) in the oracle_publish set \(1 -> 2\)/
            )
        })

        it('does not fail a strict run for an unreadable baseline', async () => {
            const state = await teardown.runTeardown({
                policy:   teardown.policy({ E2E_STAKE_TEARDOWN_STRICT: '1' }),
                baseline: { error: 'indexer down' },
                indexer:  fakeIndexer([]),
                log:      () => {}
            })
            assert.strictEqual(state.diff, null, 'no baseline means no verdict, not a manufactured one')
        })

        it('does not fail a strict run when a release could not finish but the set did not grow', async () => {
            teardown.registerStake({ addressInfo: addr('s1'), signingPubkey: 'bb', amount: '1000' })
            const state = await teardown.runTeardown({
                policy:   teardown.policy({ E2E_STAKE_TEARDOWN_STRICT: '1' }),
                baseline: baseline,
                indexer:  fakeIndexer([{ pubkey: 'aa', source: 's0', weight: '1' }]),
                unstake:  async () => { throw new Error('broadcast refused') },
                log:      () => {}
            })
            assert.strictEqual(state.release.failed.length, 1)
            assert.strictEqual(state.diff.grew, false)
        })
    })

    describe('formatReport', () => {
        it('carries the policy, the sweep and the verdict in one block', () => {
            const text = teardown.formatReport({
                policy:  teardown.policy({}),
                release: { released: [1], failed: [], skipped: [], mined: 14 },
                baseline: { pubkeys: ['aa'] },
                current:  { pubkeys: ['aa'] },
                diff:     { added: [], removed: [], beforeCount: 1, afterCount: 1, grew: false }
            })
            assert.match(text, /capability=oracle_publish/)
            assert.match(text, /released 1\/1 fixture stake\(s\), mined 14 settle block\(s\)/)
            assert.match(text, /oracle_publish: 1 -> 1 member\(s\)/)
        })

        it('says the check did not run when there was no baseline', () => {
            const text = teardown.formatReport({ policy: teardown.policy({}) })
            assert.match(text, /no baseline was captured/)
        })
    })
})
