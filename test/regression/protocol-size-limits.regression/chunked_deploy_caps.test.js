const assert = require('assert')
const { protocol, encoderValidator, indexerDeploy } = require('./support/environment')

void describe('Chunked DEPLOY caps (MAX_DEPLOY_CHUNKS / MAX_DEPLOYCHUNK_PART_BYTES)', () => {

    const chunkHelper        = require('../../../../xchain-sdk/src/contract/chunk_helper.js')
    const indexerDeployChunk = require('../../../../xchain-indexer/src/actions/deploy/deploy_chunk.js')

    it('[regression:p0] MAX_DEPLOY_CHUNKS === canonical across SDK + indexer', () => {
        assert.strictEqual(chunkHelper.MAX_DEPLOY_CHUNKS, protocol.MAX_DEPLOY_CHUNKS,
            'SDK chunkHelper MAX_DEPLOY_CHUNKS drifted from the canonical protocol constant')
        assert.strictEqual(indexerDeploy.MAX_DEPLOY_CHUNKS, protocol.MAX_DEPLOY_CHUNKS,
            'indexer DEPLOY MAX_DEPLOY_CHUNKS drifted from the canonical protocol constant')
        assert.strictEqual(indexerDeployChunk.MAX_DEPLOY_CHUNKS, protocol.MAX_DEPLOY_CHUNKS,
            'indexer v4-carrier MAX_DEPLOY_CHUNKS drifted from the canonical protocol constant')
    })

    it('[regression:p0] MAX_DEPLOYCHUNK_PART_BYTES === canonical across SDK + indexer', () => {
        assert.strictEqual(chunkHelper.MAX_DEPLOYCHUNK_PART_BYTES, protocol.MAX_DEPLOYCHUNK_PART_BYTES,
            'SDK chunkHelper MAX_DEPLOYCHUNK_PART_BYTES drifted from the canonical protocol constant')
        assert.strictEqual(indexerDeployChunk.MAX_DEPLOYCHUNK_PART_BYTES, protocol.MAX_DEPLOYCHUNK_PART_BYTES,
            'indexer v4-carrier MAX_DEPLOYCHUNK_PART_BYTES drifted from the canonical protocol constant')
    })

    it('[regression:p0] OP_RETURN_PUSH_OVERHEAD === canonical across SDK + encoder', () => {
        // Every service that fits payloads into a single OP_RETURN push carries its own
        // copy of the PUSHDATA2 overhead. The SDK chunkHelper exports it directly; the
        // encoder folds it into MAX_DATA_BYTES = MAX_COMPILED_ACTION_DATA_LENGTH - overhead,
        // so its copy is the difference. Both must equal the canonical constant or the
        // single-tx-fit decision (SDK) and the compiled-data cap (encoder) silently diverge.
        assert.strictEqual(chunkHelper.OP_RETURN_PUSH_OVERHEAD, protocol.OP_RETURN_PUSH_OVERHEAD,
            'SDK chunkHelper OP_RETURN_PUSH_OVERHEAD drifted from the canonical protocol constant')
        assert.strictEqual(
            encoderValidator.MAX_COMPILED_ACTION_DATA_LENGTH - encoderValidator.MAX_DATA_BYTES,
            protocol.OP_RETURN_PUSH_OVERHEAD,
            'encoder PUSHDATA2 overhead (MAX_COMPILED_ACTION_DATA_LENGTH - MAX_DATA_BYTES) drifted from the canonical protocol constant')
    })

    it('[regression:p0] MAX_ACTION_DATA_LENGTH === canonical across SDK chunkHelper + co-signer', () => {
        // chunkHelper's copy drives fitsSingleDeploy() (single-tx vs chunked DEPLOY) and is
        // re-exported by the co-signer psbtActionDecode OVERSIZED gate. The decoder copy is
        // guarded above; without this the SDK/co-signer copy could drift so the co-signer
        // refuses PSBTs the decoder accepts and the chunker splits contracts that fit one tx.
        const psbtActionDecode = require('../../../../xchain-sdk/src/cosigner/psbt_action_decode.js')
        assert.strictEqual(chunkHelper.MAX_ACTION_DATA_LENGTH, protocol.MAX_ACTION_DATA_LENGTH,
            'SDK chunkHelper MAX_ACTION_DATA_LENGTH drifted from the canonical protocol constant')
        assert.strictEqual(psbtActionDecode.MAX_ACTION_DATA_LENGTH, protocol.MAX_ACTION_DATA_LENGTH,
            'co-signer psbtActionDecode MAX_ACTION_DATA_LENGTH drifted from the canonical protocol constant')
    })

    it('[regression:p0] a max-size v4-carrier part + action overhead fits the compiled cap', () => {
        // The per-chunk budget must leave room for the DEPLOY v4 carrier action overhead
        // (prefix + 64-char CODE_HASH + indices) under MAX_ACTION_DATA_LENGTH, or a
        // full-size chunk the SDK produces would be silently dropped by the decoder.
        const worst = 'DEPLOY|4|' + 'f'.repeat(64) + '|15|16|' + 'A'.repeat(protocol.MAX_DEPLOYCHUNK_PART_BYTES)
        assert.ok(Buffer.byteLength(worst, 'utf8') + protocol.OP_RETURN_PUSH_OVERHEAD <= protocol.MAX_ACTION_DATA_LENGTH,
            'a max-size DEPLOY v4 carrier part + overhead exceeds MAX_ACTION_DATA_LENGTH')
    })
})
