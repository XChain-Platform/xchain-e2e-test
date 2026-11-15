// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { finite } = require('./common');

function evaluateCatchUp(s) {
    s = s || {};
    const nodeHeight = finite(s.nodeHeight);
    const decoderTip = finite(s.decoderTip);
    const nodeBlockTime = finite(s.nodeBlockTime);
    const nowSec = finite(s.nowSec);
    const slackBlocks = finite(s.slackBlocks);
    const graceS = finite(s.graceS);
    const toleranceS = finite(s.toleranceS);
    const blocksBehind = nodeHeight !== null && decoderTip !== null ? decoderTip - nodeHeight : null;
    const frontierAgeS = nodeBlockTime !== null && nowSec !== null ? nowSec - nodeBlockTime : null;
    const workingPointS = graceS !== null && toleranceS !== null ? graceS + toleranceS : null;
    const base = { blocksBehind, frontierAgeS, workingPointS };
    if (blocksBehind === null) return Object.assign({ caughtUp: false, reason: 'unknown' }, base);
    if (slackBlocks !== null && blocksBehind <= slackBlocks) {
        return Object.assign({ caughtUp: true, reason: 'at-tip' }, base);
    }
    if (frontierAgeS !== null && workingPointS !== null && frontierAgeS <= workingPointS) {
        return Object.assign({ caughtUp: true, reason: 'barrier-working-point' }, base);
    }
    return Object.assign({ caughtUp: false, reason: 'replaying-backlog' }, base);
}

function classifyBlockFreshness(s) {
    s = s || {};
    const blockTime = finite(s.blockTime);
    const firstSeenAt = finite(s.firstSeenAt);
    const maxAgeS = finite(s.maxAgeS);
    if (blockTime === null || firstSeenAt === null || maxAgeS === null) {
        return { ageAtFirstSeenS: null, usable: false, reason: 'unknown-arrival', maxAgeS };
    }
    const age = firstSeenAt - blockTime;
    if (age > maxAgeS) {
        return { ageAtFirstSeenS: age, usable: false, reason: 'stale-backlog', maxAgeS };
    }
    if (age < -maxAgeS) {
        return { ageAtFirstSeenS: age, usable: false, reason: 'block-time-ahead-of-clock', maxAgeS };
    }
    return { ageAtFirstSeenS: age, usable: true, reason: 'live', maxAgeS };
}

function usableObservations(observations) {
    return (observations || []).filter((observation) => observation && observation.usable === true);
}

function comparedVerdicts(observations) {
    return usableObservations(observations)
        .reduce((count, observation) =>
            count + observation.actions.filter((action) => action.coordinateAligned).length, 0);
}

module.exports = { evaluateCatchUp, classifyBlockFreshness, usableObservations, comparedVerdicts };
