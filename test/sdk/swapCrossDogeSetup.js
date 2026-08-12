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
 * Cross-coin SWAP e2e: DOGE-side maker setup driver (standalone, not a
 * mocha suite). Companion to swapCrossSettleLive.sdk.test.js.
 *
 * The SWAP twin of dexDogeSetup.js. Where that driver places the DOGE leg of
 * a crossing cross-chain ORDER pair (Phase B, price-time book), this one
 * places the DOGE leg of a crossing cross-chain SWAP pair: the hub's
 * CrossChainDexEngine matches SWAP<->SWAP as an exact full-amount fill
 * (Phase A, FCFS), so both legs commit their whole give amount in one match.
 *
 * On a DOGE regtest stack it:
 *   - seeds the oracle prices the DOGE native-coin fee path reads (hub DB),
 *   - funds a maker,
 *   - ISSUEs the DOGE-side token, paying the issuance fee as a native DOGE output
 *     to FEE_DESTINATION (DOGE/LTC force native-coin fees: no XCHAIN-fee fallback),
 *   - places a cross-chain SWAP v0: give DOGE/<SWAP_DOGE_TICK> 100, get
 *     BTC/<SWAP_BTC_TICK> 100 (exact-match Phase A wants the amounts to mirror the
 *     BTC leg's exactly; <=90-day expiration so the SWAP itself carries no fee),
 *   - verifies the offer is open in the unified cross-chain book as kind='swap',
 *   - prints DOGE_SWAP_INDEX, DOGE_MAKER and DOGE_MAKER_BTC_RECV.
 *
 * The ticks are passed in via env (SWAP_DOGE_TICK / SWAP_BTC_TICK) so they match
 * the BTC drill's expectation: the BTC SWAP's get_tick must equal this offer's
 * give_tick and vice-versa, or the engine will not cross them.
 *
 * The shared explorer does not serve DOGE regtest, so this driver submits with
 * waitForIndexer:false and resolves indexing state straight from the DOGE
 * indexer DB (same approach as dexDogeSetup.js / xcallDogeSetup.js).
 *
 * Env (defaults match the local regtest stack):
 *   SWAP_DOGE_TICK, SWAP_BTC_TICK  (the crossing tick pair, REQUIRED)
 *   XCALL_DOGE_ENCODER_PORT=3123   XCALL_DOGE_MINER_URL=http://localhost:3125
 *   XCALL_DOGE_INDEXER_URL=http://127.0.0.1:3124
 *   XCALL_DB_HOST=127.0.0.1        XCALL_DB_PORT=13306
 *   HUB_DB_HOST/PORT/NAME/USER/PASS  (hub DB for price seeding; defaults to
 *                                     XCALL_DB_* + XChain_Hub, point at the relay
 *                                     hub DB in the distributed venue)
 *   DOGE_IDX_DB_USER/DOGE_IDX_DB_PASS (XChain_DOGE_Regtest_Indexer, reads)
 *   SWAP_DOGE_FEE_DESTINATION        (native fee output address; defaults to the
 *                                     DOGE regtest FEE_DESTINATION)
 *
 * Usage: node test/sdk/swapCrossDogeSetup.js
 *
 ********************************************************************/

const axios   = require('axios');
const mariadb = require('mariadb');
const { XChainSDK } = require('./sdkHelper');
const { BOOTSTRAP_XCHAIN_USD, BOOTSTRAP_XCHAIN_USD_NUM, refuseSeedIfSuppressed } = require('../helpers/xchainPriceConstants');

const MINER_URL   = process.env.XCALL_DOGE_MINER_URL   || 'http://localhost:3125';
const INDEXER_URL = process.env.XCALL_DOGE_INDEXER_URL || 'http://127.0.0.1:3124';
const DB_HOST     = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT     = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

// DOGE regtest runs the native-coin fee path (FEE_DESTINATION configured), so the
// ISSUE protocol fee is paid as a native DOGE output and the fee oracle prices must
// be seeded into the indexer's hub DB (the relay hub in the distributed venue).
const HUB_DB_HOST = process.env.HUB_DB_HOST || DB_HOST;
const HUB_DB_PORT = parseInt(process.env.HUB_DB_PORT || String(DB_PORT), 10);
const HUB_DB_NAME = process.env.HUB_DB_NAME || 'XChain_Hub';
const FEE_DESTINATION = process.env.SWAP_DOGE_FEE_DESTINATION || 'moArBUdgbkU3THWXnnPSBwfaPgL5c9tMqN';
// Seeded oracle prices and the UNIFIED_FEES ISSUE gas (GAS_SCHEDULE.ISSUE x GAS_PRICE),
// identical to dexDogeSetup so the two drivers value the same fee the same way.
const DOGE_USD = 0.10, XCHAIN_USD = BOOTSTRAP_XCHAIN_USD_NUM;
const DOGE_USD_SEED = '0.10000000';
const ISSUE_FEE_XCHAIN = 100000 * 0.00001; // 1.0 XCHAIN

// The exact-match amount both legs use. Phase A crosses SWAP<->SWAP only when each
// side's give_amount equals the other's get_amount, so keep this in lockstep with
// swapCrossSettleLive.sdk.test.js's SWAP_AMOUNT.
const SWAP_AMOUNT = 100;

const DOGE_TICK = String(process.env.SWAP_DOGE_TICK || '').trim();
const BTC_TICK  = String(process.env.SWAP_BTC_TICK  || '').trim();

async function minerRpc(method, params) {
    const res = await axios.post(MINER_URL, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 20000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    return res.data ? res.data.result : null;
}

async function withConn(database, user, password, fn) {
    const conn = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, database, user, password });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
async function dogeIdx(fn) {
    return withConn('XChain_DOGE_Regtest_Indexer', process.env.DOGE_IDX_DB_USER, process.env.DOGE_IDX_DB_PASS, fn);
}
// The fee oracle prices live in the indexer's hub DB (the relay hub when distributed);
// seed there so the native-coin fee validation can value the ISSUE fee.
async function hubConn(fn) {
    const conn = await mariadb.createConnection({ host: HUB_DB_HOST, port: HUB_DB_PORT, database: HUB_DB_NAME, user: process.env.HUB_DB_USER, password: process.env.HUB_DB_PASS });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
// The unified cross-chain book (swaps + orders, each tagged `kind`).
async function getOpenCrossChainOffers() {
    const res = await axios.post(INDEXER_URL + '/api',
        { jsonrpc: '2.0', method: 'getopencrosschainorders', params: {}, id: 1 }, { timeout: 8000 });
    return (res.data && res.data.result && res.data.result.orders) || [];
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    if (!/^[A-Z0-9]{1,12}$/.test(DOGE_TICK) || !/^[A-Z0-9]{1,12}$/.test(BTC_TICK))
        throw new Error('SWAP_DOGE_TICK and SWAP_BTC_TICK must be set to uppercase-alnum tickers');

    // Resolve the DOGE chain clock: the SWAP expiration is anchored to it (block_time
    // + 90 days = the free tier), not wall-clock, so it stays in the free band
    // regardless of regtest clock skew.
    const blockTime = await dogeIdx(async (c) => {
        const rows = await c.query('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1');
        return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000);
    });

    // Seed the prices the DOGE native-fee path reads. Anchor to the NEWER of the chain
    // clock and wall-clock: freshness is judged against the block_time of the block the
    // ISSUE lands in, and on a chain that sat idle the old tip time is stale beyond the
    // 1800s gate while the newly mined block gets wall-clock time.
    const seedTime = Math.max(blockTime, Math.floor(Date.now() / 1000));
    refuseSeedIfSuppressed('swapCrossDogeSetup');
    await hubConn(async (c) => {
        for (const [pair, price, round] of [['DOGE/USD', DOGE_USD_SEED, 990001], ['XCHAIN/USD', BOOTSTRAP_XCHAIN_USD, 990002]]) {
            await c.query(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized')
                 ON DUPLICATE KEY UPDATE price = VALUES(price), block_timestamp = VALUES(block_timestamp), status = 'finalized'`,
                [round, pair, price, seedTime]);
        }
    });
    console.log('[swap-doge-setup] prices seeded (DOGE/USD, XCHAIN/USD) at time ' + seedTime);

    const sdk = new XChainSDK({
        network:     'dogecoin-regtest',
        encoderUrl:  'localhost',
        encoderPort: parseInt(process.env.XCALL_DOGE_ENCODER_PORT || '3123', 10),
        timeout:     30000,
        retry:       { maxRetries: 2 },
    });
    const kp = sdk.generateKeyPair();
    const maker = { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
    const fundRes  = await minerRpc('send_funds', { address: maker.address, amount: 100 });
    const fundTxid = typeof fundRes === 'string' ? fundRes : (fundRes && fundRes.txid) || null;
    await minerRpc('generate_blocks', { count: 2 });
    // Wait on the funding tx being INDEXED rather than on a fixed settle: the
    // first submitAction below builds from these UTXOs, so the condition that
    // matters is the indexer having seen them, not that 3s elapsed. Keeps
    // mining while it waits, because an idle DOGE regtest chain will not
    // advance on its own. A miner that returned no txid falls back to the
    // block count, which is the same guarantee the fixed sleep gave.
    for (let i = 0; i < 30; i++) {
        if (!fundTxid) { await sleep(3000); break; }
        const rows = await dogeIdx((c) => c.query(
            'SELECT 1 AS ok FROM index_transactions WHERE hash = ? LIMIT 1', [fundTxid]));
        if (rows.length) break;
        if (i === 29) throw new Error('[swap-doge-setup] funding tx ' + fundTxid + ' never indexed');
        await minerRpc('generate_blocks', { count: 1 });
        await sleep(1000);
    }
    console.log('[swap-doge-setup] maker=' + maker.address);

    // A valid BTC regtest address for the cross-chain SWAP's GET_ADDRESS (where this
    // maker receives the BTC-side token on settlement). swap.js only checks that it is
    // format-valid for GET_COIN; it does not validate ownership.
    const btcSdk  = new XChainSDK({ network: 'bitcoin-regtest', timeout: 30000 });
    const btcKp   = btcSdk.generateKeyPair();
    const btcRecv = btcSdk.deriveAddress(btcKp.publicKey, { type: 'p2pkh' });

    // Submit without the explorer waiter (no DOGE explorer), mine, and resolve the
    // indexed action row by tx hash via the indexer DB. Mirrors dexDogeSetup.
    async function submitAndIndex(label, actionData, encoderOpts) {
        const res = await sdk.submitAction(actionData,
            Object.assign({ pubkey: maker.address, change: maker.address, unconfirmed: false }, encoderOpts),
            { wif: maker.wif, waitForIndexer: false });
        const txid = res.txid || (res.signed && res.signed.txid);
        if (!txid) throw new Error(label + ': no txid in submit result: ' + JSON.stringify(Object.keys(res)));
        for (let i = 0; i < 30; i++) {
            await minerRpc('generate_blocks', { count: 1 });
            await sleep(2000);
            const rows = await dogeIdx((c) => c.query(
                `SELECT a.action_index FROM actions a
                 JOIN transactions t ON t.tx_index = a.tx_index
                 JOIN index_transactions ih ON ih.id = t.tx_hash_id
                 WHERE ih.hash = ? ORDER BY a.action_index ASC LIMIT 1`, [txid]));
            if (rows.length) {
                console.log('[swap-doge-setup] ' + label + ': indexed as action ' + rows[0].action_index);
                return Number(rows[0].action_index);
            }
        }
        throw new Error(label + ': tx ' + txid + ' never indexed');
    }

    // ISSUE the DOGE-side token. DOGE forces native-coin fees (no XCHAIN-fee fallback),
    // so pay the issuance fee as a native DOGE output to FEE_DESTINATION, sized from the
    // UNIFIED_FEES gas schedule valued at the seeded prices (mid-band of 0.95-1.10).
    const issueFeeNative = ISSUE_FEE_XCHAIN * (XCHAIN_USD / DOGE_USD); // DOGE
    const issueFeeSats = Math.round(issueFeeNative * 1e8);
    console.log('[swap-doge-setup] ISSUE native fee: ' + issueFeeNative + ' DOGE (' + issueFeeSats + ' sats) -> ' + FEE_DESTINATION);
    await submitAndIndex('ISSUE ' + DOGE_TICK,
        { action: 'ISSUE', params: { tick: DOGE_TICK, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'swap-cross-settle', mintSupply: 1000 } },
        { customOutputs: [{ address: FEE_DESTINATION, value: issueFeeSats }] });

    // Place the cross-chain SWAP v0. Expiration anchored to the DOGE chain clock + 90
    // days = exactly the free tier (chargeableDays = 0), so the SWAP carries no protocol
    // fee and needs no native output.
    const expiration = blockTime + 90 * 86400;
    const swapIndex = await submitAndIndex('SWAP',
        {
            action: 'SWAP',
            params: {
                version:  0,
                giveCoin: 'DOGE', giveTick: DOGE_TICK, giveAmount: SWAP_AMOUNT,
                getCoin:  'BTC',  getTick:  BTC_TICK,  getAmount:  SWAP_AMOUNT,
                getAddress: btcRecv, expiration, memo: 'cross-coin swap doge leg',
            },
        }, {});

    // Verify the offer is OPEN as a CROSS-CHAIN swap. getopencrosschainorders is the
    // authoritative signal (cross-chain offers escrow locally but match at the hub, not
    // in the local SWAP_MATCH path); its presence confirms the ISSUE escrowed the give
    // side AND that CROSS_CHAIN_DEX is enabled so the hub will match it.
    let openOffer = null;
    for (let i = 0; i < 20; i++) {
        try {
            const offers = await getOpenCrossChainOffers();
            openOffer = offers.find(o => Number(o.action_index) === swapIndex) || null;
            if (openOffer) break;
        } catch (e) { /* indexer momentarily busy; retry */ }
        await sleep(2000);
    }
    if (!openOffer)
        throw new Error('DOGE SWAP ' + swapIndex + ' not open as a cross-chain offer: ISSUE/escrow or CROSS_CHAIN_DEX gating likely failed');
    if (openOffer.kind !== 'swap')
        throw new Error('DOGE SWAP ' + swapIndex + ' surfaced as kind=' + openOffer.kind + ', expected swap');
    if (openOffer.give_tick !== DOGE_TICK || openOffer.get_tick !== BTC_TICK)
        throw new Error('DOGE SWAP ' + swapIndex + ' tick mismatch: give=' + openOffer.give_tick + ' get=' + openOffer.get_tick);

    console.log('[swap-doge-setup] DOGE_SWAP_INDEX=' + swapIndex);
    console.log('[swap-doge-setup] DOGE_MAKER=' + maker.address);
    // The BTC payout address this offer names as its get_address: the BTC leg releases
    // its escrowed token here on settlement. Consumed as SWAP_DOGE_MAKER_BTC_RECV by
    // swapCrossSettleLive.sdk.test.js.
    console.log('[swap-doge-setup] DOGE_MAKER_BTC_RECV=' + btcRecv);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[swap-doge-setup] FAILED:', e.message); process.exit(1); });
