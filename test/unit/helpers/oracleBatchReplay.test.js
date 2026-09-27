'use strict'

// Copyright © 2025–2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const sinon = require('sinon')
const XChainIndexerConnector = require('../../../src/XChainIndexerConnector')
const { OracleBatchReplayNode } = require('../../helpers/oracleBatchReplay')
const { CANONICAL_REORG_BUFFER } = require('../../helpers/oracleBatchVenue')

function replayNode() {
    const node = new OracleBatchReplayNode({ label: 'unit' })
    node._live = {
        btcOracle: { host: null, port: null, apiKey: null, url: null }
    }
    node._btcOracleProof = { coin: 'BTC', height: 120 }
    node._priceMinStake = '10'
    return node
}

describe('oracleBatchReplay Bitcoin oracle diagnostics', function () {
    let sandbox

    beforeEach(function () { sandbox = sinon.createSandbox() })
    afterEach(function () { sandbox.restore() })

    it('records both resolver shapes and warns when only the weight set is empty', async function () {
        const anchor = 100
        const buried = anchor - CANONICAL_REORG_BUFFER
        const call = sandbox.stub(XChainIndexerConnector.prototype, 'call').callsFake(async (method, params) => {
            if (method === 'getcapabilityvalidators') return { count: 4 }
            if (params.block_index === anchor) return { validators: [{}, {}, {}, {}] }
            return { validators: [] }
        })
        const log = sandbox.stub(console, 'log')
        const warn = sandbox.stub(console, 'warn')
        const node = replayNode()

        await node._probeBtcOracle([{ snapshotBlock: anchor }])

        assert.deepStrictEqual(node.btcOracleEvidence(), {
            coin: 'BTC',
            height: 120,
            anchorHeight: anchor,
            queriedHeight: buried,
            priceSetAtAnchor: 4,
            priceSetAtBuried: 4,
            priceWeightSetAtAnchor: 4,
            priceWeightSetAtBuried: 0
        })
        assert.deepStrictEqual(call.getCalls().map((entry) => entry.args[0]), [
            'getcapabilityvalidators',
            'getcapabilityvalidators',
            'getstakeweightsbycapability',
            'getstakeweightsbycapability'
        ])
        assert.strictEqual(call.lastCall.args[1].block_index, buried)
        assert.strictEqual(call.lastCall.args[1].min_stake, '10')
        assert.match(log.firstCall.args[0], /source-keyed weight read/)
        assert.match(log.firstCall.args[0], /answers 0 validator\(s\)/)
        assert.strictEqual(warn.callCount, 1)
        assert.match(warn.firstCall.args[0], /two resolvers disagree/)
        assert.match(warn.firstCall.args[0], /source-keyed weight read the hub gates on/)
        assert.match(warn.firstCall.args[0], /0 verified signers/)
    })

    it('accepts count-shaped weight replies without warning when resolvers agree', async function () {
        sandbox.stub(XChainIndexerConnector.prototype, 'call').callsFake(async (method) => {
            if (method === 'getcapabilityvalidators') return { count: 3 }
            return { count: 3 }
        })
        sandbox.stub(console, 'log')
        const warn = sandbox.stub(console, 'warn')
        const node = replayNode()

        await node._probeBtcOracle([{ snapshotBlock: 100 }])

        assert.strictEqual(node.btcOracleEvidence().priceWeightSetAtAnchor, 3)
        assert.strictEqual(node.btcOracleEvidence().priceWeightSetAtBuried, 3)
        assert.strictEqual(warn.callCount, 0)
    })
})
