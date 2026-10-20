const assert = require('assert')
const { protocol, hubConstants } = require('./support/environment')

void describe('Oracle federation bounds (hub is the arbiter)', () => {

    // PRICE_MAX and ORACLE_DEVIATION_THRESHOLD are declared only in
    // xchain-hub/src/constants.js, which exports all three (with
    // XCALL_MAX_HOPS) together. Mirrors the XCALL_MAX_HOPS parity check
    // above: assert the hub copies against the canonical documentation
    // twin so a hub-side edit or a future consumer re-declaring either
    // literal has a cross-repo tripwire (uuid 2e3ecb5b).

    it('[regression:p0] hub PRICE_MAX === canonical', () => {
        assert.strictEqual(
            hubConstants.PRICE_MAX,
            protocol.PRICE_MAX,
            'hub PRICE_MAX drifted from the canonical protocol constant'
        )
    })

    it('[regression:p0] hub ORACLE_DEVIATION_THRESHOLD === canonical', () => {
        assert.strictEqual(
            hubConstants.ORACLE_DEVIATION_THRESHOLD,
            protocol.ORACLE_DEVIATION_THRESHOLD,
            'hub ORACLE_DEVIATION_THRESHOLD drifted from the canonical protocol constant'
        )
    })

    // Pin the per-round move clamps the hub re-declares: a divergent clamp forks
    // the federation, since hubs re-derive each other's aggregates before co-signing.
    it('[regression:p0] hub ORACLE_MAX_CHANGE_PER_ROUND === canonical', () => {
        assert.strictEqual(
            hubConstants.ORACLE_MAX_CHANGE_PER_ROUND,
            protocol.ORACLE_MAX_CHANGE_PER_ROUND,
            'hub ORACLE_MAX_CHANGE_PER_ROUND drifted from the canonical protocol constant'
        )
    })

    it('[regression:p0] hub XCHAIN_PRICE_MAX_CHANGE_PER_ROUND === canonical', () => {
        assert.strictEqual(
            hubConstants.XCHAIN_PRICE_MAX_CHANGE_PER_ROUND,
            protocol.XCHAIN_PRICE_MAX_CHANGE_PER_ROUND,
            'hub XCHAIN_PRICE_MAX_CHANGE_PER_ROUND drifted from the canonical protocol constant'
        )
    })
})
