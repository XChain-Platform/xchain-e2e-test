const assert = require('assert')
const { protocol, indexerXcall, indexerXexec, XChainVM, XCALL_FIELDS } = require('./support/environment')

void describe('XCALL consensus bounds (indexer is the arbiter)', () => {

    // XCALL_MAX_RETURN_BYTES is enforced in a different indexer module
    // (xexec.js, not xcall/index.js): an oversize return becomes status
    // 'payload_too_large' with an empty payload. Asserted separately since it
    // does not live on indexerXcall (uuid 333).
    it('[regression:p0] indexer xexec XCALL_MAX_RETURN_BYTES === canonical (uuid 333)', () => {
        assert.strictEqual(
            indexerXexec.XCALL_MAX_RETURN_BYTES,
            protocol.XCALL_MAX_RETURN_BYTES,
            'indexer xexec.js XCALL_MAX_RETURN_BYTES drifted from the canonical protocol constant'
        )
    })

    // The VM ships an exported copy of XCALL_MAX_RETURN_BYTES too (index.js
    // declares and exports it for parity). It is informational rather than an
    // enforcement gate today, but an exported copy can drift silently, so
    // assert it against canonical alongside the indexer xexec copy (uuid a27c).
    it('[regression:p0] VM XCALL_MAX_RETURN_BYTES === canonical (uuid a27c)', () => {
        assert.strictEqual(
            XChainVM.XCALL_MAX_RETURN_BYTES,
            protocol.XCALL_MAX_RETURN_BYTES,
            'VM XCALL_MAX_RETURN_BYTES drifted from the canonical protocol constant'
        )
    })

    // The VM is the emit-time arbiter for cross-chain calls (gateway-emit.js
    // crossExecute enforces these bounds before the indexer ever sees the
    // call); the indexer re-validates the same bounds host-side. If the VM's
    // copy drifted from canonical, the VM would emit a crossExecute the
    // indexer then rejects (or vice-versa), forking cross-chain execution
    // with no failing test. This was the last unguarded copy of the XCALL
    // bound family (uuid 922e2a57).
    XCALL_FIELDS.filter((field) => field !== 'XCALL_MAX_CALLS_PER_BLOCK').forEach((field) => {
        it('[regression:p0] VM ' + field + ' === canonical', () => {
            assert.strictEqual(
                XChainVM[field],
                protocol[field],
                'VM ' + field + ' drifted from the canonical protocol constant'
            )
        })
    })
})
