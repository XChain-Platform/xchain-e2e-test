'use strict';

const {
    PRICE_WATERMARK_GRACE_S,
    POLL_MS,
    NETWORK,
    sleep,
    nowS,
    iso
} = require('./common');
const {
    decoderBlock,
    decoderBlockTransactionCount,
    resolveBarrierBlockTime
} = require('./database_observations');
const { usableObservations, comparedVerdicts } = require('./catch_up');
const {
    barrierSampleFromDeferral,
    readBarrierState,
    attributeEscape,
    escapeRecord
} = require('./barrier_attribution');
const { observeBlock } = require('./observation');

async function observeLiveBlocks(ctx) {
    const {
        node,
        conn,
        decoderConn,
        decoderDb,
        origin,
        tables,
        settings,
        result,
        deadline,
        startTip,
        deferralsByHeight,
        barrierSamples,
        noteBarrierSample,
        write
    } = ctx;
    const pending = new Map();
    const observeStartTip = (await node.decoderHeight()).height;
    let lastDecoderSeen = observeStartTip === null ? startTip : observeStartTip;
    result.observe = {
        startedAt: iso(nowS()),
        startTip: lastDecoderSeen,
        replayTargetTip: startTip,
        backlogSkipped: lastDecoderSeen - startTip,
        maxBlockAgeS: settings.maxBlockAgeS,
        wantedBlocks: settings.observeBlocks,
        gradedBlocks: 0,
        unusableBlocks: 0
    };
    write();
    console.log('at5: observing from tip ' + lastDecoderSeen + ' (skipping ' +
        result.observe.backlogSkipped + ' block(s) mined during the replay and catch-up); ' +
        'grading only blocks first seen within ' + settings.maxBlockAgeS + 's of their block time');

    const satisfied = () =>
        usableObservations(result.observations).length >= settings.observeBlocks &&
        comparedVerdicts(result.observations) >= settings.minVerdicts;

    noteBarrierSample(await readBarrierState(node.indexerPort));
    write();
    while (!satisfied() && Date.now() < deadline) {
        noteBarrierSample(await readBarrierState(node.indexerPort));
        const tip = (await node.decoderHeight()).height;
        for (let height = lastDecoderSeen + 1; height <= tip; height++) {
            const block = await decoderBlock(decoderConn, decoderDb, height);
            if (!block) continue;
            const barrierTime = await resolveBarrierBlockTime(
                decoderConn, decoderDb, height, block.blockTime, NETWORK, node.repoRoot);
            const transactionCount = await decoderBlockTransactionCount(
                decoderConn, decoderDb, height);
            pending.set(height, {
                blockTime: block.blockTime,
                firstSeenAt: nowS(),
                barrierBlockTime: barrierTime.blockTime,
                barrierBlockTimeSource: barrierTime.source,
                blockTransactionCount: transactionCount
            });
            console.log('at5: chain block ' + height + ' arrived (block time ' + iso(block.blockTime) +
                ', barrier time ' + (barrierTime.blockTime === null
                    ? 'UNKNOWN' : iso(barrierTime.blockTime)) + ' by ' + barrierTime.source + ')');
        }
        lastDecoderSeen = tip === null ? lastDecoderSeen : tip;
        const originNow = await origin.latestBlock();
        result.originLagSeries.push(Object.assign({ at: iso(nowS()), decoderTip: tip }, originNow));
        const nodeHeight = (await node.chainHeight()).height;
        const ready = [...pending.keys()]
            .filter((height) => nodeHeight !== null && height <= nodeHeight)
            .sort((left, right) => left - right);

        for (const height of ready) {
            const seen = pending.get(height);
            pending.delete(height);
            const observation = await observeBlock({
                node,
                conn,
                origin,
                tables,
                height,
                blockTime: seen.blockTime,
                firstSeenAt: seen.firstSeenAt,
                processedAt: nowS(),
                barrierBlockTime: seen.barrierBlockTime,
                barrierBlockTimeSource: seen.barrierBlockTimeSource,
                blockTransactionCount: seen.blockTransactionCount,
                deferrals: deferralsByHeight.get(height) || [],
                barrierSamples,
                sampleIntervalS: POLL_MS / 1000,
                originNow,
                maxBlockAgeS: settings.maxBlockAgeS,
                originActionPage: settings.originActionPage
            });
            result.observations.push(observation);
            const graded = usableObservations(result.observations).length;
            result.observe.gradedBlocks = graded;
            result.observe.unusableBlocks = result.observations.length - graded;
            write();
            console.log('at5: block ' + height + ' processed after ' + observation.stallS +
                's of block time (' + observation.escape + '), ' + observation.actions.length +
                ' action(s), ' + observation.verdictAgreements + ' agreeing / ' +
                observation.verdictDisagreements.length + ' diverging; ' +
                (observation.usable
                    ? 'GRADED (' + observation.ageAtFirstSeenS + 's old when first seen)'
                    : 'NOT GRADED: ' + observation.unusableReason + ' (' +
                      observation.ageAtFirstSeenS + 's old when first seen, limit ' +
                      settings.maxBlockAgeS + 's)') + '; graded ' + graded + ' of ' +
                settings.observeBlocks + ', verdicts compared ' +
                comparedVerdicts(result.observations) + ' of ' + settings.minVerdicts);
            if (satisfied()) break;
        }
        if (satisfied()) break;
        await sleep(POLL_MS);
    }

    noteBarrierSample(await readBarrierState(node.indexerPort));
    let reattributed = 0;
    for (const observation of result.observations) {
        const deferrals = deferralsByHeight.get(observation.height) || [];
        const samples = barrierSamples.concat(
            deferrals.map(barrierSampleFromDeferral).filter((sample) => sample !== null));
        const attribution = attributeEscape({
            blockTime: observation.barrierBlockTime,
            processedAt: observation.processedAtS,
            samples,
            graceS: PRICE_WATERMARK_GRACE_S,
            barrierApplies: observation.barrierApplies === null
                ? undefined : observation.barrierApplies,
            sampleIntervalS: POLL_MS / 1000
        });
        const previous = observation.escape;
        observation.escape = attribution.escape;
        observation.escapeEvidence = escapeRecord(
            attribution,
            deferrals,
            observation.escapeEvidence ? observation.escapeEvidence.deferralLineReading : null
        );
        if (previous !== observation.escape) reattributed++;
    }
    result.barrier.reattributedBlocks = reattributed;
    write();
    console.log('at5: final escape attribution over ' + result.barrier.samples +
        ' barrier sample(s): ' + reattributed + ' of ' + result.observations.length +
        ' observation(s) changed verdict against the first pass');

    const gradedTotal = usableObservations(result.observations).length;
    const comparedTotal = comparedVerdicts(result.observations);
    result.observe.gradedBlocks = gradedTotal;
    result.observe.unusableBlocks = result.observations.length - gradedTotal;
    result.observe.verdictsCompared = comparedTotal;
    result.observe.wantedVerdicts = settings.minVerdicts;
    return { gradedTotal, comparedTotal };
}

module.exports = { observeLiveBlocks };
