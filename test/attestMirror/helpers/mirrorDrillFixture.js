'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

const stackSettlement = require('./mirror_drill_fixture/stack_settlement')
const wedgeClearing = require('./mirror_drill_fixture/wedge_clearing')
const testServer = require('./mirror_drill_fixture/test_server')
const venueReadiness = require('./mirror_drill_fixture/venue_readiness')
const signerAdoption = require('./mirror_drill_fixture/signer_adoption')
const identityProvisioning = require('./mirror_drill_fixture/identity_provisioning')
const contractDeployment = require('./mirror_drill_fixture/contract_deployment')
const databaseReads = require('./mirror_drill_fixture/database_reads')

async function deployRequestContract (opts) {
    const o = opts || {}
    const label = String(o.label || 'drill').replace(/[^A-Za-z0-9]/g, '')
    return contractDeployment.deployRequestContract(o, label,
        () => wedgeClearing.clearWedgeBefore('contract deploy for ' + label))
}

module.exports = {
    provisionDrillIdentities: identityProvisioning.provisionDrillIdentities,
    waitForVenueIndexersAtTip: venueReadiness.waitForVenueIndexersAtTip,
    waitForVenuePrices: venueReadiness.waitForVenuePrices,
    startAttestTestServer: testServer.startAttestTestServer,
    readSeatedAttestationSet: signerAdoption.readSeatedAttestationSet,
    withWedgeClear: wedgeClearing.withWedgeClear,
    assertResponsibleSetIsVenueOnly: identityProvisioning.assertResponsibleSetIsVenueOnly,
    clearWedgeBefore: wedgeClearing.clearWedgeBefore,
    recordStakerKey: stackSettlement.recordStakerKey,
    DRILL_KEYS_DIR: stackSettlement.DRILL_KEYS_DIR,
    deployRequestContract,
    stakeVisibilityBlocks: stackSettlement.stakeVisibilityBlocks,
    settleStack: stackSettlement.settleStack,
    queryVenueDb: databaseReads.queryVenueDb,
    mineWhile: stackSettlement.mineWhile,
    readAppliedResponse: databaseReads.readAppliedResponse,
    readContractState: databaseReads.readContractState,
    IDLE_GENERATION_SCAN: signerAdoption.IDLE_GENERATION_SCAN,
    ['_knownSignerSeeds']: signerAdoption.internalKnownSignerSeeds,
    ['_pubkeyForSeed']: signerAdoption.internalPubkeyForSeed,
    resolveAdoptionPlan: signerAdoption.resolveAdoptionPlan,
}
