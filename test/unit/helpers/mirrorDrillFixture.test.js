'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The one part of the attest-mirror drill prologue that can be judged without a
// chain: how far past a stake a request has to sit before that stake is
// selectable.
//
// It is worth pinning precisely because getting it wrong is invisible. Mine too
// few blocks and the stake is real, confirmed and simply not yet visible to the
// capability snapshot, so the responsible set comes back short, the request is
// refused at admission, and the EXECUTE that emitted it rolls back with no
// valid execution row. Nothing in that chain of events mentions a stake.

const assert = require('assert')

const { stakeVisibilityBlocks } = require('../../attestMirror/mirrorDrillFixture')
const stakeHelper = require('../../helpers/stakeHelper')
const { loadHubModule } = require('../../helpers/multiValidatorHubHelper')

describe('mirrorDrillFixture: stake visibility distance', function () {

    it('accepts BTC, the chain every attest drill runs on', () => {
        // BTC activation is 6 and the burial is 6, so the shared constant's 14
        // carries two blocks of margin. This is the only combination the drills
        // actually use, so it must not merely pass, it must pass for the stated
        // reason: read both terms and check the arithmetic rather than the result.
        const activation = Number(
            loadHubModule('src/coins/index.js').getCoinConfig('BTC', 'regtest').STAKING.ACTIVATION_DELAY_BLOCKS)
        const burial = Number(loadHubModule('src/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)
        const shared = Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)

        assert.strictEqual(activation, 6, 'BTC activation delay moved; the shared constant needs re-checking')
        assert.strictEqual(burial, 6, 'CANONICAL_REORG_BUFFER moved; the shared constant needs re-checking')
        assert.ok(shared >= activation + burial)
        assert.strictEqual(stakeVisibilityBlocks('BTC', 'regtest'), shared)
    })

    it('REFUSES a chain whose activation delay outruns the shared constant', () => {
        // DOGE's activation delay is 60, so the shared 14 is nowhere near enough
        // and a drill pointed at that chain would stake, mine 14, and then watch
        // its requests get refused at admission for no visible reason. This is
        // not hypothetical padding: the attest BATCH rail rides DOGE, so a future
        // drill on that chain is a question of when.
        assert.throws(() => stakeVisibilityBlocks('DOGE', 'regtest'), (e) => {
            assert.ok(/60 activation \+ 6 burial = 66/.test(e.message),
                'the refusal must show the arithmetic it refused on, got: ' + e.message)
            assert.ok(/ATTESTATION_STAKE_VISIBLE_BLOCKS is 14/.test(e.message),
                'the refusal must name the constant that is too small, got: ' + e.message)
            return true
        })
    })

    it('refuses LTC too, which is the near miss rather than the obvious one', () => {
        // 24 + 6 = 30 against 14. Included separately from DOGE because a rule
        // that only catches the extreme case is easy to write by accident.
        assert.throws(() => stakeVisibilityBlocks('LTC', 'regtest'),
            /24 activation \+ 6 burial = 30/)
    })

    it('takes the harness COIN global, which is a full name and not a ticker', () => {
        // The bug this caught on AT1's first run. The harness sets COIN to
        // 'bitcoin' while the registry is keyed by 'BTC', so passing COIN
        // straight through asked for 'BITCOIN' and the guard refused. It
        // refused CORRECTLY, which is why this is a translation fix rather than
        // a loosened rule: the drill would otherwise have staked and mined the
        // wrong number of blocks against a chain nobody had checked.
        assert.strictEqual(stakeVisibilityBlocks('bitcoin', 'regtest'),
            Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
        assert.strictEqual(stakeVisibilityBlocks('BITCOIN', 'regtest'),
            Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
        // And the full names still route to the per-chain answer rather than
        // collapsing to BTC's: dogecoin must refuse exactly as DOGE does.
        assert.throws(() => stakeVisibilityBlocks('dogecoin', 'regtest'),
            /60 activation \+ 6 burial = 66/)
    })

    it('refuses a coin it cannot resolve rather than falling back to a default', () => {
        // A silent default here is the whole failure mode: it would hand back 14
        // for a chain nobody checked.
        assert.throws(() => stakeVisibilityBlocks('NOPE', 'regtest'),
            /could not read STAKING.ACTIVATION_DELAY_BLOCKS/)
    })

    it('defaults to BTC when given nothing, rather than throwing on an absent argument', () => {
        // The drills call it through stakeDrillIdentities, which passes the
        // harness COIN; a bare call is the developer-console path and should
        // answer for the chain the drills use.
        assert.strictEqual(stakeVisibilityBlocks(), Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS))
    })
})
