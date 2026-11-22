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
 ********************************************************************/

'use strict'

const sibling = require('./rollcall_helper/sibling_resolution')
const federation = require('./rollcall_helper/federation')
const wire = require('./rollcall_helper/canonical_wire')
const federationPreconditions = require('./rollcall_helper/federation_preconditions')
const proofPreconditions = require('./rollcall_helper/proof_preconditions')
const venue = require('./rollcall_helper/venue_lifecycle')
const driving = require('./rollcall_helper/chain_driving')
const database = require('./rollcall_helper/database_reads')
const rewards = require('./rollcall_helper/reward_checks')

const api = Object.assign({}, sibling, federation, wire, federationPreconditions,
    proofPreconditions, venue, driving, database, rewards)

module.exports = {
    protocolRewardAddress: api.protocolRewardAddress,
    addressTickBalance: api.addressTickBalance,
    SIGNING_SEEDS: api.SIGNING_SEEDS,
    federationSeeds: api.federationSeeds,
    IDLE_SEED_INDEX: api.IDLE_SEED_INDEX,
    LEGACY_IDLE_SEED: api.LEGACY_IDLE_SEED,
    reentrySeed: api.reentrySeed,
    sleep: api.sleep,
    mineBtcTo: api.mineBtcTo,
    mineDoge: api.mineDoge,
    mineWhile: api.mineWhile,
    publishWire: api.publishWire,
    driveEpoch: api.driveEpoch,
    rollcallRow: api.rollcallRow,
    absenceRows: api.absenceRows,
    rollcallGatesRows: api.rollcallGatesRows,
    evictionUnstakes: api.evictionUnstakes,
    stakeDeactivations: api.stakeDeactivations,
    delegationDeactivations: api.delegationDeactivations,
    rollcallRewards: api.rollcallRewards,
    unclaimedRewardTotal: api.unclaimedRewardTotal,
    dogeSigners: api.dogeSigners,
    bringUpVenue: api.bringUpVenue,
    tearDownVenue: api.tearDownVenue,
    assertOutageStillRolls: api.assertOutageStillRolls,
    assertOutageFallsBelowThreshold: api.assertOutageFallsBelowThreshold,
    federationRoster: api.federationRoster,
    pubkeyForSeed: api.pubkeyForSeed,
    signCanonical: api.signCanonical,
    canonical: api.canonical,
    buildWire: api.buildWire,
    ROLLCALL_WIRE_V0: api.ROLLCALL_WIRE_V0,
    ROLLCALL_WIRE_V1: api.ROLLCALL_WIRE_V1,
    gatesHash: api.gatesHash,
    knownGates: api.knownGates,
    activeGates: api.activeGates,
    gatesArmed: api.gatesArmed,
    gatesForEpoch: api.gatesForEpoch,
    assertFrozenCanonicalVector: api.assertFrozenCanonicalVector,
    assertFrozenGatesVector: api.assertFrozenGatesVector,
    ROLLCALL_GATES_ARMING_ENV: api.ROLLCALL_GATES_ARMING_ENV,
    rca: api.rca,
    eqh: api.eqh,
    rga: api.rga,
    crd: api.crd,
    indexerModule: api.indexerModule,
    frozenVector: api.frozenVector,
    closeHeightOf: api.closeHeightOf,
    epochsAfter: api.epochsAfter,
    requireRollcallVenue: api.requireRollcallVenue,
    ROLLCALL_REGTEST_ARMING_ENV: api.ROLLCALL_REGTEST_ARMING_ENV,
    assertBtcRail: api.assertBtcRail,
    assertRegtestConstants: api.assertRegtestConstants,
    assertGatedReadsReachable: api.assertGatedReadsReachable,
    assertOraclePublishFederation: api.assertOraclePublishFederation,
    assertDogePeerManifest: api.assertDogePeerManifest,
    assertBtcProofWiring: api.assertBtcProofWiring,
    probePublicRollcallReads: api.probePublicRollcallReads,
    assertPublicRollcallRead: api.assertPublicRollcallRead,
    assertRosterStreaksClean: api.assertRosterStreaksClean,
    assertEpochsUnshadowed: api.assertEpochsUnshadowed,
    parseWire: api.parseWire,
    openDogeRail: api.openDogeRail,
    rollcallRounds: api.rollcallRounds,
    electedLeaderIndex: api.electedLeaderIndex,
    waitForOnChainSigners: api.waitForOnChainSigners,
    climbPublishLadder: api.climbPublishLadder,
    onChainSigners: api.onChainSigners,
    electionTolerance: api.electionTolerance,
    setRollcallBroadcastHook: api.setRollcallBroadcastHook,
    tickAll: api.tickAll,
    waitForGossip: api.waitForGossip,
}
