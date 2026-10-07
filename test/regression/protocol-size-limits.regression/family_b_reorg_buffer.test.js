const assert = require('assert')
const { protocol } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // Four fleet-agreed operational bounds with no value-level assertion here: the
    // reorg burial depth, the anchor-reward mirror watermark, the BATCH command cap
    // and the per-block cross-chain settlement slice. Three of them are bare
    // literals living in a src/ module per repo, which the full-export block
    // below cannot see at all. The one twin that does exist, for
    // BATCH_COMMAND_LIMIT in xchain-documentation's protocol-constant-claims
    // .test.js, SKIPS in its own repo's CI, which is hermetic by design (no sibling
    // checkouts), so this suite is the only lane that sees the copies at once
    // (uuids 96193535, 27c632bf, 500f2f11, 0fe9fc61).

    it('[regression:p0] CANONICAL_REORG_BUFFER === canonical across hub + indexer + sdk (uuid 96193535)', () => {
        // Every consumer buries exactly once, locally: the hub resolves a capability
        // snapshot at H - CANONICAL_REORG_BUFFER, and the three verifier families that
        // re-derive that set from on-chain state (indexer attest/index.js, indexer
        // recovery.js, sdk light.js) must bury by the identical depth or they resolve
        // a different signer set than the hub that signed the artifact. Each repo
        // holds its own bare literal; the indexer's test/unit/recovery/snapshot_reorg_buffer.test.js pins
        // its copy to the literal 6 and cross-checks the hub copy, never canonical,
        // and the sdk copy had no guard anywhere.
        const reorgCopies = {
            'xchain-hub':     require('../../../../xchain-hub/src/consensus/snapshot_reorg_buffer.js'),
            'xchain-indexer': require('../../../../xchain-indexer/src/consensus/snapshot_reorg_buffer.js'),
            'xchain-sdk':     require('../../../../xchain-sdk/src/consensus/snapshot_reorg_buffer.js'),
            // The documentation repo's own reference implementation is the vector
            // source consumers are checked against; nothing in that repo compares it
            // to constants.js, so it drifts silently too.
            'xchain-documentation reference-impl':
                require('../../../../xchain-documentation/protocol/reference-impl/consensus/snapshot_reorg_buffer.js'),
        }
        Object.keys(reorgCopies).forEach((svc) => {
            assert.strictEqual(
                reorgCopies[svc].CANONICAL_REORG_BUFFER,
                protocol.CANONICAL_REORG_BUFFER,
                svc + ' CANONICAL_REORG_BUFFER drifted from the canonical protocol constant; ' +
                'a verifier would resolve the capability snapshot at a different height than the hub that signed it'
            )
        })
    })
})
