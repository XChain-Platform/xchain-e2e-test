'use strict';

const axios = require('axios');
const { PRICE_WATERMARK_GRACE_S, finite, iso, nowS } = require('./common');

const DEFERRAL_RE = /Deferring block (\d+) \(price time-sync\)/;
const DEFERRAL_STATE_RE = /mirror max round timestamp (-?\d+), stream watermark at (-?\d+)/;
const STATUS_TIMEOUT_MS = 5_000;

function classifyEscape(deferrals, mirrorNewestTs, blockTime, stallS) {
    if (!deferrals || deferrals.length === 0) return { escape: 'none', corroborated: true };
    if (mirrorNewestTs !== null && mirrorNewestTs >= blockTime) {
        return { escape: 'content', corroborated: true };
    }
    return {
        escape: 'watermark',
        corroborated: stallS !== null && stallS >= PRICE_WATERMARK_GRACE_S,
        graceS: PRICE_WATERMARK_GRACE_S
    };
}

function parseDeferral(line) {
    const match = DEFERRAL_RE.exec(line);
    if (!match) return null;
    const state = DEFERRAL_STATE_RE.exec(line);
    return {
        at: nowS(),
        height: Number(match[1]),
        mirrorMaxRoundTs: state ? Number(state[1]) : null,
        streamWatermark: state ? Number(state[2]) : null,
        line: line.slice(0, 400)
    };
}

function barrierSampleFromDeferral(deferral) {
    if (!deferral) return null;
    return {
        at: finite(deferral.at),
        source: 'deferral',
        height: deferral.height === undefined ? null : deferral.height,
        bootstrapped: true,
        streamWatermark: finite(deferral.streamWatermark),
        priceSyncMaxTimestamp: finite(deferral.mirrorMaxRoundTs),
        error: null
    };
}

async function readBarrierState(indexerPort, source) {
    const at = nowS();
    const empty = {
        at,
        source: source || 'status',
        height: null,
        bootstrapped: null,
        streamWatermark: null,
        priceSyncMaxTimestamp: null,
        indexerBlock: null,
        stallReason: null,
        error: null
    };
    try {
        const response = await axios.get('http://127.0.0.1:' + indexerPort + '/status', {
            timeout: STATUS_TIMEOUT_MS,
            validateStatus: () => true
        });
        const body = (response && response.data) || {};
        const mirror = body.hubMirror;
        if (!mirror || mirror.configured !== true) {
            return Object.assign({}, empty, {
                error: 'no configured hubMirror in /status (HTTP ' + (response && response.status) + ')'
            });
        }
        return Object.assign({}, empty, {
            bootstrapped: mirror.bootstrapped === undefined ? null : !!mirror.bootstrapped,
            streamWatermark: finite(mirror.streamWatermark),
            priceSyncMaxTimestamp: finite(mirror.tables ? mirror.tables.price_snapshots : null),
            indexerBlock: finite(body.indexerBlock),
            stallReason: body.stallReason === undefined ? null : body.stallReason
        });
    } catch (error) {
        return Object.assign({}, empty, {
            error: String((error && error.message) || error).slice(0, 200)
        });
    }
}

function barrierClauses(sample, blockTime, graceS) {
    const max = finite(sample && sample.priceSyncMaxTimestamp);
    const watermark = finite(sample && sample.streamWatermark);
    const time = finite(blockTime);
    const grace = finite(graceS);
    return {
        content: max !== null && time !== null && max >= time,
        watermark: watermark !== null && time !== null && grace !== null && watermark >= time + grace
    };
}

function attributeEscape(input) {
    const state = input || {};
    const blockTime = finite(state.blockTime);
    const processedAt = finite(state.processedAt);
    const graceS = finite(state.graceS) === null ? PRICE_WATERMARK_GRACE_S : finite(state.graceS);
    const intervalS = finite(state.sampleIntervalS);
    const stallS = processedAt !== null && blockTime !== null ? processedAt - blockTime : null;
    const samples = (state.samples || [])
        .filter((sample) => sample && finite(sample.at) !== null)
        .slice()
        .sort((left, right) => finite(left.at) - finite(right.at));
    const result = {
        escape: 'unknown',
        corroborated: false,
        graceS,
        permittedAt: null,
        permittedAtIso: null,
        permittedBy: null,
        permittedAtIsUpperBound: null,
        openedBeforeFirstSample: null,
        lastClosedAt: null,
        lastClosedAtIso: null,
        beforePermission: 'unknown',
        samplesConsidered: 0,
        samplesTotal: samples.length,
        sampleIntervalS: intervalS,
        reason: null
    };

    if (blockTime === null || processedAt === null) {
        result.reason = 'the block time or the moment it was seen processed was not read, ' +
            'so the barrier cannot be evaluated for this block';
        return result;
    }
    if (state.barrierApplies === false) {
        result.escape = 'not-applicable';
        result.beforePermission = 'not-applicable';
        result.reason = 'the block carried no transaction, so blockMayReadPrice was false and the ' +
            'indexer never entered the price time barrier for it: there is no escape to name';
        return result;
    }

    const considered = samples.filter((sample) => finite(sample.at) <= processedAt);
    result.samplesConsidered = considered.length;
    if (considered.length === 0) {
        result.reason = samples.length === 0
            ? 'the barrier state was never sampled, so no escape can be attributed'
            : 'no barrier sample was taken at or before this block was seen processed (' +
              samples.length + ' later sample(s) only)';
        return result;
    }

    let lastClosedAt = null;
    for (const sample of considered) {
        const clauses = barrierClauses(sample, blockTime, graceS);
        if (!clauses.content && !clauses.watermark) {
            lastClosedAt = finite(sample.at);
            continue;
        }
        result.escape = clauses.content && clauses.watermark
            ? 'both' : (clauses.content ? 'content' : 'watermark');
        result.permittedAt = finite(sample.at);
        result.permittedAtIso = iso(result.permittedAt);
        result.permittedBy = String(sample.source || 'status');
        result.permittedAtIsUpperBound = true;
        result.openedBeforeFirstSample = lastClosedAt === null;
        result.lastClosedAt = lastClosedAt;
        result.lastClosedAtIso = lastClosedAt === null ? null : iso(lastClosedAt);
        result.beforePermission = 'no';
        result.corroborated = result.escape === 'content'
            ? true : stallS !== null && stallS >= graceS;
        result.reason = result.escape + ' escape observed open at ' + result.permittedAtIso +
            (result.openedBeforeFirstSample
                ? ', in the FIRST sample taken at or before this block was processed: ' +
                  'it may have opened earlier, so this instant is an upper bound only'
                : ', last observed closed at ' + result.lastClosedAtIso);
        return result;
    }

    result.lastClosedAt = lastClosedAt;
    result.lastClosedAtIso = lastClosedAt === null ? null : iso(lastClosedAt);
    const after = samples.find((sample) => finite(sample.at) > processedAt);
    const afterClauses = after ? barrierClauses(after, blockTime, graceS) : null;
    const closedAfter = !!afterClauses && !afterClauses.content && !afterClauses.watermark;
    if (closedAfter) {
        result.beforePermission = 'observed-closed-across-processing';
        result.reason = 'the barrier was observed CLOSED for this block at every sample up to ' +
            result.lastClosedAtIso + ' AND at ' + iso(finite(after.at)) + ', after the node was ' +
            'already seen past this height: the block was processed while neither shipped ' +
            'clause was satisfied for it';
        return result;
    }
    result.reason = 'the barrier was observed closed for this block at every sample up to ' +
        result.lastClosedAtIso + ' and ' +
        (after ? 'the next sample already showed it open, after the block was seen processed'
            : 'no sample was taken after the block was seen processed') +
        ', so which escape opened it was never observed';
    return result;
}

function escapeRecord(attribution, deferrals, deferralLineEscape) {
    deferrals = deferrals || [];
    return {
        corroborated: attribution.corroborated,
        graceS: attribution.graceS === undefined ? null : attribution.graceS,
        reason: attribution.reason,
        permittedAt: attribution.permittedAtIso,
        permittedBy: attribution.permittedBy,
        permittedAtIsUpperBound: attribution.permittedAtIsUpperBound,
        openedBeforeFirstSample: attribution.openedBeforeFirstSample,
        lastClosedAt: attribution.lastClosedAtIso,
        beforePermission: attribution.beforePermission,
        samplesConsidered: attribution.samplesConsidered,
        samplesTotal: attribution.samplesTotal,
        sampleIntervalS: attribution.sampleIntervalS,
        deferralCount: deferrals.length,
        firstDeferral: deferrals.length > 0 ? deferrals[0] : null,
        lastDeferral: deferrals.length > 0 ? deferrals[deferrals.length - 1] : null,
        deferralLineReading: deferralLineEscape === undefined ? null : deferralLineEscape
    };
}

module.exports = {
    classifyEscape,
    parseDeferral,
    barrierSampleFromDeferral,
    readBarrierState,
    barrierClauses,
    attributeEscape,
    escapeRecord
};
