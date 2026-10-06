const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { protocol, readIndexerHandler } = require('./support/environment')

void describe('Family-B constant parity (copies the full-export guard does not reach)', () => {

    // BATCH_WEIGHT_BUDGET is the weighted-sum ceiling that REPLACES the command
    // count cap at/after BATCH_COST_WEIGHTING, so it is consensus-visible the
    // moment that gate arms. Three surfaces hold their own literal: the indexer
    // arbiter (actions/batch.js `this.weightBudget`, an instance field and not an
    // export, read from source like commandLimit above), the SDK mirror
    // (batchLimits.js), and the wallet's batch flow
    // (packages/core/src/flows/batchCommand.js, an ESM package this CommonJS suite
    // cannot require). The canonical file's own comment claims the cross-service
    // suite "holds all three copies" equal, but protocol-constant-claims.test.js
    // covers only the indexer and the SDK. The wallet is a fourth copy, and its own
    // suite pins it to the bare literal 250 (test/unit/flows/batchCommand.test.js)
    // rather than to canonical, so a retuned budget leaves that suite green while
    // the wallet builds batches the chain rejects whole. Same wallet-only-checkout
    // blind spot the THRESHOLD_SCALE guard above records (uuid 044f8438).
    it('[regression:p0] BATCH_WEIGHT_BUDGET === canonical across SDK batchLimits + indexer batch.js + wallet batchCommand (uuid 044f8438)', () => {
        const sdkBatchLimits = require('../../../../xchain-sdk/src/protocol/batch_limits.js')
        assert.strictEqual(
            sdkBatchLimits.BATCH_WEIGHT_BUDGET,
            protocol.BATCH_WEIGHT_BUDGET,
            'SDK batchLimits BATCH_WEIGHT_BUDGET drifted from the canonical protocol constant; ' +
            'the SDK would refuse a batch the chain accepts, or build one the chain rejects whole'
        )

        const batchPath = path.join(
            __dirname, '../../../../xchain-indexer/src/actions/batch.js')
        const batchSource = readIndexerHandler(batchPath)
        assert.ok(batchSource,
            'xchain-indexer src/actions/batch.js is missing at both spellings (flat file and '
            + 'directory); this tripwire needs the full sibling tree')
        const weightBudget = /this\.weightBudget\s*=\s*(\d+)\s*;/.exec(batchSource)
        assert.ok(weightBudget,
            'indexer actions/batch.js no longer assigns this.weightBudget as a literal; re-point this guard')
        assert.strictEqual(Number(weightBudget[1]), protocol.BATCH_WEIGHT_BUDGET,
            'indexer actions/batch.js this.weightBudget drifted from the canonical protocol constant; ' +
            'the arbiter and the SDK would disagree on which weighted batches the chain admits')

        const walletBatchPath = path.join(
            __dirname, '../../../../xchain-wallet/packages/core/src/flows/batchCommand.js')
        assert.ok(fs.existsSync(walletBatchPath),
            'xchain-wallet batchCommand.js is missing; this tripwire needs the full sibling tree')
        const walletBudget = /^export const BATCH_WEIGHT_BUDGET = (\d+);$/m.exec(
            fs.readFileSync(walletBatchPath, 'utf8'))
        assert.ok(walletBudget,
            'wallet batchCommand.js no longer declares BATCH_WEIGHT_BUDGET as a literal export; re-point this guard')
        assert.strictEqual(Number(walletBudget[1]), protocol.BATCH_WEIGHT_BUDGET,
            'wallet batchCommand BATCH_WEIGHT_BUDGET drifted from the canonical protocol constant; ' +
            'the wallet would let a user build a batch the chain rejects whole once cost weighting is armed')
    })
})
