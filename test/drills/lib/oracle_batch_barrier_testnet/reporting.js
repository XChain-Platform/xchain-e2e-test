'use strict';

const { PRICE_WATERMARK_GRACE_S } = require('./common');
const { usableObservations } = require('./catch_up');

function finiteValues(values) {
    return values.filter((value) => Number.isFinite(value));
}

function countBy(values, keyFor) {
    return values.reduce((counts, value) => {
        const key = String(keyFor(value));
        counts[key] = (counts[key] || 0) + 1;
        return counts;
    }, {});
}

function summarize(result) {
    const observations = result.observations || [];
    const stalls = finiteValues(observations.map((observation) => observation.stallS));
    const escapes = countBy(observations, (observation) => observation.escape);
    const holes = observations.length > 0
        ? observations[observations.length - 1].holes
        : (result.replay && result.replay.coverage) || null;
    const lags = finiteValues((result.originLagSeries || []).map((sample) => sample.lag));
    const graded = usableObservations(observations);
    const unusable = observations.filter((observation) => !(observation && observation.usable === true));
    const gradedStalls = finiteValues(graded.map((observation) => observation.stallS));
    const ages = finiteValues(observations.map((observation) => observation && observation.ageAtFirstSeenS));
    const barrierStalls = finiteValues(graded.map((observation) => observation.barrierStallS));
    const barrierApplied = graded.filter((observation) => observation.barrierApplies === true);
    const divergences = observations.reduce(
        (all, observation) => all.concat(observation.verdictDisagreements), []);
    const alignmentReasons = observations.reduce((reasons, observation) => {
        for (const [key, count] of Object.entries((observation && observation.alignmentReasons) || {})) {
            reasons[key] = (reasons[key] || 0) + count;
        }
        return reasons;
    }, {});

    return {
        blocksObserved: observations.length,
        maxStallS: stalls.length > 0 ? Math.max(...stalls) : null,
        minStallS: stalls.length > 0 ? Math.min(...stalls) : null,
        escapes,
        stallsWithinGracePlusConfirm: stalls.filter(
            (stall) => stall >= PRICE_WATERMARK_GRACE_S).length,
        barrierMeasured: graded.length > 0,
        blocksGraded: graded.length,
        blocksUnusable: unusable.length,
        unusableReasons: countBy(unusable,
            (observation) => (observation && observation.unusableReason) || 'unknown'),
        maxAgeAtFirstSeenS: ages.length > 0 ? Math.max(...ages) : null,
        gradedEscapes: countBy(graded, (observation) => observation.escape),
        gradedBarrierApplied: barrierApplied.length,
        gradedBarrierNotApplicable: graded.filter(
            (observation) => observation.escape === 'not-applicable').length,
        gradedBarrierApplicabilityUnread: graded.filter((observation) =>
            observation.barrierApplies === null || observation.barrierApplies === undefined).length,
        gradedEscapesAttributed: barrierApplied.filter((observation) =>
            ['content', 'watermark', 'both'].includes(observation.escape)).length,
        gradedEscapesUnattributed: barrierApplied.filter((observation) =>
            !observation.escape || observation.escape === 'unknown').length,
        escapeAttributionMeasured: barrierApplied.length > 0 && barrierApplied.every((observation) =>
            ['content', 'watermark', 'both'].includes(observation.escape)),
        unattributedReasons: countBy(barrierApplied.filter((observation) =>
            !observation.escape || observation.escape === 'unknown'), (observation) =>
            (observation.escapeEvidence && observation.escapeEvidence.beforePermission) || 'unknown'),
        gradedProcessedBeforePermission: graded.filter((observation) =>
            observation.escapeEvidence &&
            observation.escapeEvidence.beforePermission === 'observed-closed-across-processing').length,
        gradedEscapesUncorroborated: graded.filter((observation) =>
            observation.escape && observation.escape !== 'unknown' && observation.escapeEvidence &&
            observation.escapeEvidence.corroborated === false).length,
        barrierSamples: result.barrier ? result.barrier.samples : null,
        barrierSampleFailures: result.barrier ? result.barrier.failures : null,
        gradedBarrierStallsWithinGrace: barrierStalls.filter(
            (stall) => stall >= PRICE_WATERMARK_GRACE_S).length,
        gradedMaxBarrierStallS: barrierStalls.length > 0 ? Math.max(...barrierStalls) : null,
        barrierClockSources: countBy(graded,
            (observation) => observation.barrierBlockTimeSource || 'unknown'),
        maxProtocolTimeLagS: (() => {
            const values = finiteValues(graded.map((observation) => observation.protocolTimeLagS));
            return values.length > 0 ? Math.max(...values) : null;
        })(),
        gradedMaxStallS: gradedStalls.length > 0 ? Math.max(...gradedStalls) : null,
        gradedMinStallS: gradedStalls.length > 0 ? Math.min(...gradedStalls) : null,
        gradedStallsWithinGracePlusConfirm: gradedStalls.filter(
            (stall) => stall >= PRICE_WATERMARK_GRACE_S).length,
        holesTotal: holes ? holes.missingFromHub.count + holes.missingFromMirror.count : null,
        holesInHub: holes ? holes.missingFromHub.count : null,
        holesInMirror: holes ? holes.missingFromMirror.count : null,
        roundsCarriedByParsedBatches: holes ? holes.roundsCarried : null,
        verdictsCompared: observations.reduce((count, observation) =>
            count + observation.actions.filter((action) => action.coordinateAligned).length, 0),
        alignmentReasons,
        actionsSeen: observations.reduce((count, observation) =>
            count + ((observation && observation.actions) || []).length, 0),
        verdictsAgreed: observations.reduce((count, observation) =>
            count + observation.verdictAgreements, 0),
        verdictsDiverged: observations.reduce((count, observation) =>
            count + observation.verdictDisagreements.length, 0),
        divergences: divergences.slice(0, 50),
        caughtUpBy: result.catchUp ? result.catchUp.reason : null,
        catchUpS: result.catchUp ? result.catchUp.durationS : null,
        backlogSkipped: result.observe ? result.observe.backlogSkipped : null,
        originLagSamples: lags.length,
        originMaxLag: lags.length > 0 ? Math.max(...lags) : null,
        originIndexerUnavailable: (result.originLagSeries || []).some((sample) => sample.unavailable)
            ? ((result.originLagSeries || []).find((sample) => sample.unavailable) || {}).unavailable
            : null
    };
}

module.exports = { summarize };
