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

const { loadHubModule } = require('../../../helpers/multiValidatorHubHelper')
const {
    internalKnownSignerSeeds,
    internalWeightOf,
    readSeatedAttestationSet,
    resolveAdoptionPlan,
} = require('./signer_adoption')

async function provisionDrillIdentities (opts) {
    const o = opts || {}
    const label = String(o.label || 'drill').replace(/[^A-Za-z0-9]/g, '')
    const count = Number(o.count || 5)
    const redundancy = Number(o.redundancy || 3)
    assert.ok(label, 'mirrorDrillFixture: a label is required; it names the drill in refusals')
    assert.ok(Number.isInteger(count) && count > 0, 'mirrorDrillFixture: count must be a positive integer')

    const reading = await readSeatedAttestationSet({ indexer: o.indexer })
    const seated = reading.set
    const known = internalKnownSignerSeeds()
    const plan = resolveAdoptionPlan(seated, known, {
        providers: o.providers,
        redundancy: redundancy,
        buriedBlock: reading.buriedBlock,
        network: o.network || (typeof NETWORK === 'undefined' ? 'regtest' : NETWORK),
    })
    const adopted = plan.adopted
    const floorReport = plan.floorReport

    assert.ok(count >= adopted.length,
        'mirrorDrillFixture: ' + adopted.length + ' seated key(s) need a hub but the venue is sized ' +
        'for ' + count + '. Raise the hub count: a seated key without a hub is the refusal above.')

    const ValidatorIdentity = loadHubModule('src/validators/identity.js')
    const identities = adopted.map((a) => ({ pubkeyHex: a.pubkeyHex, privkeyHex: a.privkeyHex }))
    const observers = []
    for (let i = adopted.length; i < count; i++) {
        const gen = ValidatorIdentity.generate()
        identities.push({ pubkeyHex: gen.pubkeyHex, privkeyHex: gen.privkeyHex })
        observers.push(gen.pubkeyHex)
    }

    console.log('mirrorDrillFixture: adopted the roster for ' + label + ' at buried block ' +
        reading.buriedBlock + ' (tip ' + reading.tipBlock + ', reorg buffer ' + reading.reorgBuffer + '): ' +
        adopted.length + ' seated key(s) each given a live hub [' +
        adopted.map((a) => a.pubkeyHex.slice(0, 16) + ' via ' + a.origin).join('; ') + '], plus ' +
        observers.length + ' unstaked observer hub(s). Declared provider(s): ' + plan.declared.join(', ') +
        '. Eligible per provider: ' +
        floorReport.map((f) => f.providerId + ' ' + f.eligible + '/' + seated.pubkeys.length).join(', ') +
        '. Passed over as below the floor of every declared provider (NOT adopted, NOT refused): ' +
        (plan.belowFloor.length
            ? plan.belowFloor.map((p) => p.slice(0, 16) + '@' + internalWeightOf(seated, p)).join(', ')
            : 'none') +
        '. Batch co-sign quorum ' + (plan.quorum.weighted ? 'stake-weighted' : 'count-based') +
        ': this venue signs ' + plan.quorum.oursStake + ' of ' + plan.quorum.totalStake +
        ' seated stake' + (plan.quorum.spare ? ' with a spare' : ' WITH NO SPARE') +
        '. NOTHING WAS STAKED.')

    return {
        identities: identities,
        adopted: adopted,
        observers: observers,
        seated: seated,
        buriedBlock: reading.buriedBlock,
        tipBlock: reading.tipBlock,
        floors: floorReport,
        providers: plan.declared,
        belowFloor: plan.belowFloor,
        quorum: plan.quorum,
    }
}

function assertResponsibleSetIsVenueOnly (venue, federation) {
    assert.ok(venue && Array.isArray(venue.hubs) && venue.hubs.length,
        'mirrorDrillFixture: no venue hubs to compare a responsible set against')
    assert.ok(federation && Array.isArray(federation.hubs),
        'mirrorDrillFixture: assertResponsibleSetIsVenueOnly needs a captureFederationState result')

    const ours = new Set(venue.hubs.map((h) => String(h.pubkey).slice(0, 16)))
    const readable = federation.hubs.filter((h) => Array.isArray(h.responsible))
    assert.ok(readable.length > 0,
        'mirrorDrillFixture: no hub returned a readable responsible set, so the draw cannot be ' +
        'judged. This is an INSTRUMENT failure and NOT evidence that the set was clean.')

    const foreign = []
    for (const h of readable) {
        for (const member of h.responsible) {
            if (!ours.has(String(member))) foreign.push(String(member))
        }
    }

    assert.strictEqual(foreign.length, 0,
        'the responsible set contains ' + [...new Set(foreign)].join(', ') + ', which this venue ' +
        'does not run, so the round cannot reach quorum and nothing downstream of it is being ' +
        'tested. Since the venue ADOPTS the roster rather than staking into it, this means a key ' +
        'was seated that `provisionDrillIdentities` did not give a hub: either the roster changed ' +
        'mid-run (it activates on a delay, so a stake made before the drill can seat during it), ' +
        'or the venue was sized for fewer hubs than there are seated keys. Re-read the seated set ' +
        'at the buried height and compare. Venue hubs: ' + [...ours].join(', '))
}

module.exports = { assertResponsibleSetIsVenueOnly, provisionDrillIdentities }
