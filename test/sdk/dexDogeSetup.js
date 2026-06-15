/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Cross-chain DEX e2e — DOGE-side maker setup driver (standalone, not a
 * mocha suite). Companion to dexSourceReorgDrill.sdk.test.js.
 *
 * Stands up the DOGE leg of a crossing cross-chain ORDER pair so the hub's
 * CrossChainDexEngine can finalize a `cross_chain_matches` row against the
 * BTC leg the drill places. On a DOGE regtest stack it:
 *   - seeds the oracle prices the DOGE native-coin fee path reads,
 *   - funds a maker + MINTs XCHAIN gas,
 *   - ISSUEs the DOGE-side token (protocol fee paid from XCHAIN balance — this
 *     stack has no FEE_DESTINATION configured, so the native-coin fee path is
 *     off and fees settle in XCHAIN),
 *   - places a cross-chain ORDER: give DOGE/<DEX_DOGE_TICK> 100, get
 *     BTC/<DEX_BTC_TICK> 100 (1:1 so the price gate always crosses; ≤90-day
 *     expiration so the ORDER itself carries no protocol fee),
 *   - verifies the order is 'open', and prints DOGE_ORDER_INDEX + DOGE_MAKER.
 *
 * The ticks are passed in via env (DEX_DOGE_TICK / DEX_BTC_TICK) so they match
 * the BTC drill's expectation — the BTC ORDER's get_tick must equal this
 * order's give_tick and vice-versa, or the engine won't cross them.
 *
 * The shared explorer does not serve DOGE regtest, so this driver submits with
 * waitForIndexer:false and resolves indexing state straight from the DOGE
 * indexer DB (same approach as xcallDogeSetup.js).
 *
 * Env (defaults match the devhost stack):
 *   DEX_DOGE_TICK, DEX_BTC_TICK    (the crossing tick pair — REQUIRED)
 *   XCALL_DOGE_ENCODER_PORT=3123   XCALL_DOGE_MINER_URL=http://localhost:3125
 *   XCALL_DB_HOST=127.0.0.1        XCALL_DB_PORT=13306
 *   HUB_DB_USER/HUB_DB_PASS        (XChain_Hub — price seeding)
 *   DOGE_IDX_DB_USER/DOGE_IDX_DB_PASS (XChain_DOGE_Regtest_Indexer — reads)
 *
 * Usage: node test/sdk/dexDogeSetup.js
 *
 ********************************************************************/

const axios   = require('axios');
const mariadb = require('mariadb');
const { XChainSDK } = require('./sdkHelper');

const MINER_URL = process.env.XCALL_DOGE_MINER_URL || 'http://localhost:3125';
const DB_HOST   = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT   = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

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
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    if (!/^[A-Z0-9]{1,12}$/.test(DOGE_TICK) || !/^[A-Z0-9]{1,12}$/.test(BTC_TICK))
        throw new Error('DEX_DOGE_TICK and DEX_BTC_TICK must be set to uppercase-alnum tickers');

    // ── 1. Resolve the DOGE chain clock — the ORDER expiration is anchored to it
    //       (block_time + 90 days = the free tier), not wall-clock, so it stays in
    //       the free band regardless of regtest clock skew.
    const blockTime = await dogeIdx(async (c) => {
        const rows = await c.query('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1');
        return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000);
    });

    // ── 2. SDK + funded maker.
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
    // not validate ownership of it — it only needs to be format-valid for BTC.
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

    // ── 3. MINT XCHAIN gas, then ISSUE the DOGE-side token. This stack has no
    //       FEE_DESTINATION configured (native-coin fee path off), so the ISSUE
    //       protocol fee settles from the maker's XCHAIN balance. MINT itself
    //       carries no protocol fee, so it bootstraps the gas with zero balance.
    await submitAndIndex('MINT gas',
        { action: 'MINT', params: { tick: 'XCHAIN', amount: 100000, destination: maker.address } }, {});
    await submitAndIndex('ISSUE ' + DOGE_TICK,
        { action: 'ISSUE', params: { tick: DOGE_TICK, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'dex-reorg', mintSupply: 1000 } }, {});

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

    // Verify the order is OPEN (which transitively confirms the ISSUE escrowed:
    // an open order requires the give-side balance the ISSUE minted).
    let status = null;
    for (let i = 0; i < 15; i++) {
        const rows = await dogeIdx((c) => c.query(
            `SELECT s.status FROM order_statuses os
             JOIN index_statuses s ON s.id = os.status_id
             WHERE os.order_action_index = ? ORDER BY os.action_index DESC LIMIT 1`, [orderIndex]));
        status = rows.length ? rows[0].status : null;
        if (status) break;
        await sleep(1500);
    }
    if (status !== 'open')
        throw new Error('DOGE ORDER ' + orderIndex + ' is not open (status=' + status + ') — ISSUE/escrow likely failed');

    console.log('[dex-doge-setup] DOGE_ORDER_INDEX=' + orderIndex);
    console.log('[dex-doge-setup] DOGE_MAKER=' + maker.address);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[dex-doge-setup] FAILED:', e.message); process.exit(1); });
