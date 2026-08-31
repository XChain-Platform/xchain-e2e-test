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
 * Cross-chain DEX e2e: DOGE-side maker setup driver (standalone, not a
 * mocha suite). Companion to dexSourceReorgDrill.sdk.test.js.
 *
 * Stands up the DOGE leg of a crossing cross-chain ORDER pair so the hub's
 * CrossChainDexEngine can finalize a `cross_chain_matches` row against the
 * BTC leg the drill places. On a DOGE regtest stack it:
 *   - seeds the oracle prices the DOGE native-coin fee path reads (hub DB),
 *   - funds a maker,
 *   - ISSUEs the DOGE-side token, paying the issuance fee as a native DOGE output
 *     to FEE_DESTINATION (DOGE/LTC force native-coin fees: no XCHAIN-fee fallback),
 *   - places a cross-chain ORDER: give DOGE/<DEX_DOGE_TICK> 100, get
 *     BTC/<DEX_BTC_TICK> 100 (1:1 so the price gate always crosses; ≤90-day
 *     expiration so the ORDER itself carries no protocol fee),
 *   - verifies the order is 'open', and prints DOGE_ORDER_INDEX + DOGE_MAKER.
 *
 * The ticks are passed in via env (DEX_DOGE_TICK / DEX_BTC_TICK) so they match
 * the BTC drill's expectation (the BTC ORDER's get_tick must equal this
 * order's give_tick and vice-versa, or the engine won't cross them.
 *
 * The shared explorer does not serve DOGE regtest, so this driver submits with
 * waitForIndexer:false and resolves indexing state straight from the DOGE
 * indexer DB (same approach as xcallDogeSetup.js).
 *
 * Env (defaults match the local regtest stack):
 *   DEX_DOGE_TICK, DEX_BTC_TICK    (the crossing tick pair, REQUIRED)
 *   XCALL_DOGE_ENCODER_PORT=3123   XCALL_DOGE_MINER_URL=http://localhost:3125
 *   XCALL_DB_HOST=127.0.0.1        XCALL_DB_PORT=13306
 *   HUB_DB_HOST/PORT/NAME/USER/PASS  (hub DB for price seeding; defaults to
 *                                     XCALL_DB_* + XChain_Hub, point at the relay
 *                                     hub DB in the distributed venue)
 *   DOGE_IDX_DB_USER/DOGE_IDX_DB_PASS (XChain_DOGE_Regtest_Indexer, reads)
 *   DEX_DOGE_FEE_DESTINATION         (native fee output address; defaults to the
 *                                     DOGE regtest FEE_DESTINATION)
 *
 * Usage: node test/sdk/dexDogeSetup.js
 *
 ********************************************************************/

const axios   = require('axios');
const mariadb = require('mariadb');
const { XChainSDK } = require('./sdkHelper');
const { BOOTSTRAP_XCHAIN_USD, BOOTSTRAP_XCHAIN_USD_NUM, refuseSeedIfSuppressed } = require('../helpers/xchainPriceConstants');

const MINER_URL = process.env.XCALL_DOGE_MINER_URL || 'http://localhost:3125';
const INDEXER_URL = process.env.XCALL_DOGE_INDEXER_URL || 'http://127.0.0.1:3124';
const DB_HOST   = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT   = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

// DOGE regtest runs the native-coin fee path (FEE_DESTINATION configured), so the
// ISSUE protocol fee is paid as a native DOGE output and the fee oracle prices must
// be seeded into the indexer's hub DB (the relay hub in the distributed venue).
const HUB_DB_HOST = process.env.HUB_DB_HOST || DB_HOST;
const HUB_DB_PORT = parseInt(process.env.HUB_DB_PORT || String(DB_PORT), 10);
const HUB_DB_NAME = process.env.HUB_DB_NAME || 'XChain_Hub';
// Must track xchain-indexer/src/coins/DOGE.js regtest addresses.FEE_DESTINATION.
// A stale value here pays a real DOGE output nobody credits, and the ISSUE dies as
// 'insufficient fee (native coin output required)' with no mention of the address.
const FEE_DESTINATION = process.env.DEX_DOGE_FEE_DESTINATION || 'mfees5pa2HwNBonk5vG23aDWkN9fuDJib4';
// Seeded oracle prices and the UNIFIED_FEES ISSUE gas (GAS_SCHEDULE.ISSUE x GAS_PRICE).
// XCHAIN at the production bootstrap: the pair is derived from
// platform fills and, with D2 supersession disabled, a real hub publishes exactly
// this every round. DOGE is a venue fiction chosen for round arithmetic.
const DOGE_USD = 0.10, XCHAIN_USD = BOOTSTRAP_XCHAIN_USD_NUM;
const DOGE_USD_SEED = '0.10000000';
const ISSUE_FEE_XCHAIN = 100000 * 0.00001; // 1.0 XCHAIN

const DOGE_TICK = String(process.env.DEX_DOGE_TICK || '').trim();
const BTC_TICK  = String(process.env.DEX_BTC_TICK || '').trim();

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
async function getOpenCrossChainOrders() {
    const res = await axios.post(INDEXER_URL + '/api',
        { jsonrpc: '2.0', method: 'getopencrosschainorders', params: {}, id: 1 }, { timeout: 8000 });
    return (res.data && res.data.result && res.data.result.orders) || [];
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    if (!/^[A-Z0-9]{1,12}$/.test(DOGE_TICK) || !/^[A-Z0-9]{1,12}$/.test(BTC_TICK))
        throw new Error('DEX_DOGE_TICK and DEX_BTC_TICK must be set to uppercase-alnum tickers');

    // ── 1. Resolve the DOGE chain clock (the ORDER expiration is anchored to it)
    //       (block_time + 90 days = the free tier), not wall-clock, so it stays in
    //       the free band regardless of regtest clock skew.
    const blockTime = await dogeIdx(async (c) => {
        const rows = await c.query('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1');
        return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000);
    });

    // Seed the prices the DOGE native-fee path reads (hub DB), anchored to the CHAIN
    // clock. Freshness is judged against the block_time of the block the ISSUE lands in,
    // and a regtest node whose clock is frozen mints blocks far behind wall-clock, so a
    // wall-clock anchor lands in the future and the time-keyed selection skips it.
    const seedTime = blockTime;
    refuseSeedIfSuppressed('dexDogeSetup');
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
    console.log('[dex-doge-setup] prices seeded (DOGE/USD, XCHAIN/USD) at time ' + seedTime);

    const sdk = new XChainSDK({
        network:     'dogecoin-regtest',
        encoderUrl:  'localhost',
        encoderPort: parseInt(process.env.XCALL_DOGE_ENCODER_PORT || '3123', 10),
        timeout:     30000,
        retry:       { maxRetries: 2 },
    });
    const kp = sdk.generateKeyPair();
    const maker = { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
    await minerRpc('send_funds', { address: maker.address, amount: 100 });
    await minerRpc('generate_blocks', { count: 2 });
    await sleep(3000);
    console.log('[dex-doge-setup] maker=' + maker.address);

    // A valid BTC regtest address for the cross-chain ORDER's GET_ADDRESS (where
    // the maker would receive the BTC-side token on settlement). The engine does
    // not validate ownership of it; it only needs to be format-valid for BTC.
    const btcSdk  = new XChainSDK({ network: 'bitcoin-regtest', timeout: 30000 });
    const btcKp   = btcSdk.generateKeyPair();
    const btcRecv = btcSdk.deriveAddress(btcKp.publicKey, { type: 'p2pkh' });

    // Submit without the explorer waiter (no DOGE explorer), mine, and resolve
    // the indexed action row by tx hash via the indexer DB. Mirrors xcallDogeSetup.
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
                console.log('[dex-doge-setup] ' + label + ': indexed as action ' + rows[0].action_index);
                return Number(rows[0].action_index);
            }
        }
        throw new Error(label + ': tx ' + txid + ' never indexed');
    }

    // ── 3. ISSUE the DOGE-side token. DOGE forces native-coin fees (no XCHAIN-fee
    //       fallback), so pay the issuance fee as a native DOGE output to
    //       FEE_DESTINATION, sized from the UNIFIED_FEES gas schedule valued at the
    //       seeded prices (mid-band of the 0.95-1.10 tolerance).
    const issueFeeNative = ISSUE_FEE_XCHAIN * (XCHAIN_USD / DOGE_USD); // DOGE
    const issueFeeSats = Math.round(issueFeeNative * 1e8);
    console.log('[dex-doge-setup] ISSUE native fee: ' + issueFeeNative + ' DOGE (' + issueFeeSats + ' sats) -> ' + FEE_DESTINATION);
    await submitAndIndex('ISSUE ' + DOGE_TICK,
        { action: 'ISSUE', params: { tick: DOGE_TICK, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'dex-settle', mintSupply: 1000 } },
        { customOutputs: [{ address: FEE_DESTINATION, value: issueFeeSats }] });

    // ── 4. Place the cross-chain ORDER. Expiration anchored to the DOGE chain
    //       clock + 90 days = exactly the free tier (chargeableDays = 0), so the
    //       ORDER carries no protocol fee and needs no native output.
    const expiration = blockTime + 90 * 86400;
    const orderIndex = await submitAndIndex('ORDER',
        {
            action: 'ORDER',
            params: {
                giveCoin: 'DOGE', giveTick: DOGE_TICK, giveAmount: 100,
                getCoin:  'BTC',  getTick:  BTC_TICK,  getAmount:  100,
                getAddress: btcRecv, expiration,
            },
        }, {});

    // Verify the order is OPEN as a CROSS-CHAIN order. getopencrosschainorders is the
    // authoritative signal (cross-chain orders are escrowed but matched by the hub, not
    // locally); its presence confirms the ISSUE escrowed the give side AND that the
    // CROSS_CHAIN_DEX protocol change is enabled so the hub will match it.
    let openOrder = null;
    for (let i = 0; i < 20; i++) {
        try {
            const orders = await getOpenCrossChainOrders();
            openOrder = orders.find(o => Number(o.action_index) === orderIndex) || null;
            if (openOrder) break;
        } catch (e) { /* indexer momentarily busy; retry */ }
        await sleep(2000);
    }
    if (!openOrder)
        throw new Error('DOGE ORDER ' + orderIndex + ' not open as a cross-chain order: ISSUE/escrow or CROSS_CHAIN_DEX gating likely failed');
    if (openOrder.give_tick !== DOGE_TICK || openOrder.get_tick !== BTC_TICK)
        throw new Error('DOGE ORDER ' + orderIndex + ' tick mismatch: give=' + openOrder.give_tick + ' get=' + openOrder.get_tick);

    console.log('[dex-doge-setup] DOGE_ORDER_INDEX=' + orderIndex);
    console.log('[dex-doge-setup] DOGE_MAKER=' + maker.address);
    // The BTC payout address this order names as its get_address: the BTC leg
    // releases its escrowed token here on settlement. Consumed as
    // DEX_DOGE_MAKER_BTC_RECV by dexCrossSettleLive.sdk.test.js (#10).
    console.log('[dex-doge-setup] DOGE_MAKER_BTC_RECV=' + btcRecv);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[dex-doge-setup] FAILED:', e.message); process.exit(1); });
