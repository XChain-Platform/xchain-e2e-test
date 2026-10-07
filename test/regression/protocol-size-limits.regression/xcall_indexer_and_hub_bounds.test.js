const assert = require('assert')
const { protocol, indexerXcall, hubConstants, XCALL_FIELDS } = require('./support/environment')

void describe('XCALL consensus bounds (indexer is the arbiter)', () => {

    // The indexer xcall/index.js values gate cross-chain calls on chain. They are
    // literal-copied into the canonical module; assert they have not drifted.

    XCALL_FIELDS.forEach((field) => {
        it('[regression:p0] indexer ' + field + ' === canonical', () => {
            assert.strictEqual(
                indexerXcall[field],
                protocol[field],
                'indexer ' + field + ' drifted from the canonical protocol constant'
            )
        })
    })

    // The hub keeps its own defense-in-depth copy (cross_chain/call_engine.js
    // rejects any relay whose cross_hops exceeds it before ever reaching the
    // indexer arbiter). If the hub relaxed while the indexer stayed strict, the
    // hub would PBFT-sign a relay row the indexer then rejects (wasted round).
    it('[regression:p0] hub XCALL_MAX_HOPS === canonical (uuid 74e6/332)', () => {
        assert.strictEqual(
            hubConstants.XCALL_MAX_HOPS,
            protocol.XCALL_MAX_HOPS,
            'hub XCALL_MAX_HOPS drifted from the canonical protocol constant'
        )
    })
})
