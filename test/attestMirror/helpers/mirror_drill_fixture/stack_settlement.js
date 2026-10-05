'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************/

const assert = require('assert')
const fsx = require('fs')
const pathx = require('path')

const stakeHelper = require('../../../helpers/stakeHelper')
const { loadHubModule } = require('../../../helpers/multiValidatorHubHelper')

const MINE_WHILE_MAX_LAG = 3
const DRILL_KEYS_DIR = pathx.resolve(__dirname, '../../../../drill-keys')

function recordStakerKey (label, entry) {
    try {
        fsx.mkdirSync(DRILL_KEYS_DIR, { recursive: true, mode: 0o700 })
        const file = pathx.join(DRILL_KEYS_DIR, label + '.json')
        let all = []
        try { all = JSON.parse(fsx.readFileSync(file, 'utf8')) } catch (internal) { all = [] }
        all.push(entry)
        fsx.writeFileSync(file, JSON.stringify(all, null, 1), { mode: 0o600 })
        fsx.chmodSync(file, 0o600)
        return file
    } catch (e) {
        console.log('mirrorDrillFixture: WARNING could not record staker keys for ' + label +
            ' (' + (e && e.message) + '). A teardown that cannot finish will strand its stakes.')
        return null
    }
}

async function settleStack () {
    const status = await utxoTrackerConnector.quiesce({
        timeoutMs: 30000, pollMs: 250, regtestMiner: regtestMinerConnector,
    })
    if (status && status.ready === false) {
        console.log('mirrorDrillFixture: WARNING the tracker did NOT settle within 30000ms ' +
            '(quiesce returned ready:false' +
            (status.height !== undefined ? ', height ' + status.height : '') +
            (status.lag !== undefined ? ', lag ' + status.lag : '') +
            '). The next step acts on a mid-batch tracker, so an encoder UTXO lookup ' +
            'failing right after this is ordering rather than flake.')
    }
    return status
}

function stakeVisibilityBlocks (coin, network) {
    const registry = loadHubModule('src/coins/index.js')
    const raw = String(coin || 'BTC').toUpperCase()
    const tick = registry.FULL_NAME_TO_TICK
        ? (registry.FULL_NAME_TO_TICK[raw] || registry.FULL_NAME_TO_TICK[raw.toLowerCase()] || raw)
        : raw
    const net = String(network || 'regtest')
    const shared = Number(stakeHelper.ATTESTATION_STAKE_VISIBLE_BLOCKS)
    const burial = Number(loadHubModule('src/consensus/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)

    let activation = null
    try {
        const staking = registry.getCoinConfig(tick, net).STAKING
        activation = staking && Number(staking.ACTIVATION_DELAY_BLOCKS)
    } catch (e) {
        assert.fail('mirrorDrillFixture: could not read STAKING.ACTIVATION_DELAY_BLOCKS for ' +
            tick + '/' + net + ' from the coins registry (' + (e && e.message) + '). It is calibrated ' +
            'per chain and guessing it is what this function exists to prevent.')
    }

    assert.ok(Number.isFinite(burial) && burial > 0,
        'mirrorDrillFixture: CANONICAL_REORG_BUFFER did not resolve to a positive number (got ' +
        burial + '); the visibility distance cannot be checked against anything')
    assert.ok(Number.isFinite(activation) && activation > 0,
        'mirrorDrillFixture: STAKING.ACTIVATION_DELAY_BLOCKS did not resolve to a positive number (got ' +
        activation + '); it is calibrated per chain and must not be assumed')
    assert.ok(shared >= activation + burial,
        'mirrorDrillFixture: this chain needs ' + activation + ' activation + ' + burial +
        ' burial = ' + (activation + burial) + ' blocks before a stake is selectable, but the shared ' +
        'ATTESTATION_STAKE_VISIBLE_BLOCKS is ' + shared + '. Mining the smaller number does not fail as a ' +
        'missing stake: the responsible set comes back smaller than REDUNDANCY, the request is rejected at ' +
        'admission, and the EXECUTE that emitted it rolls back with no valid execution row, nowhere near ' +
        'the stake. Raise the shared constant rather than working around it here.')
    return shared
}

async function mineWhile (work, everyMs) {
    let settled = false
    const p = Promise.resolve(work()).finally(() => { settled = true })
    const miner = (async () => {
        while (!settled) {
            await new Promise((r) => setTimeout(r, everyMs || 5000))
            if (settled) break
            try {
                const tip = await indexerConnector.call('getblockhashes', {})
                const at = Number(tip && tip.block_index)
                const node = Number(await nodeConnector.getBlockCount())
                if (Number.isFinite(at) && Number.isFinite(node) && node - at > MINE_WHILE_MAX_LAG) continue
                await regtestMinerConnector.generateBlocks(1)
            } catch (e) { /* the wait itself reports the real failure */ }
        }
    })()
    try { return await p }
    finally { await miner }
}

module.exports = {
    DRILL_KEYS_DIR,
    mineWhile,
    recordStakerKey,
    settleStack,
    stakeVisibilityBlocks,
}
