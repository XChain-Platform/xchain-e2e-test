/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform E2E - Cross-chain DEX LIVE royalty drill
 * (CROSS_CHAIN_ROYALTY finding B: the federation-level twin of indexer
 * integration scenario 26).
 *
 * The royalty variant of dexCrossSettleLive.sdk.test.js (#10). Where #10
 * proves plain escrow release through the live 2f+1 relay federation, this
 * drill proves the CONTROLLER-GUARD ROYALTY survives the same path:
 *
 *   1. deploy a guard contract on BTC whose guard() returns
 *      { payoutLegs: [{ to: <LEG>, bps: 2500 }] }, ISSUE the BTC token, and
 *      BIND its trade class to the guard (ISSUE v6);
 *   2. place the crossing BTC cross-chain ORDER (give BTC/<DEX_BTC_TICK> 100,
 *      get DOGE/<DEX_DOGE_TICK> 100, 1:1) against the OPEN DOGE order from
 *      dexDogeSetup.js, and assert the guard's legs landed on the BTC
 *      orders row (CROSS_CHAIN_ROYALTY create gate: accepted because the
 *      p2pkh leg re-encodes to DOGE; regtest shares base58 prefixes so the
 *      re-encode is the identity string here);
 *   3. the hub's CrossChainDexEngine finalizes a 2f+1-signed
 *      cross_chain_matches row; assert the BTC side of the row CARRIES the
 *      legs (they are inside the signed XMATCH canonical at/above the
 *      flag-day, genesis-active on regtest);
 *   4. the BTC leg settles the full 100 to the DOGE maker's BTC address
 *      (the counterparty DOGE order has no legs);
 *   5. REQUIRED (the novel assert vs #10, where the DOGE leg was
 *      best-effort): the DOGE indexer settles the DOGE leg as the SPLIT
 *      100 -> 75 to the BTC maker's DOGE get_address + 25 to the royalty
 *      leg re-encoded BTC->DOGE, with a cross_chain_settlements row.
 *
 * VENUE: same as #10 (test-host 3-hub relay mesh): relay HUB1 host api.js
 * :10055 + HUB2/3 containers, BTC+DOGE regtest indexers HubDbSync-subscribed
 * to the relay, hub pubkeys staked for cross_chain on the CURRENT BTC chain.
 * Run AFTER dexDogeSetup.js. All services must run royalty-era code
 * (indexer 701eefd+ / hub ebe4025+) or the legs never form.
 *
 * Env: DEX_BTC_TICK, DEX_DOGE_TICK, DEX_DOGE_ORDER_INDEX,
 * DEX_DOGE_MAKER_BTC_RECV (all from dexDogeSetup), HUB_DB_USER/PASS (+
 * HUB_DB_HOST/PORT/NAME for the relay DB), DOGE_IDX_DB_USER/PASS,
 * XCALL_DB_HOST/PORT, XCALL_DOGE_MINER_URL (default http://localhost:3125;
 * the DOGE leg needs DOGE blocks mined during the settlement wait). Uses the
 * BTC stack globals from initialCheck.
 *
 ********************************************************************/

const { expect } = require('chai');
const axios = require('axios');
const mariadb = require('mariadb');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, XChainSDK } = require('./sdkHelper');

const DB_HOST = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.XCALL_DB_PORT || '13306', 10);
const HUB_DB_HOST = process.env.HUB_DB_HOST || DB_HOST;
const HUB_DB_PORT = parseInt(process.env.HUB_DB_PORT || String(DB_PORT), 10);
const HUB_DB_NAME = process.env.HUB_DB_NAME || 'XChain_Hub';
const DOGE_MINER_URL = process.env.XCALL_DOGE_MINER_URL || 'http://localhost:3125';

const BTC_TICK  = String(process.env.DEX_BTC_TICK  || '').trim();
const DOGE_TICK = String(process.env.DEX_DOGE_TICK || '').trim();
const DOGE_MAKER_BTC_RECV = String(process.env.DEX_DOGE_MAKER_BTC_RECV || '').trim();

const ROYALTY_BPS = 2500; // 25% -> 100 splits 75 seller / 25 leg

async function withConn(host, port, database, user, password, fn) {
    const conn = await mariadb.createConnection({ host, port, database, user, password });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
async function hubDb(fn)   { return withConn(HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, process.env.HUB_DB_USER, process.env.HUB_DB_PASS, fn); }
async function dogeIdx(fn) { return withConn(DB_HOST, DB_PORT, 'XChain_DOGE_Regtest_Indexer', process.env.DOGE_IDX_DB_USER, process.env.DOGE_IDX_DB_PASS, fn); }

async function btcIdx(sql, params) {
    const db = global.indexerDatabase;
    const conn = await db.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function mineDoge(count) {
    try {
        await axios.post(DOGE_MINER_URL, { jsonrpc: '2.0', method: 'generate_blocks', params: { count }, id: 1 }, { timeout: 15000 });
    } catch (e) { /* best effort; the BTC-side wait keeps polling */ }
}
async function dogeBalance(address, tick) {
    const rows = await dogeIdx((c) => c.query(
        `SELECT b.amount FROM balances b
         JOIN index_addresses ia ON ia.id = b.address_id
         JOIN index_tickers   it ON it.id = b.tick_id
         WHERE ia.address = ? AND it.tick = ?`, [address, tick]));
    return rows.length ? String(rows[0].amount) : '0';
}
const MATCH_REF_WHERE = "((a_chain='BTC' AND a_action_index = ?) OR (b_chain='BTC' AND b_action_index = ?))";
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] cross-chain DEX LIVE royalty split (finding B live drill)', function () {
    this.timeout(0);

    let sdk, maker, legAddr, dogeRecv, guardIndex, btcOrderIndex, matchId;

    before(async function () {
        expect(BTC_TICK, 'DEX_BTC_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(DOGE_TICK, 'DEX_DOGE_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(parseInt(process.env.DEX_DOGE_ORDER_INDEX || '', 10), 'DEX_DOGE_ORDER_INDEX env')
            .to.be.a('number').and.to.be.greaterThan(0);
        expect(DOGE_MAKER_BTC_RECV, 'DEX_DOGE_MAKER_BTC_RECV env').to.match(/^[a-zA-Z0-9]+$/);
        expect(process.env.HUB_DB_USER, 'HUB_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(process.env.DOGE_IDX_DB_USER, 'DOGE_IDX_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(global.indexerDatabase, 'indexerDatabase global (initialCheck)').to.be.an('object');
        sdk = makeSdk();
        maker = await fundedGasAddress(sdk, 1);

        // The royalty leg recipient: a fresh BTC p2pkh. Regtest BTC/DOGE share the
        // base58 p2pkh prefix, so its DOGE re-encoding is the same string; the DOGE
        // leg assert below reads THIS address on the DOGE indexer.
        const legKp = sdk.generateKeyPair();
        legAddr = sdk.deriveAddress(legKp.publicKey, { type: 'p2pkh' });

        // Where the BTC maker receives the DOGE-side token (75 after the split).
        const dogeSdk = new XChainSDK({ network: 'dogecoin-regtest', timeout: 30000 });
        const dogeKp  = dogeSdk.generateKeyPair();
        dogeRecv = dogeSdk.deriveAddress(dogeKp.publicKey, { type: 'p2pkh' });

        console.log('    [dex-royalty] maker=' + maker.address + ' leg=' + legAddr + ' bps=' + ROYALTY_BPS);
        console.log('    [dex-royalty] BTC maker DOGE payout addr=' + dogeRecv);
    });

    it('DEPLOY the royalty guard, ISSUE the BTC token, BIND its trade class', async function () {
        const guardSrc = "module.exports={ guard:function(){ return { payoutLegs: [{ to: '" +
            legAddr + "', bps: " + ROYALTY_BPS + " }] }; } };";
        const dep = await submit(sdk,
            { action: 'DEPLOY', params: { code: guardSrc, gasLimit: 300000, constructorParams: [] } },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif }));
        expect(dep.indexed.status, 'DEPLOY guard').to.equal('valid');
        const depAction = (dep.indexed.actions || []).find(a => a.action === 'DEPLOY') || dep.indexed.actions[0];
        guardIndex = Number(depAction.action_index);
        expect(guardIndex, 'guard contract action_index').to.be.greaterThan(0);

        const iss = await submit(sdk,
            { action: 'ISSUE', params: { tick: BTC_TICK, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'dex-royalty', mintSupply: 1000 } },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif }));
        expect(iss.indexed.status, 'ISSUE ' + BTC_TICK).to.equal('valid');

        const bind = await submit(sdk,
            { action: 'ISSUE', params: sdk.controller.bindToken({ tick: BTC_TICK, controller: guardIndex, actionClass: 'trade', memo: 'royalty-drill-bind' }) },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif }));
        expect(bind.indexed.status, 'ISSUE v6 bind trade->guard').to.equal('valid');
        await mine(1);
        console.log('    [dex-royalty] guard=' + guardIndex + ' bound trade class of ' + BTC_TICK);
    });

    it('the crossing BTC ORDER is ACCEPTED and the guard legs ride the orders row', async function () {
        const blockTime = Number((await btcIdx('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1', []))[0].block_time);
        const res = await submit(sdk,
            {
                action: 'ORDER',
                params: {
                    giveCoin: 'BTC',  giveTick: BTC_TICK,  giveAmount: 100,
                    getCoin:  'DOGE', getTick:  DOGE_TICK, getAmount:  100,
                    getAddress: dogeRecv, expiration: blockTime + 90 * 86400,
                },
            },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif }));
        expect(res.indexed.status, 'BTC ORDER (royalty-bound token, cross-chain)').to.equal('valid');
        btcOrderIndex = Number(res.indexed.actions[0].action_index);
        await mine(1);

        // The CROSS_CHAIN_ROYALTY create gate ran the guard and persisted its legs
        // on the orders row; the hub's open-order feed carries them from here.
        const legRows = await btcIdx('SELECT payout_legs FROM orders WHERE action_index = ?', [btcOrderIndex]);
        expect(legRows.length, 'BTC orders row').to.equal(1);
        const legs = JSON.parse(String(legRows[0].payout_legs || 'null'));
        expect(legs, 'payout_legs on the BTC orders row').to.deep.equal([{ to: legAddr, bps: ROYALTY_BPS }]);
        console.log('    [dex-royalty] BTC order=' + btcOrderIndex + ' legs=' + JSON.stringify(legs));
    });

    it('the hub finalizes the match WITH the legs inside the signed row', async function () {
        const deadline = Date.now() + 300000;
        let match = null;
        while (Date.now() < deadline) {
            const rows = await hubDb(async (c) => c.query(
                'SELECT match_id, status, a_chain, a_action_index, a_payout_legs, b_chain, b_action_index, b_payout_legs ' +
                'FROM cross_chain_matches WHERE ' + MATCH_REF_WHERE + ' ORDER BY id DESC LIMIT 1',
                [btcOrderIndex, btcOrderIndex]));
            if (rows.length && rows[0].status === 'finalized') { match = rows[0]; break; }
            await mine(1);
            await sleep(3000);
        }
        expect(match, 'hub finalized a cross_chain_matches row for the BTC order').to.be.an('object');
        matchId = match.match_id;
        const btcSideLegs = match.a_chain === 'BTC' ? match.a_payout_legs : match.b_payout_legs;
        const dogeSideLegs = match.a_chain === 'BTC' ? match.b_payout_legs : match.a_payout_legs;
        expect(JSON.parse(String(btcSideLegs || 'null')), 'BTC-side legs INSIDE the finalized match row')
            .to.deep.equal([{ to: legAddr, bps: ROYALTY_BPS }]);
        expect(dogeSideLegs, 'DOGE side has no legs').to.satisfy(v => v === null || v === undefined);
        console.log('    [dex-royalty] finalized match ' + matchId + ' carries the BTC-side legs');
    });

    it('the BTC leg settles the FULL 100 to the DOGE maker (counterparty has no legs)', async function () {
        const deadline = Date.now() + 300000;
        let settlements = 0, payoutAmt = null;
        while (Date.now() < deadline) {
            await mine(1);
            await mineDoge(1);
            await sleep(3000);
            settlements = Number((await btcIdx(
                'SELECT COUNT(*) n FROM cross_chain_settlements WHERE local_action_index = ?', [btcOrderIndex]))[0].n);
            const bal = await btcIdx(
                'SELECT b.amount FROM balances b JOIN index_addresses a ON a.id=b.address_id ' +
                'JOIN index_tickers t ON t.id=b.tick_id WHERE a.address=? AND t.tick=? ' +
                'ORDER BY CAST(b.amount AS DECIMAL(60,0)) DESC LIMIT 1', [DOGE_MAKER_BTC_RECV, BTC_TICK]);
            payoutAmt = bal.length ? String(bal[0].amount) : null;
            if (settlements >= 1 && payoutAmt && payoutAmt !== '0') break;
        }
        expect(settlements, 'cross_chain_settlements row for the BTC ORDER leg').to.be.greaterThan(0);
        expect(payoutAmt, 'DOGE maker credited the full BTC-side escrow (no legs on the DOGE order)').to.equal('100');
        console.log('    [dex-royalty] BTC leg settled: 100 ' + BTC_TICK + ' -> ' + DOGE_MAKER_BTC_RECV);
    });

    it('REQUIRED: the DOGE leg settles the SPLIT: 75 to the BTC maker + 25 to the re-encoded royalty leg', async function () {
        const dogeOrderIndex = parseInt(process.env.DEX_DOGE_ORDER_INDEX, 10);
        const deadline = Date.now() + 300000;
        let settlements = 0, sellerAmt = '0', legAmt = '0';
        while (Date.now() < deadline) {
            await mineDoge(1);
            await mine(1);
            await sleep(3000);
            settlements = Number((await dogeIdx((c) => c.query(
                'SELECT COUNT(*) n FROM cross_chain_settlements WHERE local_action_index = ?', [dogeOrderIndex])))[0].n);
            sellerAmt = await dogeBalance(dogeRecv, DOGE_TICK);
            legAmt    = await dogeBalance(legAddr, DOGE_TICK);
            if (settlements >= 1 && sellerAmt !== '0' && legAmt !== '0') break;
        }
        expect(settlements, 'cross_chain_settlements row for the DOGE ORDER leg').to.be.greaterThan(0);
        expect(sellerAmt, 'BTC maker DOGE payout = seller remainder after the 2500 bps split').to.equal('75');
        expect(legAmt, 'royalty leg (BTC address re-encoded to DOGE) credited').to.equal('25');
        console.log('    [dex-royalty] DOGE leg settled the split: 75 ' + DOGE_TICK + ' -> ' + dogeRecv +
            ' + 25 ' + DOGE_TICK + ' -> ' + legAddr + ' (match ' + matchId + ')');
    });
});
