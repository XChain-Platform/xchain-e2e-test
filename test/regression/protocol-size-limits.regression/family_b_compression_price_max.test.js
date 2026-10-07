const assert = require('assert')
const { protocol, encoderValidator, hubConstants, vendoredConstants, assertVendored } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // COMPRESSION_MAX_RATIO is the inflation bound that makes a compressed
    // payload safe to stream: a decompressor that stops later than the encoder
    // planned is a zip-bomb surface. The encoder (src/common/validator.js) and the
    // explorer compression reader (src/http/compression.js) each declare a bare
    // literal; the explorer's only guard compared itself to the encoder, so the
    // pair could drift from canonical together and stay green (uuid 3499).
    it('[regression:p0] COMPRESSION_MAX_RATIO === canonical across encoder + explorer + sdk', () => {
        const explorerCompression = require('../../../../xchain-explorer/src/http/compression.js')
        const sdkCompression      = require('../../../../xchain-sdk/src/protocol/compression.js')
        assert.strictEqual(
            encoderValidator.COMPRESSION_MAX_RATIO,
            protocol.COMPRESSION_MAX_RATIO,
            'encoder validator COMPRESSION_MAX_RATIO drifted from the canonical protocol constant'
        )
        assert.strictEqual(
            explorerCompression.COMPRESSION_MAX_RATIO,
            protocol.COMPRESSION_MAX_RATIO,
            'explorer compression COMPRESSION_MAX_RATIO drifted from the canonical protocol constant; the explorer would inflate past what the encoder was willing to produce'
        )
        assert.strictEqual(
            sdkCompression.COMPRESSION_MAX_RATIO,
            protocol.COMPRESSION_MAX_RATIO,
            'SDK compression COMPRESSION_MAX_RATIO drifted from the canonical protocol constant'
        )
        assertVendored('COMPRESSION_MAX_RATIO', ['xchain-sdk'])
    })

    // The oracle-band block above pins the HUB copies of PRICE_MAX and
    // ORACLE_DEVIATION_THRESHOLD, and the hub is the arbiter, but all five
    // vendored consumers re-declare both and nothing bound those copies: the
    // off-disk cross-repo freeze gate (xchain-indexer
    // test/unit/xcall-constants-cross-repo.test.js) gates only MAX_CODE_SIZE
    // and three XCALL bounds, and its participating repo list is vm, indexer
    // and sdk, so the decoder and explorer copies sit outside it entirely.
    // xchain-hub test/unit/shared/constants_conformance.test.js records the missing
    // twin as pending coordinated work; this is that twin, on the side that
    // can see every sibling at once (uuid ae66b1df).
    it('[regression:p0] PRICE_MAX / ORACLE_DEVIATION_THRESHOLD === canonical in every vendored copy', () => {
        const services = ['xchain-vm', 'xchain-indexer', 'xchain-explorer', 'xchain-sdk', 'xchain-decoder']
        assertVendored('PRICE_MAX', services)
        assertVendored('ORACLE_DEVIATION_THRESHOLD', services)
        // The hub arm exists above; assert the hub and the consumers agree too,
        // so a coordinated bump that misses the hub cannot pass on canonical alone.
        services.forEach((svc) => {
            assert.strictEqual(vendoredConstants[svc].PRICE_MAX, hubConstants.PRICE_MAX,
                svc + ' vendored PRICE_MAX disagrees with the hub, which is the arbiter for the oracle band')
            assert.strictEqual(
                vendoredConstants[svc].ORACLE_DEVIATION_THRESHOLD,
                hubConstants.ORACLE_DEVIATION_THRESHOLD,
                svc + ' vendored ORACLE_DEVIATION_THRESHOLD disagrees with the hub, which is the arbiter for the oracle band')
        })
    })
})
