const assert = require('assert')
const { protocol, sdkValidator, indexerDeploy, XChainVM, explorerVmQuery } = require('./support/environment')

void describe('Contract code-size cap (MAX_CODE_SIZE)', () => {

    it('[regression:p0] SDK MAX_CODE_SIZE === canonical', () => {
        assert.strictEqual(
            sdkValidator.MAX_CODE_SIZE,
            protocol.MAX_CODE_SIZE,
            'SDK MAX_CODE_SIZE drifted from the canonical protocol constant; the indexer (DEPLOY) and VM isolate limit must also stay equal to this value'
        )
    })

    it('[regression:p0] indexer DEPLOY MAX_CODE_SIZE === canonical', () => {
        // The indexer is the on-chain arbiter for contract code size. It
        // rejects any DEPLOY whose code exceeds this. If it drifts below the
        // SDK/encoder, a contract the SDK accepts would be rejected on chain.
        assert.strictEqual(
            indexerDeploy.MAX_CODE_SIZE,
            protocol.MAX_CODE_SIZE,
            'indexer DEPLOY MAX_CODE_SIZE drifted from the canonical protocol constant'
        )
    })

    it('[regression:p0] VM isolate maxCodeSize === canonical', () => {
        assert.strictEqual(
            XChainVM.MAX_CODE_SIZE,
            protocol.MAX_CODE_SIZE,
            'VM isolate code-size limit drifted from the canonical protocol constant'
        )
    })

    // Pins the same MAX_CODE_SIZE limit the explorer's own unit test
    // (xchain-explorer/test/unit/vm_query.test.js) checks, from the
    // protocol side, so a skipped explorer suite cannot let it drift.
    it('[regression:p0] explorer vm-query MAX_CODE_SIZE === canonical', () => {
        assert.strictEqual(
            explorerVmQuery.MAX_CODE_SIZE,
            protocol.MAX_CODE_SIZE,
            'explorer vm-query MAX_CODE_SIZE drifted from the canonical protocol constant; the read-only query isolate would reject (or over-accept) contract code the chain itself indexed'
        )
    })
})
