const assert = require('assert')
const { protocol, XChainVM, readIndexerExecuteCallCaps } = require('./support/environment')

void describe('VM call-depth / call-gas consensus bounds (VM emit-time vs indexer re-validation)', () => {

    // VM_MAX_CALL_DEPTH / VM_MIN_CALL_GAS are literal-copied into the VM
    // (emit-time enforcement, now exported) and the indexer's host-side
    // re-validation copy (inline consts in execute/index.js, read via source scan
    // since they are not exported). A drift between VM emit-time and indexer
    // re-validation would fork execution outcomes (uuid 334).
    it('[regression:p0] VM MAX_CALL_DEPTH / MIN_CALL_GAS === canonical', () => {
        assert.strictEqual(
            XChainVM.MAX_CALL_DEPTH,
            protocol.VM_MAX_CALL_DEPTH,
            'VM MAX_CALL_DEPTH drifted from the canonical VM_MAX_CALL_DEPTH protocol constant'
        )
        assert.strictEqual(
            XChainVM.MIN_CALL_GAS,
            protocol.VM_MIN_CALL_GAS,
            'VM MIN_CALL_GAS drifted from the canonical VM_MIN_CALL_GAS protocol constant'
        )
    })

    it('[regression:p0] indexer execute/index.js re-validation MAX_CALL_DEPTH / MIN_CALL_GAS === canonical', () => {
        const indexerCaps = readIndexerExecuteCallCaps()
        assert.strictEqual(
            indexerCaps.MAX_CALL_DEPTH,
            protocol.VM_MAX_CALL_DEPTH,
            'indexer execute/index.js MAX_CALL_DEPTH drifted from the canonical VM_MAX_CALL_DEPTH protocol constant'
        )
        assert.strictEqual(
            indexerCaps.MIN_CALL_GAS,
            protocol.VM_MIN_CALL_GAS,
            'indexer execute/index.js MIN_CALL_GAS drifted from the canonical VM_MIN_CALL_GAS protocol constant'
        )
    })
})
