'use strict';

const fs = require('fs');
const path = require('path');
const {
    OracleBatchReplayNode,
    connectTo,
    verdictTables
} = require('../../../helpers/oracleBatchReplay');
const {
    PRICE_WATERMARK_GRACE_S,
    POLL_MS,
    COIN,
    NETWORK,
    nowS,
    iso
} = require('./common');
const { composeLiveChainFromEnv, readSettings } = require('./settings');
const { OriginView } = require('./origin_alignment');
const { decoderRange, batchCoverage } = require('./database_observations');
const { parseDeferral } = require('./barrier_attribution');
const { usableObservations, comparedVerdicts } = require('./catch_up');
const { summarize } = require('./reporting');
const { catchUpToLiveChain } = require('./catch_up_phase');
const { observeLiveBlocks } = require('./observe_phase');

function createResult(settings) {
    return {
        drill: 'oracleBatchBarrierTestnet',
        coin: COIN,
        network: NETWORK,
        startedAt: iso(nowS()),
        finishedAt: null,
        status: 'incomplete',
        error: null,
        settings: {
            label: settings.label,
            basePort: settings.basePort,
            observeBlocks: settings.observeBlocks,
            maxMinutes: settings.maxMinutes,
            originIndexerUrl: settings.originIndexerUrl,
            explorerUrl: settings.explorerUrl,
            priceWatermarkGraceS: PRICE_WATERMARK_GRACE_S,
            priceGraceOverride: null,
            maxBlockAgeS: settings.maxBlockAgeS,
            catchUpSlackBlocks: settings.catchUpSlackBlocks,
            catchUpToleranceS: settings.catchUpToleranceS,
            originActionPage: settings.originActionPage
        },
        node: null,
        replay: null,
        catchUp: null,
        observe: null,
        barrier: {
            graceS: PRICE_WATERMARK_GRACE_S,
            sampleIntervalS: POLL_MS / 1000,
            source: "the node's own GET /status: hubMirror.streamWatermark and " +
                'hubMirror.tables.price_snapshots, which mirrorStatus() fills from ' +
                'streamWatermark and priceSyncMaxTimestamp, the two inputs of ' +
                '_priceTimeSyncSatisfied',
            startedAt: null,
            lastAt: null,
            samples: 0,
            failures: 0,
            lastError: null,
            series: []
        },
        observations: [],
        originLagSeries: [],
        summary: null
    };
}

function createRunState(result, settings) {
    const barrierSamples = [];
    const deferralsByHeight = new Map();
    const noteBarrierSample = (sample) => {
        if (!sample) return;
        barrierSamples.push(sample);
        if (barrierSamples.length > 2000) barrierSamples.shift();
        result.barrier.samples++;
        result.barrier.lastAt = iso(sample.at);
        if (result.barrier.startedAt === null) result.barrier.startedAt = iso(sample.at);
        if (sample.error) {
            result.barrier.failures++;
            result.barrier.lastError = sample.error;
        }
        result.barrier.series.push(sample);
        if (result.barrier.series.length > 5000) {
            result.barrier.series.splice(2500, result.barrier.series.length - 5000);
        }
    };
    const onLog = (which, line) => {
        if (which !== 'indexer') return;
        const deferral = parseDeferral(line);
        if (!deferral) return;
        if (!deferralsByHeight.has(deferral.height)) deferralsByHeight.set(deferral.height, []);
        const kept = deferralsByHeight.get(deferral.height);
        kept.push(deferral);
        if (kept.length > 40) kept.splice(20, kept.length - 40);
    };
    const write = () => {
        const output = path.resolve(settings.resultPath);
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
        return output;
    };
    return { barrierSamples, deferralsByHeight, noteBarrierSample, onLog, write };
}

async function main(env) {
    env = env || process.env;
    const settings = readSettings(env);
    const liveChain = composeLiveChainFromEnv(env);
    const origin = new OriginView(settings);
    const deadline = Date.now() + settings.maxMinutes * 60_000;
    const result = createResult(settings);
    const state = createRunState(result, settings);
    let node = null;
    let conn = null;
    let decoderConn = null;
    let exitCode = 0;

    try {
        node = new OracleBatchReplayNode({
            label: settings.label,
            coin: COIN,
            network: NETWORK,
            basePort: settings.basePort,
            liveChain,
            onLog: state.onLog
        });
        console.log('at5: building a chain-only ' + COIN + '/' + NETWORK +
            ' node (label ' + settings.label + ')...');
        const up = await node.up();
        if (!up) throw new Error('the node could not be built: ' + node.unavailable);
        conn = await connectTo({
            host: node.hubDb.host,
            port: node.hubDb.port,
            user: node.hubDb.user,
            pass: node.hubDb.pass
        });
        decoderConn = await connectTo(liveChain.decoder);
        result.node = {
            hubDbDisposable: !!node.hubDb.disposable,
            hubDbName: node.hubDbName,
            indexerDbName: node.indexerDbName,
            mirrorDbName: node.mirrorDbName,
            hubPort: node.hubPort,
            indexerPort: node.indexerPort,
            feeDestinationSet: !!node.feeDestination(),
            btcOracle: node.btcOracleEvidence(),
            isolation: await node.isolationEvidence()
        };
        console.log('at5: node up (hub ' + node.hubPort + ', indexer ' + node.indexerPort +
            '), isolation ' + JSON.stringify(result.node.isolation));

        const range = await decoderRange(decoderConn, liveChain.decoder.name);
        const startTip = range.last;
        const replayStartedAt = nowS();
        result.replay = {
            firstBlock: range.first,
            targetHeight: startTip,
            startedAt: iso(replayStartedAt),
            reachedAt: null,
            durationS: null,
            blocksIndexed: null,
            coverage: null
        };
        state.write();
        console.log('at5: replaying ' + range.first + '..' + startTip + ' (decoder tip at start)...');
        try {
            await node.waitForHeight(startTip, {
                timeoutMs: Math.max(60_000, deadline - Date.now()),
                intervalMs: POLL_MS
            });
        } catch (error) {
            result.status = 'replay-timeout';
            result.error = String(error && error.message).slice(0, 4000);
            console.error('at5: the node never reached block ' + startTip + ' inside the budget');
            exitCode = 2;
            return exitCode;
        }
        const reachedAt = nowS();
        result.replay.reachedAt = iso(reachedAt);
        result.replay.durationS = reachedAt - replayStartedAt;
        result.replay.blocksIndexed = (await node.chainHeight()).blocks;
        result.replay.coverage = await batchCoverage(
            conn, node.indexerDbName, node.hubDbName, node.mirrorDbName);
        state.write();
        console.log('at5: reached the start tip in ' + result.replay.durationS + 's; parsed ' +
            result.replay.coverage.batchesValid + ' valid batch(es) carrying ' +
            result.replay.coverage.roundsCarried + ' round(s), hub holds ' +
            result.replay.coverage.roundsInHub + ', mirror ' + result.replay.coverage.roundsInMirror);

        const caughtUp = await catchUpToLiveChain({
            node,
            decoderConn,
            decoderDb: liveChain.decoder.name,
            settings,
            result,
            deadline,
            write: state.write
        });
        if (!caughtUp) {
            result.status = 'catchup-timeout';
            result.error = 'the node never reached the live tip or the barrier working point inside the budget' +
                (result.catchUp.lastLegError ? '; last leg: ' + result.catchUp.lastLegError : '');
            result.summary = summarize(result);
            console.error('at5: the node never caught up to the live chain inside the budget');
            exitCode = 2;
            return exitCode;
        }

        const tables = await verdictTables(conn, node.indexerDbName);
        const totals = await observeLiveBlocks({
            node,
            conn,
            decoderConn,
            decoderDb: liveChain.decoder.name,
            origin,
            tables,
            settings,
            result,
            deadline,
            startTip,
            deferralsByHeight: state.deferralsByHeight,
            barrierSamples: state.barrierSamples,
            noteBarrierSample: state.noteBarrierSample,
            write: state.write
        });
        if (totals.gradedTotal >= settings.observeBlocks && totals.comparedTotal >= settings.minVerdicts) {
            result.status = 'completed';
            exitCode = 0;
        } else if (totals.gradedTotal >= settings.observeBlocks) {
            result.status = 'insufficient-parity-traffic';
            result.error = 'graded ' + totals.gradedTotal + ' block(s) but compared only ' +
                totals.comparedTotal + ' verdict(s) against origin, under the ' +
                settings.minVerdicts + ' this run required';
            console.error('at5: graded enough blocks but the chain carried too few actions to compare verdicts');
            exitCode = 4;
        } else if (totals.gradedTotal === 0) {
            result.status = 'no-live-blocks-observed';
            result.error = 'observed ' + result.observations.length +
                ' block(s), none of which arrived within ' + settings.maxBlockAgeS +
                's of its block time, so none could be graded';
            console.error('at5: NOTHING was graded: every observed block was already stale when first seen');
            exitCode = 3;
        } else {
            result.status = 'budget-exhausted';
            exitCode = 0;
        }
        result.summary = summarize(result);
    } catch (error) {
        result.status = 'error';
        result.error = String((error && error.stack) || error).slice(0, 8000);
        console.error('at5: ' + String(error && error.message));
        exitCode = 1;
    } finally {
        for (const connection of [conn, decoderConn]) {
            if (connection) {
                try { await connection.end(); } catch (internal) { }
            }
        }
        if (node) {
            try { await node.down(); } catch (error) {
                console.error('at5: teardown: ' + (error && error.message));
            }
        }
        result.finishedAt = iso(nowS());
        if (!result.summary) result.summary = summarize(result);
        const output = state.write();
        console.log('at5: ' + result.status + '; result written to ' + output);
    }
    return exitCode;
}

module.exports = { main };
