const assert = require('assert')
const path = require('path')
const { protocol, readIndexerHandler } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // ANCHOR_REWARD_MIRROR_MATURITY decides the BTC height a COLLECT-spendable
    // anchor reward materializes at: a mirrored attestation matures at
    // snapshot_block + this constant. The hub writes the row and the indexer
    // derives the reward, each from its own bare literal in
    // src/consensus/gates/anchor_reward_gate.js. A one-sided edit reproduces the exact defect
    // the constant was introduced to fix, two nodes with different mirror contents
    // deriving the same reward at different BTC heights (uuid 27c632bf).
    it('[regression:p0] ANCHOR_REWARD_MIRROR_MATURITY === canonical across hub + indexer (uuid 27c632bf)', () => {
        const hubAnchor     = require('../../../../xchain-hub/src/consensus/gates/anchor_reward_gate.js')
        const indexerAnchor = require('../../../../xchain-indexer/src/consensus/gates/anchor_reward_gate.js')
        assert.strictEqual(
            hubAnchor.ANCHOR_REWARD_MIRROR_MATURITY,
            protocol.ANCHOR_REWARD_MIRROR_MATURITY,
            'hub anchor_reward_activation ANCHOR_REWARD_MIRROR_MATURITY drifted from the canonical protocol constant'
        )
        assert.strictEqual(
            indexerAnchor.ANCHOR_REWARD_MIRROR_MATURITY,
            protocol.ANCHOR_REWARD_MIRROR_MATURITY,
            'indexer anchor_reward_activation ANCHOR_REWARD_MIRROR_MATURITY drifted from the canonical protocol constant; ' +
            'the hub and the indexer would mature the same mirrored attestation at different BTC heights'
        )
    })

    // BATCH_COMMAND_LIMIT caps the commands one BATCH may carry. The indexer's
    // actions/batch.js is the on-chain arbiter and holds its copy as an instance
    // field (`this.commandLimit`), not an export, so it is read from source the same
    // way the execute/index.js call caps above are. The SDK exports its own literal from
    // batchLimits.js, and four further SDK sites (validator, batchBuilder,
    // decoder/parse, preflight/checks/batch) follow that one (uuid 500f2f11).
    it('[regression:p0] BATCH_COMMAND_LIMIT === canonical across SDK batchLimits + indexer batch.js (uuid 500f2f11)', () => {
        const sdkBatchLimits = require('../../../../xchain-sdk/src/protocol/batch_limits.js')
        assert.strictEqual(
            sdkBatchLimits.BATCH_COMMAND_LIMIT,
            protocol.BATCH_COMMAND_LIMIT,
            'SDK batchLimits BATCH_COMMAND_LIMIT drifted from the canonical protocol constant; ' +
            'the SDK would refuse a batch the chain accepts, or build one the chain rejects whole'
        )
        const batchPath = path.join(
            __dirname, '../../../../xchain-indexer/src/actions/batch.js')
        const batchSource = readIndexerHandler(batchPath)
        assert.ok(batchSource,
            'xchain-indexer src/actions/batch.js is missing at both spellings (flat file and '
            + 'directory); this tripwire needs the full sibling tree')
        // Read the indexer copy from source: it is an instance field on the action
        // class, and requiring that module drags in the whole indexer action tree.
        const commandLimit = /this\.commandLimit\s*=\s*(\d+)\s*;/.exec(batchSource)
        assert.ok(commandLimit,
            'indexer actions/batch.js no longer assigns this.commandLimit as a literal; re-point this guard')
        assert.strictEqual(Number(commandLimit[1]), protocol.BATCH_COMMAND_LIMIT,
            'indexer actions/batch.js this.commandLimit drifted from the canonical protocol constant; ' +
            'the arbiter and the SDK would disagree on how many commands a BATCH may carry')
    })
})
