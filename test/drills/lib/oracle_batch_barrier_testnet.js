'use strict';

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
 * AT5 barrier drill for the public testnet chain.
 *
 * Run with:
 *
 *   node test/drills/lib/oracle_batch_barrier_testnet.js
 *
 * Exit 0 means the observation completed, 2 means replay or catch-up timed
 * out, 3 means no live block could be graded, 4 means too few origin verdicts
 * were available, and 1 means another failure occurred.
 ********************************************************************/

const { composeLiveChainFromEnv, readSettings } = require('./oracle_batch_barrier_testnet/settings');
const {
    classifyEscape,
    parseDeferral,
    barrierSampleFromDeferral,
    readBarrierState,
    barrierClauses,
    attributeEscape,
    escapeRecord
} = require('./oracle_batch_barrier_testnet/barrier_attribution');
const {
    mirrorMaxFinalizedTimestamp,
    decoderBlockTransactionCount,
    loadProtocolTime,
    previousBlockTimes,
    resolveBarrierBlockTime
} = require('./oracle_batch_barrier_testnet/database_observations');
const {
    evaluateCatchUp,
    classifyBlockFreshness,
    usableObservations,
    comparedVerdicts
} = require('./oracle_batch_barrier_testnet/catch_up');
const {
    OriginView,
    buildOriginActionIndex,
    alignOnTxHash
} = require('./oracle_batch_barrier_testnet/origin_alignment');
const { observeBlock } = require('./oracle_batch_barrier_testnet/observation');
const { summarize } = require('./oracle_batch_barrier_testnet/reporting');
const { main } = require('./oracle_batch_barrier_testnet/runner');

module.exports = {
    composeLiveChainFromEnv,
    readSettings,
    classifyEscape,
    parseDeferral,
    summarize,
    main,
    evaluateCatchUp,
    classifyBlockFreshness,
    usableObservations,
    observeBlock,
    attributeEscape,
    barrierClauses,
    barrierSampleFromDeferral,
    readBarrierState,
    mirrorMaxFinalizedTimestamp,
    escapeRecord,
    decoderBlockTransactionCount,
    loadProtocolTime,
    previousBlockTimes,
    resolveBarrierBlockTime,
    comparedVerdicts,
    buildOriginActionIndex,
    alignOnTxHash,
    OriginView
};

if (require.main === module) {
    main(process.env)
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error('at5: ' + String((error && error.stack) || error));
            process.exit(1);
        });
}
