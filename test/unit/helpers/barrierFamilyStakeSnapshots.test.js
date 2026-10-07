'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

const assert = require('assert')

const rows = require('../../attestMirror/helpers/barrierFamilyRows')

const SPEC = { network: 'regtest', coin: 'BTC', effectiveTime: 1788494058, snapshotBlock: 104, tag: 'stake' }
const JOIN_TABLES = ['cross_chain_matches', 'cross_chain_calls']
const MEMBER_TABLES = JOIN_TABLES.concat(['bridge_transfers', 'policy_snapshots', 'attestation_responses'])

function joinedSeeds (block) {
    return JOIN_TABLES.map((table) => rows.inertRow(table,
        Object.assign({}, SPEC, { snapshotBlock: block, tag: 'stake|' + table })))
}

describe('barrierFamilyRows: stake-derived capability snapshots', () => {
    it('uses the synthetic row for an unreached snapshot block', async () => {
        let calls = 0
        const got = await rows.requiredSnapshotSeeds(joinedSeeds(105), 104, async () => { calls++; return [] })
        assert.strictEqual(calls, 0)
        assert.deepStrictEqual(got, rows.requiredCapabilitySnapshots(joinedSeeds(105)))
    })

    it('uses exactly the indexer stake weights for a reached snapshot block', async () => {
        const weights = [
            { pubkey: 'aa', source: 'stake-a', weight: '0007' },
            { pubkey: 'bb', source: 'stake-b', weight: 13 },
        ]
        const got = await rows.requiredSnapshotSeeds(joinedSeeds(104), 104, async (block) => {
            assert.strictEqual(block, 104)
            return weights
        })
        assert.deepStrictEqual(got.map((seed) => seed.row), [
            { snapshot_block: 104, capability: 'cross_chain', signing_pubkey: 'aa', amount: '0007', source: 'stake-a' },
            { snapshot_block: 104, capability: 'cross_chain', signing_pubkey: 'bb', amount: '13', source: 'stake-b' },
        ])
        for (const seed of got) assert.deepStrictEqual(seed.key, rows.NATURAL_KEYS.capability_snapshots)
    })

    it('refuses an empty reached weight set with the block and capability named', async () => {
        for (const answer of [[], null, {}]) {
            await assert.rejects(
                rows.requiredSnapshotSeeds(joinedSeeds(104), 104, async () => answer),
                (error) => /cross_chain/.test(error.message) && /104/.test(error.message))
        }
    })

    it('covers a BF2-shaped seed set whose legacy block has been reached', async () => {
        const seeds = rows.admissionSeedRows(MEMBER_TABLES, SPEC, 104, 'tip-103', 99)
        const snapshots = await rows.requiredSnapshotSeeds(seeds, 103, async (block) => [
            { pubkey: 'stake-key-' + block, source: 'stake-source-' + block, weight: '21' },
        ])
        assert.deepStrictEqual(rows.snapshotCapabilityCoverage(seeds.concat(snapshots)), {
            satisfied: true, missingBlocks: [], refusal: null,
        })
    })

    it('judges reached-ness on the buried snapshot block and reads weights there', async () => {
        const buriedOf = (block) => block - 6
        const asked = []
        const weightsAt = async (block) => { asked.push(block); return [{ pubkey: 'aa', source: 's', weight: 5 }] }
        const reached = await rows.requiredSnapshotSeeds(joinedSeeds(110), 104, weightsAt, buriedOf)
        assert.deepStrictEqual(asked, [104])
        assert.deepStrictEqual(reached.map((seed) => seed.row.snapshot_block), [110])
        assert.strictEqual(reached[0].row.signing_pubkey, 'aa')

        asked.length = 0
        const unreached = await rows.requiredSnapshotSeeds(joinedSeeds(111), 104, weightsAt, buriedOf)
        assert.deepStrictEqual(asked, [])
        assert.deepStrictEqual(unreached, rows.requiredCapabilitySnapshots(joinedSeeds(111)))
    })

    it('names the buried height when a reached buried block has no weights', async () => {
        await assert.rejects(
            rows.requiredSnapshotSeeds(joinedSeeds(110), 104, async () => [], (block) => block - 6),
            (error) => /110/.test(error.message) && /buried height 104/.test(error.message))
    })
})
