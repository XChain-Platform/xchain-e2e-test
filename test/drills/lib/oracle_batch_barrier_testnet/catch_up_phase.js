'use strict';

const {
    PRICE_WATERMARK_GRACE_S,
    POLL_MS,
    CATCHUP_LEG_MS,
    sleep,
    nowS,
    iso
} = require('./common');
const { decoderBlock } = require('./database_observations');
const { evaluateCatchUp } = require('./catch_up');

async function catchUpToLiveChain(ctx) {
    const { node, decoderConn, decoderDb, settings, result, deadline, write } = ctx;
    const catchUp = {
        slackBlocks: settings.catchUpSlackBlocks,
        toleranceS: settings.catchUpToleranceS,
        graceS: PRICE_WATERMARK_GRACE_S,
        startedAt: iso(nowS()),
        reachedAt: null,
        durationS: null,
        converged: false,
        reason: null,
        lastLegError: null,
        rounds: []
    };
    result.catchUp = catchUp;
    const startedAt = nowS();
    write();

    while (Date.now() < deadline) {
        const tipNow = (await node.decoderHeight()).height;
        const atNow = (await node.chainHeight()).height;
        const frontier = atNow === null ? null : await decoderBlock(decoderConn, decoderDb, atNow);
        const verdict = evaluateCatchUp({
            nodeHeight: atNow,
            nodeBlockTime: frontier ? frontier.blockTime : null,
            decoderTip: tipNow,
            nowSec: nowS(),
            slackBlocks: catchUp.slackBlocks,
            graceS: PRICE_WATERMARK_GRACE_S,
            toleranceS: catchUp.toleranceS
        });
        catchUp.rounds.push(Object.assign({
            at: iso(nowS()),
            nodeHeight: atNow,
            decoderTip: tipNow
        }, verdict));
        if (catchUp.rounds.length > 200) {
            catchUp.rounds.splice(100, catchUp.rounds.length - 200);
        }
        write();
        console.log('at5: catch-up: node at ' + atNow + ', decoder tip ' + tipNow + ' (' +
            verdict.blocksBehind + ' behind, working block ' + verdict.frontierAgeS + 's old, ' +
            'working point ' + verdict.workingPointS + 's): ' + verdict.reason);
        if (verdict.caughtUp) {
            catchUp.converged = true;
            catchUp.reason = verdict.reason;
            break;
        }
        if (tipNow === null) {
            await sleep(POLL_MS);
            continue;
        }
        const legMs = Math.max(60_000, Math.min(CATCHUP_LEG_MS, deadline - Date.now()));
        try {
            await node.waitForHeight(tipNow, { timeoutMs: legMs, intervalMs: POLL_MS });
        } catch (error) {
            catchUp.lastLegError = String(error && error.message).slice(0, 400);
        }
    }

    catchUp.durationS = nowS() - startedAt;
    if (!catchUp.converged) return false;
    catchUp.reachedAt = iso(nowS());
    write();
    console.log('at5: caught up in ' + catchUp.durationS + 's (' + catchUp.reason + ')');
    return true;
}

module.exports = { catchUpToLiveChain };
