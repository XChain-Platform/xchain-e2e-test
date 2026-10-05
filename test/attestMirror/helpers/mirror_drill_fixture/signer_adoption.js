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
const crypto = require('crypto')

const { loadHubModule } = require('../../../helpers/multiValidatorHubHelper')

const IDLE_GENERATION_SCAN = 32

function internalPubkeyForSeed (seedHex) {
    const ValidatorIdentity = loadHubModule('src/validators/identity.js')
    return String(new ValidatorIdentity(String(seedHex).toLowerCase()).getPubkeyHex()).toLowerCase()
}

function internalKnownSignerSeeds () {
    const rollcall = require('../../../helpers/rollcallHelper')
    const seeds = new Map()

    const add = (seedHex, origin) => {
        if (!seedHex || !/^[0-9a-fA-F]{64}$/.test(String(seedHex))) return
        const hex = String(seedHex).toLowerCase()
        const pk = internalPubkeyForSeed(hex)
        if (!seeds.has(pk)) seeds.set(pk, { seedHex: hex, origin: origin })
    }

    const signing = rollcall.SIGNING_SEEDS || []
    signing.forEach((s, i) => add(s, 'federation signing seed ' + i))
    add(process.env.XC_ROLLCALL_IDLE_SEED, 'XC_ROLLCALL_IDLE_SEED')

    const mnemonic = process.env.XC_ROLLCALL_FEDERATION_MNEMONIC
    if (mnemonic) {
        const configured = process.env.XC_ROLLCALL_IDLE_GENERATION
        const gens = []
        if (configured !== undefined && configured !== null && String(configured) !== '') {
            gens.push(String(configured))
        }
        for (let g = 0; g <= IDLE_GENERATION_SCAN; g++) gens.push(String(g))
        for (const g of gens) {
            add(crypto.createHash('sha256')
                .update('xchain-rollcall-idle|' + g + '|' + mnemonic, 'utf8')
                .digest('hex'), 'idle generation ' + g)
        }
    }

    add(rollcall.LEGACY_IDLE_SEED, 'the legacy fixed idle seed')
    return seeds
}

async function readSeatedAttestationSet (opts) {
    const o = opts || {}
    const indexer = o.indexer || indexerConnector
    const stakeTeardown = require('../../../helpers/stakeTeardown')
    const buffer = Number(loadHubModule('src/consensus/snapshot_reorg_buffer.js').CANONICAL_REORG_BUFFER)

    const tip = await indexer.call('getblockhashes', {})
    assert.ok(tip && tip.block_index !== undefined && tip.block_index !== null,
        'mirrorDrillFixture: the indexer would not report a tip, so the seated set cannot be read')
    const buried = Number(tip.block_index) - buffer
    assert.ok(Number.isFinite(buried) && buried > 0,
        'mirrorDrillFixture: computed a nonsensical buried height (' + buried + ') from tip ' +
        tip.block_index + ' and reorg buffer ' + buffer)

    const set = await stakeTeardown.readCapabilitySet({
        indexer: indexer, capability: 'attestation', blockIndex: buried,
    })
    assert.ok(set && !set.error,
        'mirrorDrillFixture: could not read the seated attestation set at buried block ' + buried +
        (set && set.error ? ' (' + set.error + ')' : '') +
        '. This is an INSTRUMENT failure and NOT evidence that the roster is clean.')
    assert.ok(set.pubkeys.length > 0,
        'mirrorDrillFixture: the attestation capability is EMPTY at buried block ' + buried +
        ', so no responsible set can be drawn at all and every request would be refused at admission.')

    return { set: set, tipBlock: Number(tip.block_index), buriedBlock: buried, reorgBuffer: buffer }
}

function internalWeightOf (seated, pubkeyHex) {
    const v = seated && seated.byPubkey && seated.byPubkey.get(pubkeyHex)
    return (v && v.weight !== undefined && v.weight !== null) ? String(v.weight) : '?'
}

function internalRawWeight (seated, pubkeyHex) {
    const v = seated.byPubkey.get(pubkeyHex)
    return v && v.weight
}

function internalBatchQuorumReach (seated, adopted, belowFloor, buriedBlock, network) {
    const swq = loadHubModule('src/consensus/stake_weighted_quorum.js')
    const { bftQuorumOrSingle } = loadHubModule('src/lib/bft_quorum.js')

    const weighted = !!swq.isStakeWeightedQuorumActive(buriedBlock, network)
    const validators = seated.pubkeys.map((pk) => seated.byPubkey.get(pk))
    const ourKeys = adopted.map((a) => a.pubkeyHex)

    const reaches = (signers) => {
        if (!weighted) return signers.length >= bftQuorumOrSingle(seated.pubkeys.length, 1)
        try {
            return swq.meetsStakeThreshold(validators, signers)
        } catch (e) {
            assert.fail('mirrorDrillFixture: the seated snapshot at buried block ' + buriedBlock +
                ' cannot be measured for stake-weighted quorum (' + (e && e.message) + '). That is an ' +
                'INSTRUMENT or roster fault and NOT evidence the set is usable: every batch window ' +
                'would be refused on the same reading.')
        }
    }

    let totalStake = '?'
    let oursStake = '?'
    if (weighted) {
        try {
            totalStake = String(swq.totalStake(validators))
            oursStake = String(swq.totalStake(ourKeys.map((pk) => seated.byPubkey.get(pk))))
        } catch (internal) {}
    }

    assert.ok(reaches(ourKeys),
        'mirrorDrillFixture: the ' + ourKeys.length + ' hub(s) this venue runs cannot reach the batch ' +
        'co-sign quorum on their own at buried block ' + buriedBlock + ' (' +
        (weighted ? 'stake-weighted: 3 x ' + oursStake + ' must exceed 2 x ' + totalStake
                  : 'count-based: ' + ourKeys.length + ' of ' + bftQuorumOrSingle(seated.pubkeys.length, 1) +
                    ' needed over a set of ' + seated.pubkeys.length) + '). ' +
        (belowFloor.length
            ? 'The ' + belowFloor.length + ' seated key(s) passed over for the draw (' +
              belowFloor.map((p) => p.slice(0, 16) + '@' + internalWeightOf(seated, p)).join(', ') +
              ') still count as set members here and sign nothing, which is what raises the bar. '
            : '') +
        'Seed more adoptable stake before driving a batch: no window would ever publish, and that ' +
        'surfaces as a publisher that looks broken rather than as a short roster.')

    const spare = ourKeys.length > 0 &&
        ourKeys.every((pk) => reaches(ourKeys.filter((x) => x !== pk)))

    return {
        weighted: weighted,
        reaches: true,
        spare: spare,
        totalStake: totalStake,
        oursStake: oursStake,
        setSize: seated.pubkeys.length,
        ourSize: ourKeys.length,
    }
}

function resolveAdoptionPlan (seated, known, opts) {
    const o = opts || {}
    const redundancy = Number(o.redundancy || 3)
    const buriedBlock = o.buriedBlock
    const network = String(o.network || 'regtest')

    assert.ok(seated && Array.isArray(seated.pubkeys) && seated.byPubkey,
        'mirrorDrillFixture: resolveAdoptionPlan needs a readCapabilitySet result')

    const providerDefaults = loadHubModule('src/validators/provider_registry.js').DEFAULTS || {}
    const declared = (o.providers === undefined || o.providers === null)
        ? Object.keys(providerDefaults)
        : [].concat(o.providers).map((p) => String(p))
    assert.ok(declared.length > 0,
        'mirrorDrillFixture: opts.providers, when given, must name at least one provider. Omit it ' +
        'to scope the orphan rule to every provider the registry declares; an empty list would scope ' +
        'it to nothing and adopt a roster no draw could ever use.')
    for (const providerId of declared) {
        assert.ok(providerDefaults[providerId],
            'mirrorDrillFixture: unknown provider ' + providerId + '. The registry declares ' +
            Object.keys(providerDefaults).join(', ') + ', and a typo here would scope the orphan rule ' +
            'to a provider nothing serves rather than failing.')
    }

    const AttestationRound = loadHubModule('src/attestation/round.js')
    const meetsFloor = AttestationRound.prototype.meetsProviderFloor
    assert.strictEqual(typeof meetsFloor, 'function',
        'mirrorDrillFixture: the hub no longer exposes meetsProviderFloor, so the provider-floor ' +
        'precondition cannot be checked against the rule the hub actually applies')

    const eligibleBy = new Map()
    const drawable = new Set()
    for (const providerId of declared) {
        const floor = providerDefaults[providerId].min_stake_xchain
        const eligible = (floor === undefined || floor === null)
            ? seated.pubkeys.slice()
            : seated.pubkeys.filter((pk) => meetsFloor.call(null, internalRawWeight(seated, pk), floor))
        eligibleBy.set(providerId, eligible)
        for (const pk of eligible) drawable.add(pk)
    }

    const adopted = []
    const orphans = []
    const belowFloor = []
    for (const pk of seated.pubkeys) {
        const hit = known.get(pk)
        if (hit) { adopted.push({ pubkeyHex: pk, privkeyHex: hit.seedHex, origin: hit.origin }); continue }
        if (!drawable.has(pk)) { belowFloor.push(pk); continue }
        orphans.push(pk)
    }

    assert.strictEqual(orphans.length, 0,
        'mirrorDrillFixture: ' + orphans.length + ' of the ' + seated.pubkeys.length +
        ' seated attestation validator(s) at buried block ' + buriedBlock +
        ' have NO signing key this harness can run AND clear the floor of a provider this drill ' +
        'declares (' + declared.join(', ') + '): ' +
        orphans.map((p) => p.slice(0, 16) + '@' + internalWeightOf(seated, p)).join(', ') + '.\n' +
        'A responsible set is drawn from ALL of them and finalization needs max(quorum, redundancy) ' +
        'signatures from the DRAWN members, so a draw containing one of these stalls to timeout and ' +
        'reads as a missing mirror row. Refusing rather than running that lottery.\n' +
        'The idle key is the usual cause: set XC_ROLLCALL_FEDERATION_MNEMONIC (with ' +
        'XC_ROLLCALL_IDLE_GENERATION) or XC_ROLLCALL_IDLE_SEED so it can be derived, or have the ' +
        'roll-call lane unstake it. Where the key belongs to a validator this harness must NOT ' +
        'impersonate, declare only providers whose floor it misses instead. Signers this harness ' +
        'holds: ' + [...known.keys()].map((p) => p.slice(0, 16)).join(', '))

    const floorReport = []
    for (const providerId of declared) {
        const floor = providerDefaults[providerId].min_stake_xchain
        const eligible = eligibleBy.get(providerId)
        floorReport.push({ providerId: providerId, floor: String(floor), eligible: eligible.length })
        assert.ok(eligible.length >= redundancy,
            'mirrorDrillFixture: provider ' + providerId + ' declares min_stake_xchain ' + floor +
            ' and only ' + eligible.length + ' of ' + seated.pubkeys.length + ' seated validator(s) ' +
            'clear it at buried block ' + buriedBlock + ', which is below the redundancy of ' +
            redundancy + '. The responsible set comes back SHORT, the round is skipped as ' +
            'unfinalizable, and the request expires at its deadline with no response and no error ' +
            'anywhere near the floor that caused it.')
    }

    const quorum = internalBatchQuorumReach(seated, adopted, belowFloor, buriedBlock, network)
    return {
        declared: declared,
        adopted: adopted,
        orphans: orphans,
        belowFloor: belowFloor,
        floorReport: floorReport,
        quorum: quorum,
    }
}

module.exports = {
    IDLE_GENERATION_SCAN,
    internalKnownSignerSeeds,
    internalPubkeyForSeed,
    internalWeightOf,
    readSeatedAttestationSet,
    resolveAdoptionPlan,
}
