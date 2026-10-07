const assert = require('assert')
const { bitcoin, protocol, encoderValidator, XChainDecoder } = require('./support/environment')

void describe('ACTION data cap (root cause behind the encoder/decoder silent-drop gap)', () => {

    it('[regression:p0] encoder compiled-push cap === decoder cap === canonical', () => {
        assert.strictEqual(
            encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
            protocol.MAX_ACTION_DATA_LENGTH,
            'encoder MAX_COMPILED_ACTION_DATA_LENGTH drifted from the canonical protocol constant'
        )
        assert.strictEqual(
            XChainDecoder.MAX_ACTION_DATA_LENGTH,
            protocol.MAX_ACTION_DATA_LENGTH,
            'decoder MAX_ACTION_DATA_LENGTH drifted from the canonical protocol constant'
        )
        // The invariant this guards: what the encoder is willing to
        // produce must equal what the decoder is willing to accept.
        assert.strictEqual(
            encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
            XChainDecoder.MAX_ACTION_DATA_LENGTH,
            'encoder accepts a different compiled ACTION size than the decoder; payloads in the gap would be silently dropped on chain'
        )
    })

    it('[regression:p0] no compiled-size gap between encoder and decoder at the boundary', () => {
        const limit    = protocol.MAX_ACTION_DATA_LENGTH                       // 8192 compiled
        const overhead = protocol.OP_RETURN_PUSH_OVERHEAD                      // 3
        const maxPayload = limit - overhead                                   // 8189 decoded

        // Largest accepted payload: compiles to exactly the limit.
        const atLimit = bitcoin.script.compile([Buffer.alloc(maxPayload, 0x41)])
        assert.strictEqual(atLimit.length, limit,
            `a ${maxPayload}-byte payload should compile to exactly ${limit} bytes`)
        assert.ok(atLimit.length <= encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
            'encoder must accept the at-limit payload')
        assert.ok(atLimit.length <= XChainDecoder.MAX_ACTION_DATA_LENGTH,
            'decoder must accept the at-limit payload')

        // One byte over: must be rejected by BOTH sides (no silent-drop window).
        const overLimit = bitcoin.script.compile([Buffer.alloc(maxPayload + 1, 0x41)])
        assert.ok(overLimit.length > encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH,
            'encoder must reject the over-limit payload')
        assert.ok(overLimit.length > XChainDecoder.MAX_ACTION_DATA_LENGTH,
            'decoder must reject the over-limit payload; otherwise the encoder could mint a tx the decoder drops')
    })
})
