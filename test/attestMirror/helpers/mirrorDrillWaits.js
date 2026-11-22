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
 **********************************************************************
 */

const arithmeticAndVerdicts = require('./mirror_drill_waits/arithmeticAndVerdicts')
const miningAndStallRecovery = require('./mirror_drill_waits/miningAndStallRecovery')
const mirrorAndApplyWaits = require('./mirror_drill_waits/mirrorAndApplyWaits')
const rewardReads = require('./mirror_drill_waits/rewardReads')
const requestDiscovery = require('./mirror_drill_waits/requestDiscovery')
const federationCapture = require('./mirror_drill_waits/federationCapture')
const blockWindowReads = require('./mirror_drill_waits/blockWindowReads')
const databaseReads = require('./mirror_drill_waits/databaseReads')

module.exports = {
    jsonSafe: arithmeticAndVerdicts.jsonSafe,
    feeLines: rewardReads.feeLines,
    rawAttestRewards: rewardReads.rawAttestRewards,
    APPLIED_FIELDS: arithmeticAndVerdicts.APPLIED_FIELDS,
    STATE_HASH_FIELDS: arithmeticAndVerdicts.STATE_HASH_FIELDS,
    DEFAULT_INTERVAL_MS: arithmeticAndVerdicts.DEFAULT_INTERVAL_MS,
    ROLLCALL_STALL_AFTER_MS: miningAndStallRecovery.ROLLCALL_STALL_AFTER_MS,
    ROLLCALL_STALL_REASON: miningAndStallRecovery.ROLLCALL_STALL_REASON,
    DOGE_NUDGE_BLOCKS: miningAndStallRecovery.DOGE_NUDGE_BLOCKS,
    BTC_BLOCKS_PER_DOGE_KEEPUP: miningAndStallRecovery.BTC_BLOCKS_PER_DOGE_KEEPUP,
    MAX_DOGE_NUDGES: miningAndStallRecovery.MAX_DOGE_NUDGES,
    until: arithmeticAndVerdicts.until,
    widenArithmetic: arithmeticAndVerdicts.widenArithmetic,
    untilOrClearDogeStall: miningAndStallRecovery.untilOrClearDogeStall,
    wedgeVerdict: miningAndStallRecovery.wedgeVerdict,
    mineDogeBlocks: miningAndStallRecovery.mineDogeBlocks,
    mineBtcKeepingDogeAlive: miningAndStallRecovery.mineBtcKeepingDogeAlive,
    keepDogeAlive: miningAndStallRecovery.keepDogeAlive,
    settleOrReport: miningAndStallRecovery.settleOrReport,
    clearBeforeBroadcast: miningAndStallRecovery.clearBeforeBroadcast,
    venueTipProbe: mirrorAndApplyWaits.venueTipProbe,
    allHubTails: mirrorAndApplyWaits.allHubTails,
    responsibleHubTails: mirrorAndApplyWaits.responsibleHubTails,
    standingTipProbe: mirrorAndApplyWaits.standingTipProbe,
    diffRows: arithmeticAndVerdicts.diffRows,
    diffStateHashes: arithmeticAndVerdicts.diffStateHashes,
    rewardFingerprint: arithmeticAndVerdicts.rewardFingerprint,
    firstSatisfyingBlock: arithmeticAndVerdicts.firstSatisfyingBlock,
    happyPathVerdict: arithmeticAndVerdicts.happyPathVerdict,
    waitForMirrorRowEverywhere: mirrorAndApplyWaits.waitForMirrorRowEverywhere,
    waitForAppliedEverywhere: mirrorAndApplyWaits.waitForAppliedEverywhere,
    waitForHeightWithClear: blockWindowReads.waitForHeightWithClear,
    findEmittedAttestRequest: requestDiscovery.findEmittedAttestRequest,
    attestRequestWatermark: requestDiscovery.attestRequestWatermark,
    captureFederationState: federationCapture.captureFederationState,
    queryDb: databaseReads.queryDb,
    readAppliedResponse: databaseReads.readAppliedResponse,
    readContractState: databaseReads.readContractState,
    readAttestRewards: rewardReads.readAttestRewards,
    readResponseRows: databaseReads.readResponseRows,
    readBlockWindow: blockWindowReads.readBlockWindow,
    readRequestRow: blockWindowReads.readRequestRow,
}
