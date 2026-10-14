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
 *
 * Rail-level helpers: indexer reads, resilient sends, mining pump and polling.
 ********************************************************************/

'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw JSON-RPC against an indexer, used for the reads the e2e Database class has
// no helper for (capability weights, latest block).
async function indexerRpc(rail, method, params) {
    const axios = require('axios');
    const url = 'http://' + rail.host + ':' + rail.ports.indexer;
    const res = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 20000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    const result = res.data ? res.data.result : null;
    // The federation reads answer an APPLICATION error inside `result` rather than
    // as a JSON-RPC error ({error: 'capability not configured'}, {error: 'block_index
    // N not yet indexed'}). Silently reading `.validators` off that yields an EMPTY
    // set that looks exactly like "nobody is staked", which is how a stale-tip read
    // once had this drill grind its keys against no competition and then fail four
    // steps later on the pinned responsible set.
    if (result && typeof result === 'object' && typeof result.error === 'string')
        throw new Error(method + ': ' + result.error);
    return result;
}

// Capability set at a block, tolerant of the one-block lag between the indexer's
// tip and its committed API view (federation reads run off apiView, so a read at
// the just-announced tip legitimately answers "not yet indexed").
async function capabilityWeights(rail, capability, blockIndex, attempts = 90) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await indexerRpc(rail, 'getstakeweightsbycapability',
                { capability, block_index: blockIndex });
            return res.validators || [];
        } catch (err) {
            lastErr = err;
            if (!/not yet indexed/.test(String(err.message))) throw err;
            await sleep(1500);
        }
    }
    throw lastErr;
}

async function railQuery(rail, sql, args) {
    const conn = await rail.globals.indexerDatabase.getConnection();
    try { return await conn.query(sql, args || []); }
    finally { await conn.release().catch(() => {}); }
}


// Races this suite already knows are timing, not action-level, faults: the
// encoder builds from the tracker's view, so a broadcast can reference an input
// bitcoind has already spent or (the one that bit this drill) collide with the
// still-unconfirmed predecessor it chained onto, which the node reports as an
// RBF replacement at the same feerate.
const TRANSIENT_SEND = /insufficient fee, rejecting replacement|txn-mempool-conflict|missingorspent|missing inputs|bad-txns-inputs|too-long-mempool-chain|no utxos|didn't appear in the blockchain|Internal encoder error|min relay fee/i;

// Send with a quiesce+mine barrier around those races. Must run inside withRail:
// the connectors come from the rail so it works on either chain.
async function resilientSend(label, rail, fn, attempts = 6) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try { return await fn(); }
        catch (err) {
            lastErr = err;
            if (attempt === attempts || !TRANSIENT_SEND.test(String(err && err.message))) throw err;
            console.log('    [relay-loop] ' + label + ' attempt ' + attempt + '/' + attempts +
                        ' hit a stack race (' + String(err.message).slice(0, 110) + '); quiescing');
            try {
                await rail.globals.utxoTrackerConnector.quiesce(
                    { timeoutMs: 20000, pollMs: 250, regtestMiner: rail.globals.regtestMinerConnector });
            } catch (e) { /* best effort */ }
            try { await rail.globals.regtestMinerConnector.generateBlocks(1); } catch (e) { /* best effort */ }
        }
    }
    throw lastErr;
}

// A regtest stack whose miner has been left with idle mining PAUSED (a reorg
// drill's parting gift, and the state this drill found the shared venue in)
// mines only when something asks it to. The connector lane's confirmation wait
// does not ask, so every transaction sat out its full 60s budget and the mint
// phase alone ran over an hour. This pump is the idle miner, supplied by the
// drill for the chain it is hammering: bounded, best-effort, and stopped in the
// teardown. It is never pointed at the ORIGIN chain, whose blocks are the clock
// the request's deadline runs on.
// It is BACK-PRESSURED on the indexer, which is not optional: an unconditional
// 2s pump outruns block processing, and the DB waits every step depends on then
// fail with the indexer 150 blocks behind the tip - a self-inflicted version of
// the very lag this drill would otherwise be measuring.
// Mine ONE block, but only when doing so helps: something is waiting in the
// mempool, and the indexer is not already behind. Both guards are load-bearing
// on this venue, where a single empty block costs the indexer 5-25 seconds:
// unconditional mining put it 150 blocks behind the tip and every DB wait in the
// drill then timed out on lag the drill had itself created.
async function maybeMine(rail, maxLag = 3) {
    try {
        const mempool = await rail.globals.nodeConnector.getRawMempool();
        if (!mempool || !mempool.length) return false;
        const nodeTip = await rail.globals.nodeConnector.getBlockCount();
        const indexed = (await indexerRpc(rail, 'getlatestblock', {})).block_index;
        if (Number(nodeTip) - Number(indexed) > maxLag) return false;
        await rail.globals.regtestMinerConnector.generateBlocks(1);
        return true;
    } catch (e) { return false; }
}

function startMiningPump(rail, intervalMs = 2500) {
    let busy = false;
    const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try { await maybeMine(rail); }
        finally { busy = false; }
    }, intervalMs);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
}

// Block until the indexer has COMMITTED `height`. Every capability read is
// answered off the committed API view, so reading right after mining answers
// "block_index N not yet indexed" - and on this venue a block costs the indexer
// 5-25 seconds, so "right after" can be a minute wide.
async function waitForIndexedHeight(rail, height, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = (await indexerRpc(rail, 'getlatestblock', {})).block_index;
        if (Number(last) >= Number(height)) return Number(last);
        await sleep(3000);
    }
    throw new Error('indexer never reached block ' + height + ' (last ' + last + ')');
}

// Poll `fn` until it returns something truthy, mining on the given rail as we go
// so a quiet regtest chain still advances (relay legs need confirmations).
async function pumpUntil(label, rail, fn, timeoutMs = 240000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const got = await fn();
        if (got) return got;
        await maybeMine(rail);
        await sleep(3000);
    }
    throw new Error('timed out waiting for ' + label);
}

module.exports = {
    sleep, indexerRpc, capabilityWeights, railQuery, resilientSend, maybeMine,
    startMiningPump, waitForIndexedHeight, pumpUntil
};
