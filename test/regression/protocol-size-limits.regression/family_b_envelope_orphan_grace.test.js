const assert = require('assert')
const { protocol, encoderValidator, XChainDecoder, indexerXcall, assertVendored } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // ENVELOPE_MAX_PAYLOAD is the Taproot-envelope payload ceiling, derived
    // from MAX_STANDARD_TX_WEIGHT rather than chosen. This guards exactly the
    // incident that motivated it: the old value built a 402,789 WU reveal that the
    // encoder produced, the validator accepted and no node relayed. The encoder
    // still declares its own bare literal (src/validator.js), which nothing here
    // compared to canonical (uuid 3497).
    it('[regression:p0] ENVELOPE_MAX_PAYLOAD === canonical across encoder + decoder + vendored copies', () => {
        assert.strictEqual(
            encoderValidator.ENVELOPE_MAX_PAYLOAD,
            protocol.ENVELOPE_MAX_PAYLOAD,
            'encoder validator ENVELOPE_MAX_PAYLOAD drifted from the canonical protocol constant; the encoder would mint an envelope reveal the decoder or the network rejects'
        )
        assert.strictEqual(
            XChainDecoder.ENVELOPE_MAX_PAYLOAD,
            protocol.ENVELOPE_MAX_PAYLOAD,
            'decoder ENVELOPE_MAX_PAYLOAD drifted from the canonical protocol constant'
        )
        assertVendored('ENVELOPE_MAX_PAYLOAD', ['xchain-sdk', 'xchain-decoder'])
        // What the encoder will build must equal what the decoder will accept,
        // the same invariant the ACTION data cap block asserts for legacy lanes.
        assert.strictEqual(
            encoderValidator.ENVELOPE_MAX_PAYLOAD,
            XChainDecoder.ENVELOPE_MAX_PAYLOAD,
            'encoder and decoder disagree on the envelope payload ceiling; payloads in the gap would be built and then dropped'
        )
    })

    // XCALL_RESULT_ORPHAN_GRACE_SECONDS is the age-out clock for an XCALL
    // result row with no local request. It decides when a row is
    // pruned rather than left starving the XCALL_MAX_CALLS_PER_BLOCK delivery
    // slice, so a drift changes which results get delivered (uuid 3498).
    it('[regression:p0] XCALL_RESULT_ORPHAN_GRACE_SECONDS === canonical across indexer xcall + vendored copy', () => {
        assert.strictEqual(
            indexerXcall.XCALL_RESULT_ORPHAN_GRACE_SECONDS,
            protocol.XCALL_RESULT_ORPHAN_GRACE_SECONDS,
            'indexer xcall/index.js XCALL_RESULT_ORPHAN_GRACE_SECONDS drifted from the canonical protocol constant'
        )
        assertVendored('XCALL_RESULT_ORPHAN_GRACE_SECONDS', ['xchain-indexer'])
    })
})
