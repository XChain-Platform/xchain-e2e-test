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
 * XCALL e2e — DOGE-side target setup driver (standalone, not a mocha suite).
 *
 * Stands up the TARGET side of the cross-chain call campaign on a DOGE
 * regtest stack: seeds the oracle prices the native-coin fee path needs,
 * funds a deployer, mints XCHAIN gas, deploys the crossCallable target
 * contract (fee paid in native DOGE), and prints the contract index.
 *
 * The shared explorer does not serve DOGE regtest, so this driver submits
 * with waitForIndexer:false and resolves indexing state straight from the
 * DOGE indexer DB.
 *
 * Env (defaults match the devhost stack):
 *   XCALL_DOGE_ENCODER_PORT=3123  XCALL_DOGE_MINER_URL=http://localhost:3125
 *   XCALL_DB_HOST=127.0.0.1 XCALL_DB_PORT=13306
 *   HUB_DB_USER/HUB_DB_PASS        (XChain_Hub — price seeding)
 *   DOGE_IDX_DB_USER/DOGE_IDX_DB_PASS (XChain_DOGE_Regtest_Indexer — reads)
 *
 * Usage: node test/sdk/xcallDogeSetup.js
 *
 ********************************************************************/

const axios   = require('axios');
const mariadb = require('mariadb');
const { XChainSDK } = require('./sdkHelper');

const MINER_URL = process.env.XCALL_DOGE_MINER_URL || 'http://localhost:3125';
const DB_HOST   = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT   = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

const CONTRACT_B = `
    module.exports = {
        crossCallable: ['onArrival', 'doRevert', 'bigReturn'],
        onArrival: function(xchain) {
            xchain.state.set('lastPing', xchain.getInputParam(0));
            xchain.state.set('lastCaller', xchain.getSourceAddress());
            xchain.state.set('hops', String(xchain.getCrossHops()));
            return 'pong:' + xchain.getInputParam(0);
        },
        doRevert: function(xchain) { xchain.revert('target said no'); },
        bigReturn: function(xchain) {
            var s = 'x';
            while (s.length < 1100) { s = s + s; }
            return s;
        },
        hidden: function(xchain) { return 'secret'; }
    };
`;

// Hop bouncer (X→Y→X round trip): a crossCallable method that itself
// crossExecutes BACK to the originating BTC contract (index arrives as the
// call param). The arriving execution runs at crossHops=1, so the back-call
// goes out at hops=2 — exactly the XCALL_MAX_HOPS cap.
const CONTRACT_C = `
    module.exports = {
        crossCallable: ['bounce'],
        bounce: function(xchain) {
            var backId = xchain.emit.crossExecute({
                targetChain:    'BTC',
                contractIndex:  Number(xchain.getInputParam(0)),
                method:         'onPong',
                params:         ['from-doge'],
                gasLimit:       30000,
                callbackMethod: 'onBackResult',
                callbackParams: ['bounce-ctx'],
                deadlineBlocks: 600
            });
            xchain.state.set('lastBack', backId);
            return backId;
        },
        onBackResult: function(xchain) {
            xchain.state.set('back:' + xchain.getInputParam(0), JSON.stringify({
                chain:   xchain.getInputParam(1),
                status:  xchain.getInputParam(2),
                payload: xchain.getInputParam(3),
                echo:    xchain.getInputParam(4)
            }));
        }
    };
`;

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
    // ── 1. Seed the prices the DOGE native-fee path reads (XChain_Hub,
    //       anchored to the DOGE chain clock — wall-clock seeds race both ways).
    const blockTime = await dogeIdx(async (c) => {
        const rows = await c.query('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1');
        return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000);
    });
    await withConn('XChain_Hub', process.env.HUB_DB_USER, process.env.HUB_DB_PASS, async (c) => {
        for (const [pair, price, round] of [['DOGE/USD', '0.10000000', 990001], ['XCHAIN/USD', '1.00000000', 990002]]) {
            await c.query(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized')
                 ON DUPLICATE KEY UPDATE price = VALUES(price), block_timestamp = VALUES(block_timestamp), status = 'finalized'`,
                [round, pair, price, blockTime]);
        }
    });
    console.log('[doge-setup] prices seeded (DOGE/USD, XCHAIN/USD) at chain time ' + blockTime);

    // ── 2. SDK + funded deployer.
    const sdk = new XChainSDK({
        network:     'dogecoin-regtest',
        encoderUrl:  'localhost',
        encoderPort: parseInt(process.env.XCALL_DOGE_ENCODER_PORT || '3123', 10),
        timeout:     30000,
        retry:       { maxRetries: 2 },
    });
    const kp = sdk.generateKeyPair();
    const deployer = { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
    await minerRpc('send_funds', { address: deployer.address, amount: 100 });
    await minerRpc('generate_blocks', { count: 2 });
    await sleep(3000);
    console.log('[doge-setup] deployer=' + deployer.address);

    // Helper: submit without the explorer waiter (no DOGE explorer), mine, and
    // resolve the indexed action row by tx hash via the indexer DB.
    async function submitAndIndex(label, actionData, encoderOpts) {
        const res = await sdk.submitAction(actionData,
            Object.assign({ pubkey: deployer.address, change: deployer.address, unconfirmed: false }, encoderOpts),
            { wif: deployer.wif, waitForIndexer: false });
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
                console.log('[doge-setup] ' + label + ': indexed as action ' + rows[0].action_index);
                return Number(rows[0].action_index);
            }
        }
        throw new Error(label + ': tx ' + txid + ' never indexed');
    }

    // ── 3. XCHAIN gas (MINT — no protocol fee). Validity confirmed via balance.
    //       Cap at the genesis XCHAIN MAX_MINT (100000) — a single MINT above it
    //       is indexed 'invalid: AMOUNT > MAX_MINT', leaving the deployer with no
    //       GAS and the DEPLOY rejecting 'insufficient funds (GAS)'. 100000 is
    //       three orders past the ~1 XCHAIN DEPLOY fee, so one mint is plenty.
    await submitAndIndex('MINT gas',
        { action: 'MINT', params: { tick: 'XCHAIN', amount: 100000, destination: deployer.address } }, {});

    // ── 4. DEPLOY the target contract, fee in native DOGE. The explorer does
    //       not serve DOGE regtest, so the SDK's quote rail (payFeeInNativeCoin
    //       → explorer feequote) is unavailable — size the fee output directly
    //       from the consensus formula instead:
    //         gasCost        = VM_DEPLOY_BASE(100000) + codeBytes × VM_DEPLOY_PER_BYTE(10)
    //         feeXchain      = gasCost × GAS_PRICE(0.00001)
    //         expectedNative = feeXchain × (XCHAIN/USD ÷ DOGE/USD)   [seeded 1.0 / 0.1]
    //       paid to the chain's FEE_DESTINATION (DOGE regtest), mid-band of the
    //       0.95–1.10 tolerance.
    const FEE_DESTINATION = 'mfees5pa2HwNBonk5vG23aDWkN9fuDJib4';

    async function deployContract(label, code) {
        const codeBytes  = Buffer.byteLength(code, 'utf8');
        const gasCost    = 100000 + codeBytes * 10;
        const feeXchain  = gasCost * 0.00001;
        const nativeDoge = feeXchain * (1.0 / 0.1);
        const feeSats    = Math.round(nativeDoge * 1e8);
        console.log('[doge-setup] ' + label + ' fee sizing: codeBytes=' + codeBytes + ' gasCost=' + gasCost +
                    ' feeXCHAIN=' + feeXchain + ' nativeDOGE=' + nativeDoge);

        const actionIndex = await submitAndIndex('DEPLOY ' + label,
            { action: 'DEPLOY', params: { code: code, gasLimit: 200000 } },
            { customOutputs: [{ address: FEE_DESTINATION, value: feeSats }] });

        const contractRows = await dogeIdx((c) => c.query(
            `SELECT c.action_index, ix.status FROM contracts c
             LEFT JOIN index_statuses ix ON ix.id = c.status_id
             WHERE c.action_index = ?`, [actionIndex]));
        if (!contractRows.length)
            throw new Error('DEPLOY ' + label + ' indexed (action ' + actionIndex + ') but no contracts row — deploy failed validation');
        const status = contractRows[0].status || 'n/a';
        console.log('[doge-setup] ' + label + ' contract status=' + status);
        if (status !== 'valid')
            throw new Error('DEPLOY ' + label + ' rejected: ' + status);
        return actionIndex;
    }

    const targetIndex  = await deployContract('target',  CONTRACT_B);
    const bouncerIndex = await deployContract('bouncer', CONTRACT_C);
    console.log('[doge-setup] TARGET_CONTRACT_INDEX=' + targetIndex);
    console.log('[doge-setup] BOUNCER_CONTRACT_INDEX=' + bouncerIndex);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[doge-setup] FAILED:', e.message); process.exit(1); });
