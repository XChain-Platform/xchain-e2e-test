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
 * XChain Platform E2E - CROSS-CHAIN ATTESTATION RELAY LOOP
 * (Phase 5, spec §12).
 *
 * Drives the whole §12 relay loop on a live multi-chain regtest venue:
 *
 *   1. ORIGIN (LTC): a contract emits ATTEST v0. Off BTC the responsible set is
 *      empty by construction, so before ATTEST_RELAY_ORIGIN this was rejected at
 *      admission; at/above it the request is admitted `pending` and STAMPED with
 *      its origin chain. That stamp is the only marker the relay keys on.
 *   2. HOME (BTC): the request is materialized as ATTEST v3 carrying a
 *      cross_chain quorum, and lands with a real BTC block_index, which is the
 *      entire point of the model (the responsible set and the block-echo check
 *      resolve on the BTC plane exactly as for a native request).
 *   3. HOME (BTC): the existing Phase 2 machinery fulfills it - a real fetch
 *      through the production http_get provider, signed by the request's pinned
 *      responsible set, broadcast as an ordinary ATTEST v1. The home chain fires
 *      NO callback: the contract is not on this chain.
 *   4. ORIGIN (LTC): the response relays back as ATTEST v4, the origin request
 *      flips terminal, the fee settles, and the contract callback is injected on
 *      the chain the contract actually lives on.
 *
 * WHAT STANDS IN FOR WHAT, stated plainly. Both relay legs are on-chain actions
 * carrying a cross_chain quorum; the hub's AttestationRelay is the thing that
 * normally runs the two PBFT rounds and broadcasts them. This drill runs those
 * legs with in-test federation signers, the same way
 * test/actions/realUrlAttestation.test.js stands in for AttestationRound +
 * AttestationPublisher on the single-chain path. The BYTES are not stood in for:
 * the v3/v4 canonicals and wire strings are built by the HUB'S OWN
 * AttestationRelay methods (`xchain-hub/src/AttestationRelay.js`), so a
 * hub↔indexer canonical drift fails this drill rather than hiding in it. Every
 * verdict is the deployed indexer's.
 *
 * VENUE (a standard multi-coin `xchain-node` regtest stack):
 *   - BTC + LTC regtest, both indexers carrying the attestation relay code
 *     (src/attest_relay_activation.js present). Both gates are genesis-active on
 *     regtest (ATTEST_RELAY_ACTIVATION regtest: 0, ATTEST_RELAY_ORIGIN regtest:
 *     0), so "gates forced active" needs no override here.
 *   - Run under the BTC e2e env; the LTC rail is built by test/helpers/chainRail
 *     from published host ports + hub-discovered credentials.
 *
 * TWO SIDE EFFECTS ON A SHARED VENUE, both deliberate and both undone/bounded:
 *   a) cross_chain quorum is STAKE-WEIGHTED on regtest (genesis-active), and BTC
 *      resolves that capability from LOCAL stakes. To sign a v3 the drill must
 *      hold >2/3 of cross_chain stake, so it stakes above the live federation and
 *      UNSTAKES again as soon as the v3 has landed (an `after` hook repeats the
 *      unstake if a step failed in between). The XCHAIN behind that stake is
 *      minted in the FIRST step and staked in the LAST step before the v3, which
 *      keeps the window in which the live hub is a stake minority down to a few
 *      blocks rather than the whole run. Still: do not run this drill against a
 *      venue another session is driving XCALL/DEX settlement on.
 *   b) the origin chain verifies cross_chain against the HUB-MIRRORED
 *      capability_snapshots, not local stakes. On a venue whose hub does not
 *      publish a cross_chain snapshot, the drill seeds exactly the rows the
 *      mirror would have carried, at the one snapshot_block the v4 names.
 *
 * RUN:
 *   npm run test:attest-relay-loop
 * or
 *   npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *       test/sdk/attestationRelayLoopDrill.js
 *
 * Env knobs: XC974_ORIGIN_COIN (default litecoin), XC974_ATTEST_URL,
 * XC974_REDUNDANCY (1|3|5, default 3), XC974_SKIP_IF_NO_VENUE (default 1).
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const _path  = require('path');
const _fs    = require('fs');

const cryptoHelper      = require('../cryptoHelper');
const transactionHelper = require('../transactionHelper');
const gasHelper         = require('../helpers/gasHelper');
const vmHelper          = require('../helpers/vmHelper');
const attestationHelper = require('../helpers/attestationHelper');
const chainRail         = require('../helpers/chainRail');

// Resolve the bundled hub (in-image) first, then the monorepo sibling - the same
// loader test/actions/realUrlAttestation.test.js uses for the provider.
const HUB_BASE = (function () {
    const candidates = [
        process.env.XCHAIN_HUB_PATH,
        _path.resolve(__dirname, '../../xchain-hub'),
        _path.resolve(__dirname, '../../../xchain-hub'),
    ].filter(Boolean);
    for (const c of candidates) {
        if (_fs.existsSync(_path.join(c, 'src/AttestationRelay.js'))) return c;
    }
    return null;
})();

const ORIGIN_COIN = process.env.XC974_ORIGIN_COIN || 'litecoin';
const ATTEST_URL  = process.env.XC974_ATTEST_URL  || 'https://jsonplaceholder.typicode.com/todos/1';
const REDUNDANCY  = parseInt(process.env.XC974_REDUNDANCY || '3', 10);
// http_get's registry entry: deadline_window_blocks = 100, so this is the
// longest deadline the origin request may name.
const DEADLINE_BLOCKS = 100;
// XCHAIN carries a 100000 per-action MAX_MINT on these venues, so a large stake
// is assembled from repeated mints rather than one.
const MINT_CHUNK = 100000;
const ATTESTATION_MIN_STAKE = '1500.00000000';
const ACTIVATION_DELAY_BLOCKS = 6;

// The origin contract. Deliberately the realUrlAttestation shape: one method
// that requests, one that records every callback argument, so the assertions can
// prove the relayed callback is INDISTINGUISHABLE from a local one.
const ORIGIN_CONTRACT = `
module.exports = {
    askAcrossChains: function(xchain) {
        var url = xchain.getInputParam(0);
        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'handleResponse',
            ['ctx-xc974'],
            { redundancy: ${REDUNDANCY}, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        xchain.state.set('relay_request_id', requestId);
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_request_id',  xchain.getInputParam(0));
        xchain.state.set('callback_provider_id', xchain.getInputParam(1));
        xchain.state.set('callback_status',      xchain.getInputParam(2));
        xchain.state.set('callback_payload',     xchain.getInputParam(3));
        xchain.state.set('callback_context',     xchain.getInputParam(4));
    }
};
`;

// ── production canonical/wire codec, borrowed from the hub ────────────────────
// The relay's canonical + wire builders depend on nothing but `this._sha256`, so
// binding them onto a bare object runs the SHIPPED hub implementation without
// booting a hub. If these ever stop being pure, this throws here rather than
// producing signatures the indexer silently drops as unquorate.
function relayCodec() {
    if (!HUB_BASE) throw new Error('xchain-hub checkout not found; the drill signs with the hub\'s own canonical builders');
    const AttestationRelay = require(_path.join(HUB_BASE, 'src/AttestationRelay.js'));
    const p = AttestationRelay.prototype;
    const codec = {
        _sha256: p._sha256,
        requestCanonical:  function (r) { return p._relayRequestCanonical.call(codec, r); },
        responseCanonical: function (r) { return p._relayResponseCanonical.call(codec, r); },
        requestWire:       function (r, sigs) { return p._buildRequestWire.call(codec, r, sigs); },
        responseWire:      function (r, sigs) { return p._buildResponseWire.call(codec, r, sigs); },
    };
    return codec;
}

// An Ed25519 federation key that signs relay canonicals. Same shape as
// attestationHelper.MockAttestationValidator (raw 32-byte pubkey hex), but the
// message is a full canonical string rather than the v1 field tuple.
class RelaySigner {
    constructor() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        this.privateKey = privateKey;
        this.pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
        this.source = null;
    }
    sign(canonical) {
        return crypto.sign(null, Buffer.from(String(canonical), 'utf8'), this.privateKey).toString('hex');
    }
}

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

// Rank a pubkey the way _computeResponsibleSet does: SHA256(request_id || pubkey).
function responsibleRank(requestId, pubkey) {
    return crypto.createHash('sha256')
        .update(String(requestId), 'utf8')
        .update(String(pubkey).toLowerCase(), 'utf8')
        .digest('hex');
}

// Generate `count` attestation keys that outrank EVERY key already staked for the
// capability, so the request's responsible set is exactly ours. This is what lets
// the drill run on a venue with a pre-existing validator set instead of demanding
// the freshly-reset chain realUrlAttestation needs; the selection rule is
// untouched, we simply bring keys that win it.
function grindResponsibleKeys(requestId, count, existingPubkeys) {
    let ceiling = null;
    for (const pk of existingPubkeys) {
        const h = responsibleRank(requestId, pk);
        if (ceiling === null || h < ceiling) ceiling = h;
    }
    const winners = [];
    for (let tries = 0; winners.length < count; tries++) {
        if (tries > 200000) throw new Error('could not grind ' + count + ' top-ranked attestation keys');
        const v = new attestationHelper.MockAttestationValidator();
        if (ceiling !== null && responsibleRank(requestId, v.pubkey) >= ceiling) continue;
        winners.push(v);
    }
    // Ours must also be the top `count` AMONG THEMSELVES in a stable way; sorting
    // here only makes the log readable, the indexer re-derives the order.
    winners.sort((a, b) => (responsibleRank(requestId, a.pubkey) < responsibleRank(requestId, b.pubkey) ? -1 : 1));
    return winners;
}

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// STAKE/UNSTAKE broadcast + a DB wait keyed on the SIGNING PUBKEY.
//
// stakeHelper's own wait is keyed on the broadcast txid with a 60s budget, and
// both halves of that are wrong for this drill: a STAKE v1 carrying a 64-hex
// signing key is 87 bytes of payload, so the encoder always picks the two-phase
// P2SH path, and on a busy indexer the row can surface well after the budget.
// The failure mode is the expensive one - the stake IS on-chain and valid, the
// harness just gave up on it, and every later step then runs against a snapshot
// block that was never computed. Keying on the pubkey and polling until the row
// appears removes both.
async function stakeKeyFrom(rail, addressInfo, amount, pubkey, label) {
    await resilientSend(label, rail, () =>
        transactionHelper.createAndSendTransaction(addressInfo, 'STAKE|1|' + amount + '|' + pubkey));
    const row = await pumpUntil(label + ' row', rail, async () => {
        const rows = await railQuery(rail,
            'SELECT s.action_index, s.amount, s.activation_block, st.status ' +
            'FROM stakes s JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id ' +
            'LEFT JOIN index_statuses st ON st.id = s.status_id ' +
            'WHERE ip.pubkey = ? ORDER BY s.action_index DESC LIMIT 1', [String(pubkey).toLowerCase()]);
        return rows.length ? rows[0] : null;
    }, 300000);
    assert.strictEqual(String(row.status), 'valid', label + ' indexed ' + row.status);
    return row;
}

async function unstakeKeyFrom(rail, addressInfo, pubkey, label) {
    await resilientSend(label, rail, () =>
        transactionHelper.createAndSendTransaction(addressInfo, 'UNSTAKE|0|' + pubkey));
    return pumpUntil(label + ' row', rail, async () => {
        const rows = await railQuery(rail,
            'SELECT s.deactivation_block FROM stakes s JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id ' +
            'WHERE ip.pubkey = ? ORDER BY s.action_index DESC LIMIT 1', [String(pubkey).toLowerCase()]);
        return (rows.length && rows[0].deactivation_block != null) ? rows[0] : null;
    }, 300000);
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

describe('[drill] cross-chain attestation relay loop (origin -> BTC -> origin)', function () {
    this.timeout(0);

    let stopMiningPump = null;
    let homeRail = null;         // BTC, the chain initialCheck bootstrapped
    let originRail = null;       // LTC (or DOGE), built by chainRail
    let codec = null;

    let originOperator = null;
    let originContract = null;
    let originRequestId = null;
    let originRequest = null;    // the v0 row on the origin chain

    let homeOperator = null;
    let relaySigner = null;      // the cross_chain federation key
    let relayStakeSource = null; // the address holding the drill's cross_chain stake
    let relayStakeAmount = null;
    let relayStakeUnwound = false;
    let attestStakeSources = [];
    let responsibleValidators = [];
    let snapshotBlock = null;
    let homeResponseActionIndex = null;
    let realBody = null;
    let realMeta = null;

    // Give the venue its cross_chain weights back. Safe to call twice: an UNSTAKE
    // for a key with no active stake simply indexes invalid and is logged.
    async function unwindRelayStake(where) {
        if (relayStakeUnwound || !relayStakeSource || !relaySigner) return;
        relayStakeUnwound = true;
        try {
            await chainRail.withRail(homeRail, async () => {
                const row = await unstakeKeyFrom(homeRail, relayStakeSource, relaySigner.pubkey, 'cross_chain unstake');
                // UNSTAKE schedules the deactivation a few blocks out, so the stake is
                // still counted until that height. On a venue whose idle miner is
                // paused nothing would ever reach it, and the drill would leave the
                // live federation in the stake minority it created. Mine to it and
                // CHECK, rather than declaring the venue restored on the broadcast.
                const deactivateAt = Number(row.deactivation_block);
                let tip = await global.nodeConnector.getBlockCount();
                if (Number.isFinite(deactivateAt) && tip < deactivateAt)
                    await global.regtestMinerConnector.generateBlocks(deactivateAt - tip + 1);
                tip = await global.nodeConnector.getBlockCount();
                await waitForIndexedHeight(homeRail, tip);
                const still = (await capabilityWeights(homeRail, 'cross_chain', tip))
                    .some(v => String(v.pubkey).toLowerCase() === relaySigner.pubkey);
                assert(!still, 'the drill cross_chain key still qualifies at ' + tip + ' after UNSTAKE');
            });
            console.log('    [relay-loop] cross_chain stake unwound (' + where + ')');
        } catch (e) {
            console.error('    [relay-loop] WARNING: could not unwind the drill cross_chain stake (' + where +
                          '): ' + e.message + '. UNSTAKE ' + relaySigner.pubkey + ' from ' +
                          relayStakeSource.address + ' before leaving the venue to another session.');
        }
    }

    before(async function () {
        if (String(global.COIN_CODE) !== 'BTC') {
            console.log('    [relay-loop] the home chain is BTC by protocol; skipping on ' + global.COIN_CODE);
            this.skip();
            return;
        }
        assert.notStrictEqual(String(global.NETWORK), 'mainnet', 'this drill never runs against mainnet');
        codec = relayCodec();
        homeRail = chainRail.captureCurrentRail();

        try {
            originRail = await chainRail.createRail(ORIGIN_COIN, global.NETWORK);
        } catch (e) {
            if (process.env.XC974_SKIP_IF_NO_VENUE === '0') throw e;
            console.log('    [relay-loop] no ' + ORIGIN_COIN + ' rail (' + e.message + '); skipping');
            this.skip();
            return;
        }
        const failures = await chainRail.railFailures(originRail);
        if (failures.length) {
            if (process.env.XC974_SKIP_IF_NO_VENUE === '0')
                throw new Error('origin rail unavailable: ' + failures.join(', '));
            console.log('    [relay-loop] origin rail unavailable (' + failures.join(', ') + '); skipping');
            this.skip();
            return;
        }
        console.log('    [relay-loop] home=' + homeRail.code + ' origin=' + originRail.code +
                    ' url=' + ATTEST_URL + ' redundancy=' + REDUNDANCY);
        stopMiningPump = startMiningPump(homeRail);
    });

    after(async function () {
        await unwindRelayStake('teardown');
        if (stopMiningPump) stopMiningPump();
    });

    // Provisioning runs FIRST, and it is the slow part: the drill's cross_chain
    // majority is assembled out of MAX_MINT-sized XCHAIN mints, dozens of them,
    // each its own confirmed transaction. Done after the origin request it would
    // burn most of the request's DEADLINE_BLOCKS window (the origin chain keeps
    // mining while BTC is minting), and a request that expires mid-drill fails at
    // the v4 with a misleading "REQUEST already expired". Nothing here touches the
    // capability sets: minting gas is invisible to quorum, and the STAKE that is
    // NOT invisible happens later, in the step just before the v3.
    it('HOME: provisions funded sources and the XCHAIN the drill federation will stake', async function () {
        await chainRail.withRail(homeRail, async () => {
            homeOperator = await resilientSend('home operator funding', homeRail, () =>
                cryptoHelper.getNewFundedAddress(
                    'xc974-home-op-' + Date.now(), homeRail.coin, homeRail.network, null, 'legacy', 0, 0.2, false));
            await resilientSend('home gas', homeRail, () => gasHelper.ensureGasBalance(homeOperator, '5000'));

            // One funded source per responsible slot: SWQ source-dedup keeps a single
            // slot per source, so same-source keys could never fill the set. The KEYS
            // are not known yet (they are ground against the request id), only the
            // addresses that will stake them.
            for (let i = 0; i < REDUNDANCY; i++) {
                const src = await resilientSend('attestation staker ' + i + ' funding', homeRail, () =>
                    cryptoHelper.getNewFundedAddress(
                        'xc974-att-' + i + '-' + Date.now(), homeRail.coin, homeRail.network, null, 'legacy', 0, 0.05, false));
                await resilientSend('attestation staker ' + i + ' gas', homeRail, () =>
                    gasHelper.ensureGasBalance(src, '3000'));
                attestStakeSources.push(src);
            }

            // cross_chain is stake-weighted on regtest and BTC resolves it from LOCAL
            // stakes, so the drill needs more than 2/3 of it: 3Y > 2(S+Y) -> Y > 2S.
            const tip = (await indexerRpc(homeRail, 'getlatestblock', {})).block_index;
            const ccWeights = await capabilityWeights(homeRail, 'cross_chain', tip);
            const bySource = new Map();
            for (const v of ccWeights) bySource.set(String(v.source), Number(v.weight));
            const liveStake = Array.from(bySource.values()).reduce((a, b) => a + b, 0);
            relayStakeAmount = Math.ceil((2 * liveStake + MINT_CHUNK) / MINT_CHUNK) * MINT_CHUNK;
            console.log('    [relay-loop] live cross_chain stake ' + liveStake + '; drill will stake ' + relayStakeAmount);

            relaySigner = new RelaySigner();
            relayStakeSource = await resilientSend('cross_chain staker funding', homeRail, () =>
                cryptoHelper.getNewFundedAddress(
                    'xc974-cc-' + Date.now(), homeRail.coin, homeRail.network, null, 'legacy', 0, 1, false));
            const chunks = Math.ceil(relayStakeAmount / MINT_CHUNK);
            const mintStarted = Date.now();
            for (let i = 0; i < chunks; i++) {
                await resilientSend('gas mint ' + (i + 1) + '/' + chunks, homeRail, () =>
                    gasHelper.mintGas(relayStakeSource, String(MINT_CHUNK)));
                if ((i + 1) % 5 === 0 || i + 1 === chunks)
                    console.log('    [relay-loop] minted ' + ((i + 1) * MINT_CHUNK) + '/' + relayStakeAmount +
                                ' XCHAIN (' + Math.round((Date.now() - mintStarted) / 1000) + 's)');
            }
        });
    });

    it('ORIGIN: a contract emits ATTEST v0 and the indexer admits it as relay-eligible', async function () {
        await chainRail.withRail(originRail, async () => {
            originOperator = await resilientSend('origin operator funding', originRail, () =>
                cryptoHelper.getNewFundedAddress(
                    'xc974-origin-op-' + Date.now(), originRail.coin, originRail.network, null, 'legacy', 0, 0.2, false));
            await resilientSend('origin gas', originRail, () => gasHelper.ensureGasBalance(originOperator, '5000'));

            const deploy = await resilientSend('origin deploy', originRail, () =>
                vmHelper.sendDeployV0(originOperator, ORIGIN_CONTRACT, 500000));
            assert.strictEqual(deploy.contract.status, 'valid', 'origin deploy status: ' + deploy.contract.status);
            originContract = deploy.contract.action_index;
            console.log('    [relay-loop] origin contract ' + originContract);

            const exec = await resilientSend('origin execute', originRail, () =>
                vmHelper.sendExecuteV0(originOperator, originContract, 'askAcrossChains', [ATTEST_URL]));
            assert.strictEqual(exec.execution.status, 'valid', 'origin execute status: ' + exec.execution.status);

            originRequest = await global.indexerDatabase.waitForAttestationRequest(
                { txHash: exec.txHash, requestStatus: 'pending' }, 120000);
            assert(originRequest, 'the origin ATTEST v0 should be admitted pending (ATTEST_RELAY_ORIGIN)');
            originRequestId = String(originRequest.request_id).toLowerCase();

            // The stamp is the whole origin-side feature: without it the request is
            // invisible to the relay, and before the gate it would not exist at all.
            assert.strictEqual(String(originRequest.origin_chain), originRail.code,
                'the admitted request must be stamped with its origin chain');
            assert.strictEqual(Number(originRequest.redundancy), REDUNDANCY);
            assert.strictEqual(String(originRequest.payload), ATTEST_URL);
            console.log('    [relay-loop] origin request ' + originRequestId.slice(0, 16) + '... action_index=' +
                        originRequest.action_index + ' block=' + originRequest.block_index);
        });
    });

    it('HOME: stakes the request\'s responsible attestation keys and the cross_chain majority', async function () {
        await chainRail.withRail(homeRail, async () => {
            // The set the responsible-set rule will rank our keys against.
            const tip = (await indexerRpc(homeRail, 'getlatestblock', {})).block_index;
            const existing = (await capabilityWeights(homeRail, 'attestation', tip))
                .map(v => String(v.pubkey).toLowerCase());
            console.log('    [relay-loop] existing attestation keys on ' + homeRail.code + ': ' + existing.length);

            responsibleValidators = grindResponsibleKeys(originRequestId, REDUNDANCY, existing);

            for (let i = 0; i < responsibleValidators.length; i++) {
                const v = responsibleValidators[i];
                const src = attestStakeSources[i];
                await stakeKeyFrom(homeRail, src, ATTESTATION_MIN_STAKE, v.pubkey, 'attestation stake ' + i);
                v.source = src.address;
                console.log('    [relay-loop] attestation key ' + v.pubkey.slice(0, 16) + '... staked from ' + src.address);
            }

            // From here until the unstake two steps below, the drill holds the
            // cross_chain stake majority on this chain. Keep that window short.
            await stakeKeyFrom(homeRail, relayStakeSource, Number(relayStakeAmount).toFixed(8),
                relaySigner.pubkey, 'cross_chain stake');
            relaySigner.source = relayStakeSource.address;

            // Stakes qualify only after ACTIVATION_DELAY_BLOCKS, and the snapshot the
            // v3 names has to be a block the indexer has actually committed.
            await global.regtestMinerConnector.generateBlocks(ACTIVATION_DELAY_BLOCKS + 1);
            const minedTo = await global.nodeConnector.getBlockCount();
            snapshotBlock = await waitForIndexedHeight(homeRail, minedTo);

            const armed = await capabilityWeights(homeRail, 'cross_chain', snapshotBlock);
            const mine = armed.filter(v => String(v.pubkey).toLowerCase() === relaySigner.pubkey);
            assert(mine.length === 1, 'the drill cross_chain key should qualify at the snapshot block');
            const total = new Map();
            for (const v of armed) total.set(String(v.source), Number(v.weight));
            const S = Array.from(total.values()).reduce((a, b) => a + b, 0);
            assert(3 * Number(mine[0].weight) > 2 * S,
                'drill stake must be a >2/3 weighted majority (have ' + mine[0].weight + ' of ' + S + ')');
            console.log('    [relay-loop] snapshot_block=' + snapshotBlock + ' drill weight=' + mine[0].weight + '/' + S);
        });
    });

    it('HOME: ATTEST v3 materializes the origin request onto BTC with a real BTC block_index', async function () {
        await chainRail.withRail(homeRail, async () => {
            assert(Number.isInteger(snapshotBlock) && snapshotBlock > 0,
                'snapshot_block was never resolved; the staking step did not complete');
            const row = {
                request_id:          originRequestId,
                snapshot_block:      snapshotBlock,
                network:             homeRail.network,
                origin_chain:        originRail.code,
                origin_action_index: Number(originRequest.action_index),
                provider_id:         'http_get',
                request_payload:     ATTEST_URL,
                redundancy:          REDUNDANCY,
                deadline_blocks:     DEADLINE_BLOCKS,
            };
            const canonical = codec.requestCanonical(row);
            const wire = codec.requestWire(row, [{ pubkey: relaySigner.pubkey, sig: relaySigner.sign(canonical) }]);

            // Several signatures + a URL payload exceed the 80-byte OP_RETURN, which
            // is why the hub's own broadcaster forces P2SH too.
            await resilientSend('ATTEST v3 broadcast', homeRail, () =>
                transactionHelper.createAndSendTransaction(homeOperator, wire, null, [], 'P2SH'));

            const materialized = await pumpUntil('the v3-materialized BTC request row', homeRail, async () => {
                const rows = await railQuery(homeRail,
                    'SELECT action_index, request_status, origin_chain, origin_action_index, block_index, ' +
                    'responsible_set_json, redundancy, provider_id, payload FROM attests ' +
                    'WHERE request_id = ? AND version = 0 LIMIT 1', [originRequestId]);
                return rows.length ? rows[0] : null;
            });

            assert.strictEqual(String(materialized.request_status), 'pending',
                'the materialized request should be pending on the home chain');
            assert.strictEqual(String(materialized.origin_chain), originRail.code);
            assert.strictEqual(Number(materialized.origin_action_index), Number(originRequest.action_index));
            assert.strictEqual(String(materialized.payload), ATTEST_URL);
            assert(Number(materialized.block_index) > 0, 'the materialized row carries a real BTC block_index');
            console.log('    [relay-loop] materialized on ' + homeRail.code + ' at block ' + materialized.block_index +
                        ' (origin ' + materialized.origin_chain + ':' + materialized.origin_action_index + ')');

            // The responsible set is pinned AS-OF the v3's own BTC block. Sign with
            // exactly those keys, and fail loudly if the grind did not win the slots
            // (otherwise the v1 below would fail as "insufficient signatures" and the
            // real cause would be invisible).
            const pinned = materialized.responsible_set_json ? JSON.parse(materialized.responsible_set_json) : null;
            assert(Array.isArray(pinned) && pinned.length === REDUNDANCY,
                'the materialized row should pin a responsible set of ' + REDUNDANCY + ' keys, got ' +
                JSON.stringify(pinned));
            const pinnedSet = new Set(pinned.map(p => String(p).toLowerCase()));
            for (const v of responsibleValidators)
                assert(pinnedSet.has(v.pubkey), 'drill key ' + v.pubkey.slice(0, 16) + '... missing from the pinned responsible set');
        });
    });

    it('HOME: the drill\'s cross_chain stake is unwound now that the v3 has pinned its snapshot', async function () {
        await unwindRelayStake('post-v3');
        // The pinned snapshot is historical, so unwinding cannot invalidate the v3
        // that already landed; the venue's live federation is a majority again.
        assert(relayStakeUnwound);
    });

    it('HOME: a real http_get fetch is signed by the pinned set and fulfills the request as an ordinary v1', async function () {
        const http_get = require(_path.join(HUB_BASE, 'src/providers/http_get.js'));
        const fetched = await http_get.fetch(ATTEST_URL, { maxResponseBytes: 32768, timeoutMs: 15000 });
        realBody = fetched.body.toString('utf8');
        realMeta = String(fetched.meta);
        assert.strictEqual(realMeta, '200', 'expected HTTP 200 from ' + ATTEST_URL);
        console.log('    [relay-loop] fetched ' + Buffer.byteLength(realBody, 'utf8') + ' bytes from ' + ATTEST_URL);

        await chainRail.withRail(homeRail, async () => {
            await resilientSend('ATTEST v1 broadcast', homeRail, () =>
                attestationHelper.broadcastAttestationResponse(homeOperator, {
                    requestId:       originRequestId,
                    providerId:      'http_get',
                    responsePayload: realBody,
                    status:          'ok',
                    meta:            realMeta,
                    validators:      responsibleValidators,
                }));

            const response = await pumpUntil('the home-chain ATTEST v1 response row', homeRail, async () => {
                const rows = await railQuery(homeRail,
                    'SELECT at.action_index, at.response_status, at.callback_execute_action_index, s.status ' +
                    'FROM attests at JOIN actions ac ON ac.action_index = at.action_index ' +
                    'LEFT JOIN index_statuses s ON s.id = at.status_id ' +
                    'WHERE at.request_id = ? AND ac.action_format = 1 ORDER BY at.action_index DESC LIMIT 1',
                    [originRequestId]);
                return rows.length ? rows[0] : null;
            });
            assert.strictEqual(String(response.status), 'valid', 'the v1 should index valid');
            assert.strictEqual(String(response.response_status), 'ok');
            homeResponseActionIndex = Number(response.action_index);

            const request = await pumpUntil('the materialized request to flip terminal', homeRail, async () => {
                const rows = await railQuery(homeRail,
                    'SELECT request_status FROM attests WHERE request_id = ? AND version = 0 LIMIT 1', [originRequestId]);
                return (rows.length && rows[0].request_status !== 'pending') ? rows[0] : null;
            }, 120000);
            assert.strictEqual(String(request.request_status), 'fulfilled',
                'the materialized request should flip fulfilled on the home chain');

            // The contract is not on this chain: a home-chain callback here would run
            // against a contract index that means something else entirely.
            assert(!response.callback_execute_action_index,
                'a foreign-origin request must fire NO callback on the home chain');
            console.log('    [relay-loop] home response action_index=' + homeResponseActionIndex + ', no local callback (correct)');
        });
    });

    it('ORIGIN: ATTEST v4 relays the response back, settles the request and injects the callback', async function () {
        const responseBytes = Buffer.from(realBody, 'utf8');
        const responseHash = crypto.createHash('sha256').update(responseBytes).digest('hex');
        const row = {
            request_id:                 originRequestId,
            snapshot_block:             snapshotBlock,
            network:                    originRail.network,
            origin_chain:               originRail.code,
            home_response_action_index: homeResponseActionIndex,
            provider_id:                'http_get',
            response_hash:              responseHash,
            status:                     'ok',
            meta:                       realMeta,
            response_payload_b64:       responseBytes.toString('base64'),
        };
        const canonical = codec.responseCanonical(row);
        const wire = codec.responseWire(row, [{ pubkey: relaySigner.pubkey, sig: relaySigner.sign(canonical) }]);

        await chainRail.withRail(originRail, async () => {
            // Stand in for the hub's capability mirror: the origin chain verifies
            // cross_chain against hub-mirrored capability_snapshots (capability
            // staking is BTC-only), so seed exactly the rows the mirror would carry
            // for the one snapshot_block this v4 names.
            await railQuery(originRail,
                'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) ' +
                'VALUES (?, ?, ?, ?, ?)',
                [snapshotBlock, 'cross_chain', relaySigner.pubkey, String(relayStakeAmount) + '.00000000', relayStakeSource.address]);
            const seeded = await railQuery(originRail,
                'SELECT signing_pubkey FROM capability_snapshots WHERE capability = ? AND snapshot_block = ?',
                ['cross_chain', snapshotBlock]);
            assert(seeded.length >= 1, 'the origin chain needs a cross_chain snapshot at ' + snapshotBlock);

            await resilientSend('ATTEST v4 broadcast', originRail, () =>
                transactionHelper.createAndSendTransaction(originOperator, wire, null, [], 'P2SH'));

            // The v4's row is stored as attests.version = 1, NOT 4: `attests` is a
            // lifecycle table and every response consumer filters on version 1, so
            // the relay leg reuses that shape (the mirror of the v3 request landing
            // as version 0). The on-chain provenance lives in actions.action_format,
            // which is what this joins on - a query keyed on version = 4 finds
            // nothing even when the relay worked perfectly.
            const relayed = await pumpUntil('the origin ATTEST v4 row', originRail, async () => {
                const rows = await railQuery(originRail,
                    'SELECT at.action_index, at.response_status, at.callback_execute_action_index, at.meta, s.status ' +
                    'FROM attests at JOIN actions ac ON ac.action_index = at.action_index ' +
                    'LEFT JOIN index_statuses s ON s.id = at.status_id ' +
                    'WHERE at.request_id = ? AND ac.action_format = 4 ORDER BY at.action_index DESC LIMIT 1',
                    [originRequestId]);
                return rows.length ? rows[0] : null;
            });
            assert.strictEqual(String(relayed.status), 'valid',
                'the v4 should index valid (status was: ' + relayed.status + ')');
            assert.strictEqual(String(relayed.response_status), 'ok');

            const request = await pumpUntil('the origin request to flip terminal', originRail, async () => {
                const rows = await railQuery(originRail,
                    'SELECT request_status, resolved_block FROM attests WHERE request_id = ? AND version = 0 LIMIT 1',
                    [originRequestId]);
                return (rows.length && rows[0].request_status !== 'pending') ? rows[0] : null;
            }, 120000);
            assert.strictEqual(String(request.request_status), 'fulfilled',
                'the origin request should be fulfilled by the relayed response');

            assert(relayed.callback_execute_action_index,
                'the callback EXECUTE must be injected on the chain the contract lives on');

            // The loop is only closed when the CONTRACT sees the data: same shape a
            // local fulfillment would have delivered, byte-for-byte the fetched body.
            const cbStatus  = await global.indexerDatabase.getContractState(originContract, 'callback_status');
            const cbPayload = await global.indexerDatabase.getContractState(originContract, 'callback_payload');
            const cbContext = await global.indexerDatabase.getContractState(originContract, 'callback_context');
            const cbRequest = await global.indexerDatabase.getContractState(originContract, 'callback_request_id');
            assert(cbStatus && cbPayload, 'the contract should have recorded the callback');
            assert.strictEqual(JSON.parse(cbStatus.state_value), 'ok');
            assert.strictEqual(JSON.parse(cbPayload.state_value), realBody);
            assert.strictEqual(JSON.parse(cbContext.state_value), 'ctx-xc974');
            assert.strictEqual(String(JSON.parse(cbRequest.state_value)).toLowerCase(), originRequestId);
            console.log('    [relay-loop] LOOP CLOSED: ' + originRail.code + ' contract ' + originContract +
                        ' holds the body attested by ' + homeRail.code + ' validators');
        });
    });
});
