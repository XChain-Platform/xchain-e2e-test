const assert = require('assert')
const { protocol, assertVendored } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // CROSS_SETTLE_MAX_PER_BLOCK is the per-block cross-chain settlement slice the
    // indexer applies behind the CROSS_SETTLE_PER_BLOCK_CAP flag day (utility.js
    // processCrossChainSettlements, db.js getEffectiveUnsettledMatches), so it is
    // consensus-visible once armed: two operators reading different values settle
    // different prefixes at the same block. The indexer's own cap tests read the
    // value out of the vendored copy and compare it to itself. The full-export
    // block below catches module drift, while this check identifies this cap by
    // name, as the rest of this block does (uuid 0fe9fc61).
    it('[regression:p0] CROSS_SETTLE_MAX_PER_BLOCK === canonical in the indexer vendored copy (uuid 0fe9fc61)', () => {
        assertVendored('CROSS_SETTLE_MAX_PER_BLOCK', ['xchain-indexer'])
    })

    // Pin the inherited-policy membership ceiling on both halves of the rule: the
    // indexer refuses a format-7 opt-in over it, the hub declines to sign a snapshot
    // over it from a bare literal of its own. A one-sided edit lets the hub sign a
    // snapshot the indexer's opt-in would refuse, or strand one it would accept.
    it('[regression:p0] XPOLICY_MAX_MEMBERS === canonical across hub bridge constants + indexer vendored copy', () => {
        const hubBridge = require('../../../../xchain-hub/src/cross_chain/bridge/constants.js')
        // A dropped export on every side would compare undefined to undefined and pass.
        assert.ok(Number.isFinite(protocol.XPOLICY_MAX_MEMBERS),
            'XPOLICY_MAX_MEMBERS is not a finite value on the canonical protocol constants module')
        assert.strictEqual(hubBridge.XPOLICY_MAX_MEMBERS, protocol.XPOLICY_MAX_MEMBERS,
            'hub cross_chain/bridge/constants.js XPOLICY_MAX_MEMBERS drifted from the canonical protocol constant; ' +
            'the hub would sign policy snapshots the indexer sizes differently')
        assertVendored('XPOLICY_MAX_MEMBERS', ['xchain-indexer'])
    })

    // Bind the ROLLCALL eviction scalars to canonical (the hub signs, the indexer judges,
    // each from its own bare literal in src/consensus/gates/rollcall_gate.js). Neither repo compares
    // its copy to canonical: the hub pins 2 / 4 / 0 as literals of its own and the indexer
    // only asserts the 2K relation, so the twin can be edited in step and leave the map of
    // record behind with nothing red (uuids 88da060f, 602f690e, 2fbdb0ef).
    it('[regression:p0] ROLLCALL_EVICT_MISSES / _STREAK_LOOKBACK / _REGTEST_ARMED_HEIGHT === canonical across hub + indexer', () => {
        const hubRollcall     = require('../../../../xchain-hub/src/consensus/gates/rollcall_gate.js')
        const indexerRollcall = require('../../../../xchain-indexer/src/consensus/gates/rollcall_gate.js')
        const names = [
            'ROLLCALL_EVICT_MISSES', 'ROLLCALL_STREAK_LOOKBACK', 'ROLLCALL_REGTEST_ARMED_HEIGHT',
        ]
        names.forEach((name) => {
            // A dropped export on both sides would compare undefined to undefined and pass.
            assert.ok(Number.isFinite(protocol[name]),
                name + ' is not a finite value on the canonical protocol constants module')
            assert.strictEqual(hubRollcall[name], protocol[name],
                'hub rollcall_activation ' + name + ' drifted from the canonical protocol constant; ' +
                'the hub would sign for an epoch set the indexer does not judge the same way')
            assert.strictEqual(indexerRollcall[name], protocol[name],
                'indexer rollcall_activation ' + name + ' drifted from the canonical protocol constant; ' +
                'the indexer is the only place the eviction predicate runs, so its copy decides who is evicted')
        })
        // The lookback is 2K by construction; a canonical edit to one alone strands the window.
        assert.strictEqual(protocol.ROLLCALL_STREAK_LOOKBACK, 2 * protocol.ROLLCALL_EVICT_MISSES,
            'canonical ROLLCALL_STREAK_LOOKBACK is no longer exactly 2 x ROLLCALL_EVICT_MISSES')
    })
})
