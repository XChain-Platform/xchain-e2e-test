'use strict';

const { PRICE_WATERMARK_GRACE_S, finite, iso } = require('./common');
const { classifyBlockFreshness } = require('./catch_up');
const {
    mirrorNewestRound,
    mirrorMaxFinalizedTimestamp,
    batchCoverage,
    blockActions
} = require('./database_observations');
const { buildOriginActionIndex, alignOnTxHash } = require('./origin_alignment');
const {
    classifyEscape,
    barrierSampleFromDeferral,
    attributeEscape,
    escapeRecord
} = require('./barrier_attribution');

async function readOriginWindow(origin, limit) {
    if (!origin || typeof origin.recentActions !== 'function') {
        return { rows: [], error: 'origin view exposes no recentActions()', limit: null };
    }
    return origin.recentActions(limit);
}

async function observeBlock(ctx) {
    const {
        node,
        conn,
        origin,
        tables,
        height,
        blockTime,
        firstSeenAt,
        processedAt,
        deferrals,
        originNow
    } = ctx;
    const freshness = classifyBlockFreshness({
        blockTime,
        firstSeenAt,
        maxAgeS: ctx.maxBlockAgeS
    });
    const mirrorNewest = await mirrorNewestRound(conn, node.mirrorDbName, blockTime);
    const hubNewest = await mirrorNewestRound(conn, node.hubDbName, blockTime);
    const originNewest = await origin.newestRoundAtOrBefore(blockTime);
    const stallS = processedAt - blockTime;
    const barrierBlockTime = ctx.barrierBlockTime === undefined || ctx.barrierBlockTime === null
        ? blockTime : finite(ctx.barrierBlockTime);
    const barrierBlockTimeSource = ctx.barrierBlockTimeSource || 'raw-assumed';
    const samples = (ctx.barrierSamples || [])
        .concat((deferrals || []).map(barrierSampleFromDeferral).filter((sample) => sample !== null));
    const txCount = ctx.blockTransactionCount === undefined ? null : finite(ctx.blockTransactionCount);
    const escape = attributeEscape({
        blockTime: barrierBlockTime,
        processedAt,
        samples,
        graceS: PRICE_WATERMARK_GRACE_S,
        barrierApplies: txCount === null ? undefined : txCount > 0,
        sampleIntervalS: ctx.sampleIntervalS === undefined ? null : ctx.sampleIntervalS
    });
    const deferralLineReading = classifyEscape(
        deferrals, mirrorNewest.blockTimestamp, blockTime, stallS);
    const mirrorMaxFinalizedTs = await mirrorMaxFinalizedTimestamp(conn, node.mirrorDbName);
    const actions = await blockActions(conn, node.indexerDbName, tables, height);
    const originList = actions.length > 0
        ? await readOriginWindow(origin, ctx.originActionPage)
        : { rows: [], error: null, limit: null };
    const originIndex = buildOriginActionIndex(originList.rows);
    const rows = [];
    let agreements = 0;
    const disagreements = [];

    for (const action of actions) {
        const statuses = [...new Set(action.verdicts.map((verdict) => verdict.status))];
        const nodeStatus = statuses.length === 1 ? statuses[0]
            : (statuses.length === 0 ? null
                : action.verdicts.map((verdict) => verdict.table + '=' + verdict.status).join(' | '));
        const match = alignOnTxHash(action, originIndex, height);
        const originAction = match.aligned ? await origin.action(match.origin.actionIndex)
            : { found: false, status: null, blockIndex: null, txIndex: null };
        const aligned = match.aligned && originAction.found;
        const agree = aligned && nodeStatus !== null && originAction.status !== null &&
            nodeStatus === originAction.status;
        if (agree) {
            agreements++;
        } else if (aligned) {
            disagreements.push({
                actionIndex: action.actionIndex,
                action: action.action,
                txHash: action.txHash,
                originActionIndex: match.origin.actionIndex,
                nodeStatus,
                originStatus: originAction.status,
                nodePricedAgainstRound: mirrorNewest.round,
                originPricedAgainstRound: originNewest.round
            });
        }
        rows.push({
            actionIndex: action.actionIndex,
            action: action.action,
            txIndex: action.txIndex,
            txVout: action.txVout,
            txHash: action.txHash,
            originActionIndex: match.aligned ? match.origin.actionIndex : null,
            originTxIndex: match.aligned ? match.origin.txIndex : null,
            alignment: match.reason,
            nodeStatus,
            originStatus: originAction.status,
            originFound: !!originAction.found,
            coordinateAligned: !!aligned,
            agree
        });
    }

    return {
        height,
        blockTime,
        blockTimeIso: iso(blockTime),
        firstSeenAt: iso(firstSeenAt),
        processedAt: iso(processedAt),
        processedAtS: processedAt,
        barrierBlockTime,
        barrierBlockTimeIso: barrierBlockTime === null ? null : iso(barrierBlockTime),
        barrierBlockTimeSource,
        protocolTimeLagS: barrierBlockTime === null || blockTime === null
            ? null : blockTime - barrierBlockTime,
        barrierStallS: barrierBlockTime === null ? null : processedAt - barrierBlockTime,
        blockTransactionCount: txCount,
        barrierApplies: txCount === null ? null : txCount > 0,
        stallS,
        waitS: processedAt - firstSeenAt,
        ageAtFirstSeenS: freshness.ageAtFirstSeenS,
        usable: freshness.usable,
        unusableReason: freshness.usable ? null : freshness.reason,
        maxBlockAgeS: freshness.maxAgeS,
        escape: escape.escape,
        escapeEvidence: escapeRecord(escape, deferrals, deferralLineReading.escape),
        mirrorNewestRound: mirrorNewest.round,
        mirrorNewestRoundTs: mirrorNewest.blockTimestamp,
        mirrorMaxFinalizedTs,
        hubNewestRound: hubNewest.round,
        originNewestRound: originNewest.round,
        originNewestRoundTs: originNewest.blockTimestamp,
        roundGapVsOrigin: originNewest.round !== null && mirrorNewest.round !== null
            ? originNewest.round - mirrorNewest.round : null,
        originLagAtProcess: originNow && originNow.lag !== undefined ? originNow.lag : null,
        originTipAtProcess: originNow && originNow.blockIndex !== undefined ? originNow.blockIndex : null,
        holes: await batchCoverage(conn, node.indexerDbName, node.hubDbName, node.mirrorDbName),
        actions: rows,
        originActions: {
            rowsRead: originIndex.rowCount,
            limit: originList.limit,
            error: originList.error,
            oldestBlock: originIndex.oldestBlock,
            newestBlock: originIndex.newestBlock,
            coversThisBlock: originIndex.oldestBlock !== null &&
                height >= originIndex.oldestBlock && height <= originIndex.newestBlock
        },
        alignmentReasons: rows.reduce((reasons, row) => {
            const key = String(row.alignment || 'unknown');
            reasons[key] = (reasons[key] || 0) + 1;
            return reasons;
        }, {}),
        verdictAgreements: agreements,
        verdictDisagreements: disagreements
    };
}

module.exports = { observeBlock };
