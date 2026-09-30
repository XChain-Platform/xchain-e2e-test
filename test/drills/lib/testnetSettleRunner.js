'use strict';

const FUND_AMOUNT = 1;
const ORDER_AMOUNT = 100;

function defaultLegs() {
    return Object.assign(
        {},
        require('./testnetSettleOrderLeg'),
        require('./testnetSettleCounterLeg'),
        require('./testnetSettleMatchWait'),
        require('./testnetSettleSettlementWait')
    );
}

function publicFunding(result) {
    if (!result || typeof result !== 'object') return result;
    return { address: result.address, txid: result.txid };
}

function uniqueTickGenerator() {
    const suffix = Date.now().toString(36).slice(-8).toUpperCase();
    const ticks = new Map();
    return (prefix) => {
        if (!ticks.has(prefix)) ticks.set(prefix, String(prefix).toUpperCase() + suffix);
        return ticks.get(prefix);
    };
}

function blockWait(waitBlocks, topology, coin) {
    return (blocks) => waitBlocks({
        explorerUrl: topology.explorerUrl,
        coin,
        blocks,
        timeoutMs: topology.deadlines.inclusionMs
    });
}

function safeMessage(error, secret) {
    const message = error && error.message ? error.message : String(error);
    if (!secret) return message;
    return message.split(String(secret)).join('[redacted]');
}

function stepRunner(verdict, log, secret) {
    const writeLog = typeof log === 'function' ? log : () => {};
    return async function runStep(name, action, summarize = (result) => result) {
        const startedAt = Date.now();
        try {
            const result = await action();
            const ms = Date.now() - startedAt;
            verdict.steps.push({ name, ms, result: summarize(result) });
            writeLog(name + ' completed in ' + ms + 'ms');
            return result;
        } catch (error) {
            const ms = Date.now() - startedAt;
            const message = safeMessage(error, secret);
            verdict.failedStep = name;
            verdict.steps.push({ name, ms, result: { error: message } });
            writeLog(name + ' failed in ' + ms + 'ms: ' + message);
            throw error;
        }
    };
}

async function driveSettle(args, legs, runStep) {
    const { topology, fund, waitBlocks, btcSdk, dogeSdk, submitFn, treasury, log } = args;
    const uniqueTick = uniqueTickGenerator();
    const btcMaker = await runStep('fund-btc-maker',
        () => fund({ sdk: btcSdk, treasury, amount: FUND_AMOUNT, log }), publicFunding);
    const dogeMaker = await runStep('fund-doge-maker',
        () => fund({ sdk: dogeSdk, treasury, amount: FUND_AMOUNT, log }), publicFunding);
    const counter = await runStep('place-doge-counter-order', () => legs.placeDogeCounterOrder({
        dogeSdk, submitFn, maker: dogeMaker, amount: ORDER_AMOUNT, btcRecv: btcMaker.address,
        waitBlocks: blockWait(waitBlocks, topology, topology.dogeCoin), uniqueTick, log
    }));
    const order = await runStep('place-btc-order', () => legs.placeBtcCrossOrder({
        sdk: btcSdk, submitFn, maker: btcMaker, amount: ORDER_AMOUNT,
        dogeTick: counter.dogeTick, dogeMakerBtcRecv: counter.btcRecv,
        waitBlocks: blockWait(waitBlocks, topology, topology.btcCoin), uniqueTick, log
    }));
    const match = await runStep('await-match', () => legs.awaitCrossChainMatch({
        explorerUrl: topology.explorerUrl, coin: topology.btcCoin,
        orderTxid: order.orderTxid, timeoutMs: topology.deadlines.matchMs
    }));
    const matchId = match.match_id === undefined ? match.matchId : match.match_id;
    await runStep('await-btc-settlement', () => legs.awaitBtcSettlement({
        explorerUrl: topology.explorerUrl, coin: topology.btcCoin, matchId,
        dogeMakerBtcRecv: counter.btcRecv, timeoutMs: topology.deadlines.settleMs
    }));
    await runStep('observe-doge-settlement', () => legs.observeDogeSettlement({
        explorerUrl: topology.explorerUrl, coin: topology.dogeCoin, matchId,
        dogeMakerBtcRecv: counter.btcRecv, timeoutMs: topology.deadlines.settleMs
    }));
}

async function runCrossChainSettle(args) {
    const verdict = { ok: false, failedStep: null, steps: [] };
    const legs = args.legs || defaultLegs();
    try {
        const secret = args.treasury && args.treasury.wif;
        await driveSettle(args, legs, stepRunner(verdict, args.log, secret));
        verdict.ok = true;
    } catch (_) {
        verdict.ok = false;
    }
    return verdict;
}

module.exports = { runCrossChainSettle };
