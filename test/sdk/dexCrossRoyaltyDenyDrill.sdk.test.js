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
 * XChain Platform E2E - CROSS_CHAIN_ROYALTY create-gate DENY drill
 * (the single-node counterpart of dexCrossRoyaltyLive.sdk.test.js).
 *
 * The live royalty drill proves the ON side of the create gate: a
 * royalty-bearing cross-chain listing is accepted and its legs ride the
 * signed match. This drill proves the OFF side, the fail-closed branch
 * in indexer actions/order.js + actions/swap.js:
 *
 *     invalid: royalty not enforceable cross-chain
 *
 * Below the CROSS_CHAIN_ROYALTY flag-day a cross-chain listing of a
 * controller-bound token whose guard returns payoutLegs MUST be denied:
 * the proceeds settle on GET_COIN, where a pre-flag-day fleet cannot apply
 * the legs, so accepting the listing would silently evade the royalty.
 *
 * VENUE: ONE chain. No hub, no counterparty chain, no federation: the whole
 * verdict is decided by the local indexer at ORDER/SWAP create, so a plain
 * single-node BTC regtest stack is enough (GET_COIN=DOGE need not exist
 * anywhere; the indexer's COINS list is static and CROSS_CHAIN_DEX is
 * genesis-active on regtest).
 *
 * MODE (env ROYALTY_DENY_MODE, default 'allow'):
 *   allow - the indexer runs with the override unset (regtest default,
 *           genesis-active): the cross-chain ORDER and SWAP must be ACCEPTED
 *           with the guard's legs on the row. This is the DEFAULT so a plain
 *           `npm run test:sdk` on an ordinary stack asserts the ON side, and it
 *           is the positive control that pins the deny pass to the flag-day
 *           rather than to some unrelated breakage in the guard/bind path.
 *   deny  - the indexer runs with CROSS_CHAIN_ROYALTY_REGTEST_TIME set to a
 *           FUTURE unix time, so the change is OFF: the identical cross-chain
 *           ORDER and SWAP must be denied, no legs and no escrow, while the
 *           same-chain listing of the same royalty-bound token stays ACCEPTED.
 *
 * Run BOTH passes against the same stack (restart the indexer between them
 * with/without the env) for a complete drill.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, uniqueTick, XChainSDK } = require('./sdkHelper');

const MODE = String(process.env.ROYALTY_DENY_MODE || 'allow').trim().toLowerCase();
const DENY = (MODE === 'deny');
const ROYALTY_BPS = 2500;                 // 25%: the live drill's split
const DENY_STATUS = 'invalid: royalty not enforceable cross-chain';

// The indexer's COINS list is static (BTC/LTC/DOGE), so the GET side of a
// cross-chain listing only has to NAME another chain: nothing on it is touched
// at create. Local coin comes from the venue, foreign is any other member.
const COIN_OF = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };
const SDK_NET_OF = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' };
function localCoin() {
    const raw = String(global.COIN || process.env.COIN || 'bitcoin').split('-')[0].toLowerCase();
    return COIN_OF[raw] || 'BTC';
}
function networkTier() {
    let net = String(global.NETWORK || process.env.NETWORK || 'regtest');
    return net.includes('-') ? net.split('-')[1] : net;
}

async function idx(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function latestBlockTime() {
    const rows = await idx('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1', []);
    return Number(rows[0].block_time);
}
// The row's own verdict: orders/swaps carry the action STATUS string (the full
// 'invalid: ...' reason) behind status_id -> index_statuses, not as a column.
async function listingRow(table, actionIndex) {
    const rows = await idx(
        'SELECT s.status AS status, t.payout_legs AS payout_legs FROM ' + table + ' t ' +
        'LEFT JOIN index_statuses s ON s.id = t.status_id WHERE t.action_index = ?', [actionIndex]);
    if (!rows.length) return null;
    const legs = (rows[0].payout_legs === null || rows[0].payout_legs === undefined)
        ? null : JSON.parse(String(rows[0].payout_legs));
    return { status: String(rows[0].status), legs };
}
async function balanceOf(address, tick) {
    const rows = await idx(
        'SELECT b.amount FROM balances b JOIN index_addresses a ON a.id=b.address_id ' +
        'JOIN index_tickers t ON t.id=b.tick_id WHERE a.address=? AND t.tick=?', [address, tick]);
    return rows.length ? String(rows[0].amount) : '0';
}

describe('[sdk] CROSS_CHAIN_ROYALTY create-gate deny drill (mode=' + MODE + ')', function () {
    this.timeout(0);

    let sdk, maker, legAddr, getAddr, tick, guardIndex, LOCAL_COIN, GET_COIN;

    before(async function () {
        expect(['deny', 'allow'], 'ROYALTY_DENY_MODE must be deny|allow').to.include(MODE);
        expect(global.indexerDatabase, 'indexerDatabase global (initialCheck)').to.be.an('object');

        LOCAL_COIN = localCoin();
        GET_COIN   = String(process.env.ROYALTY_DENY_GET_COIN || (LOCAL_COIN === 'DOGE' ? 'BTC' : 'DOGE')).trim().toUpperCase();
        expect(GET_COIN, 'GET_COIN must be a foreign chain').to.not.equal(LOCAL_COIN);

        sdk   = makeSdk();
        maker = await fundedGasAddress(sdk, 1);
        tick  = uniqueTick('RDN');

        // Royalty recipient: a fresh local p2pkh. Regtest BTC/DOGE share the base58
        // p2pkh prefix, so this address re-encodes to GET_COIN as the same string;
        // the leg is therefore payable and cannot be what trips the ALLOW pass.
        const legKp = sdk.generateKeyPair();
        legAddr = sdk.deriveAddress(legKp.publicKey, { type: 'p2pkh' });

        // Where the maker would receive the foreign-chain proceeds.
        const foreignSdk = new XChainSDK({ network: SDK_NET_OF[GET_COIN] + '-' + networkTier(), timeout: 30000 });
        const foreignKp  = foreignSdk.generateKeyPair();
        getAddr = foreignSdk.deriveAddress(foreignKp.publicKey, { type: 'p2pkh' });

        console.log('    [royalty-deny] mode=' + MODE + ' tick=' + tick + ' maker=' + maker.address);
        console.log('    [royalty-deny] leg=' + legAddr + ' bps=' + ROYALTY_BPS + ' getCoin=' + GET_COIN);
    });

    it('DEPLOY the royalty guard, ISSUE the token, BIND its trade class', async function () {
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
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'royalty-deny-drill', mintSupply: 1000 } },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif }));
        expect(iss.indexed.status, 'ISSUE ' + tick).to.equal('valid');

        const bind = await submit(sdk,
            { action: 'ISSUE', params: sdk.controller.bindToken({ tick, controller: guardIndex, actionClass: 'trade', memo: 'royalty-deny-bind' }) },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif }));
        expect(bind.indexed.status, 'ISSUE v6 bind trade->guard').to.equal('valid');
        await mine(1);
        console.log('    [royalty-deny] guard=' + guardIndex + ' bound to the trade class of ' + tick);
    });

    it('cross-chain ORDER of the royalty-bound token is ' + (DENY ? 'DENIED (fail-closed)' : 'ACCEPTED with legs'), async function () {
        const before = await balanceOf(maker.address, tick);
        const res = await submit(sdk,
            {
                action: 'ORDER',
                params: {
                    giveCoin: LOCAL_COIN, giveTick: tick, giveAmount: 100,
                    getCoin: GET_COIN, getTick: 'RDNGET', getAmount: 100,
                    getAddress: getAddr, expiration: (await latestBlockTime()) + 90 * 86400,
                },
            },
            // requireValid:false - the DENY pass expects a chain-rejected action, and the
            // SDK's default waiter turns that into a thrown error instead of a verdict.
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif, requireValid: false }));
        const orderIndex = Number(res.indexed.actions[0].action_index);
        await mine(1);

        const row = await listingRow('orders', orderIndex);
        expect(row, 'orders row for action ' + orderIndex).to.be.an('object');
        console.log('    [royalty-deny] ORDER ' + orderIndex + ' indexed=' + res.indexed.status +
            ' row=' + row.status + ' legs=' + JSON.stringify(row.legs));

        if (DENY) {
            expect(String(res.indexed.status), 'indexed ORDER status').to.match(/^invalid/);
            expect(row.status, 'orders row status').to.equal(DENY_STATUS);
            expect(row.legs, 'no legs persisted on a denied listing').to.equal(null);
            // Fail-closed means fail-clean: a denied listing escrows nothing.
            expect(await balanceOf(maker.address, tick), 'GIVE balance untouched by the denied ORDER').to.equal(before);
        } else {
            expect(res.indexed.status, 'indexed ORDER status').to.equal('valid');
            expect(row.status, 'orders row status').to.equal('valid');
            expect(row.legs, 'guard legs on the accepted listing').to.deep.equal([{ to: legAddr, bps: ROYALTY_BPS }]);
        }
    });

    it('cross-chain SWAP of the royalty-bound token is ' + (DENY ? 'DENIED (fail-closed)' : 'ACCEPTED with legs'), async function () {
        const res = await submit(sdk,
            {
                action: 'SWAP',
                params: {
                    version: 0,
                    giveCoin: LOCAL_COIN, giveTick: tick, giveAmount: 50,
                    getCoin: GET_COIN, getTick: 'RDNGET', getAmount: 50,
                    getAddress: getAddr, expiration: (await latestBlockTime()) + 90 * 86400,
                    memo: 'royalty-deny-drill',
                },
            },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif, requireValid: false }));
        const swapIndex = Number(res.indexed.actions[0].action_index);
        await mine(1);

        const row = await listingRow('swaps', swapIndex);
        expect(row, 'swaps row for action ' + swapIndex).to.be.an('object');
        console.log('    [royalty-deny] SWAP ' + swapIndex + ' indexed=' + res.indexed.status +
            ' row=' + row.status + ' legs=' + JSON.stringify(row.legs));

        if (DENY) {
            expect(String(res.indexed.status), 'indexed SWAP status').to.match(/^invalid/);
            expect(row.status, 'swaps row status').to.equal(DENY_STATUS);
            expect(row.legs, 'no legs persisted on a denied listing').to.equal(null);
        } else {
            expect(res.indexed.status, 'indexed SWAP status').to.equal('valid');
            expect(row.status, 'swaps row status').to.equal('valid');
            expect(row.legs, 'guard legs on the accepted listing').to.deep.equal([{ to: legAddr, bps: ROYALTY_BPS }]);
        }
    });

    it('CONTROL: the SAME-chain listing of the same royalty-bound token stays ACCEPTED with legs', async function () {
        const res = await submit(sdk,
            {
                action: 'ORDER',
                params: {
                    giveCoin: LOCAL_COIN, giveTick: tick, giveAmount: 10,
                    getCoin: LOCAL_COIN, getTick: 'XCHAIN', getAmount: 1,
                    getAddress: maker.address, expiration: (await latestBlockTime()) + 90 * 86400,
                },
            },
            { pubkey: maker.address, change: maker.address }, submitOpts({ wif: maker.wif }));
        const orderIndex = Number(res.indexed.actions[0].action_index);
        await mine(1);

        const row = await listingRow('orders', orderIndex);
        expect(row, 'orders row for action ' + orderIndex).to.be.an('object');
        console.log('    [royalty-deny] same-chain ORDER ' + orderIndex + ' indexed=' + res.indexed.status +
            ' row=' + row.status + ' legs=' + JSON.stringify(row.legs));

        // The gate is cross-chain-only: a local royalty listing is enforceable at
        // match time on this very chain, flag-day or not.
        expect(res.indexed.status, 'same-chain ORDER status').to.equal('valid');
        expect(row.legs, 'guard legs on the same-chain listing').to.deep.equal([{ to: legAddr, bps: ROYALTY_BPS }]);
    });
});
