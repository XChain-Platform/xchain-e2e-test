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
 * XChain Platform E2E - CROSS-COIN SWAP live settlement.
 *
 * The cross-coin variant swap.sdk.test.js defers: that suite drives the
 * same-chain SWAP path (GIVE_COIN == GET_COIN, auto-matched by the local
 * indexer engine), because GIVE_COIN != GET_COIN needs a live multi-chain
 * stack where the hub coordinates the two ledgers. This drill is that stack's
 * SWAP leg, built on the multi-chain SDK e2e harness the cross-chain DEX work
 * landed (dexDogeSetup.js / dexCrossSettleLive.sdk.test.js).
 *
 * It is the SWAP twin of dexCrossSettleLive.sdk.test.js. The DEX drill crosses
 * a BTC<->DOGE ORDER pair (Phase B: price-time book, partial fills); this one
 * crosses a BTC<->DOGE SWAP pair, which the hub's CrossChainDexEngine matches
 * through the Phase A path instead: SWAP<->SWAP is an EXACT full-amount fill,
 * FCFS, each leg committing its whole give amount in one match.
 *
 *   1. (setup, swapCrossDogeSetup.js) a DOGE maker has an OPEN cross-chain
 *      SWAP: give DOGE/<SWAP_DOGE_TICK> 100, get BTC/<SWAP_BTC_TICK> 100, with
 *      a BTC get_address (where the DOGE maker receives the BTC-side token).
 *   2. this drill places the mirroring BTC SWAP: give BTC/<SWAP_BTC_TICK> 100,
 *      get DOGE/<SWAP_DOGE_TICK> 100, with a DOGE get_address.
 *   3. the hub's CrossChainDexEngine finalizes a 2f+1-signed cross_chain_matches
 *      row over both legs, tagged a_kind/b_kind='swap';
 *   4. each chain's indexer processes the mirrored match through cross_settle.js
 *      (verify sigs vs the locked cross_chain capability_snapshots ->
 *      recordCrossChainSettlement -> updateBalances). The SWAP leg takes
 *      cross_settle's Phase-A full-release branch: the BTC leg releases the
 *      maker's escrowed 100 BTC/<SWAP_BTC_TICK> to the DOGE maker's BTC
 *      get_address, and the DOGE leg releases 100 DOGE/<SWAP_DOGE_TICK> to this
 *      maker's DOGE get_address.
 *
 * ASSERTS (the coverage swap.sdk.test.js's NOTE defers):
 *   - a cross-coin SWAP (GIVE_COIN != GET_COIN) is accepted and surfaces in the
 *     unified cross-chain book as kind='swap' (not the local match path);
 *   - the hub finalizes a cross_chain_matches row whose legs are BTC + DOGE;
 *   - the DOGE maker's BTC get_address is CREDITED the full 100
 *     BTC/<SWAP_BTC_TICK> (real escrow release on a real indexer DB);
 *   - a cross_chain_settlements row is recorded for the BTC leg (idempotency
 *     anchor), and the BTC swap leaves 'open';
 *   - (DOGE leg, best-effort) the DOGE SWAP also leaves 'open' once the DOGE
 *     indexer settles its side.
 *
 * VENUE (the same live stack dexCrossSettleLive needs - a relay hub whose
 * finalized rows are MIRRORED into the live indexers, i.e. HubDbSync ON):
 *   - BTC + DOGE regtest, with a validator-mode relay hub running CrossChainDex
 *     + the hub key staked for the cross_chain capability, BTC_INDEXER_URL/
 *     DOGE_INDEXER_URL wired (hub pull);
 *   - the BTC + DOGE INDEXERS subscribed to that relay hub via HubDbSync
 *     (HUB_DB_SYNC_ENABLED=true, HUB_API_URL=relay WS, HUB_DB_*=relay DB) so the
 *     finalized cross_chain_matches row + capability_snapshots reach the indexer
 *     and cross_settle fires. Without that mirror step 4 never happens and this
 *     drill times out at the settlement wait.
 *   - CROSS_CHAIN_DEX active on both chains (swap.js rejects a cross-chain SWAP
 *     outright otherwise).
 *
 * Runs on BTC regtest only (skips elsewhere, same pin as swap.sdk.test.js), and
 * skips cleanly when the multi-chain env is absent so a single-chain SDK run is
 * not turned red by a venue it does not have.
 *
 * Env: SWAP_BTC_TICK, SWAP_DOGE_TICK, SWAP_DOGE_SWAP_INDEX (from
 * swapCrossDogeSetup), SWAP_DOGE_MAKER_BTC_RECV (that driver's
 * DOGE_MAKER_BTC_RECV), HUB_DB_USER/PASS, DOGE_IDX_DB_USER/PASS,
 * XCALL_DB_HOST/PORT. Uses the BTC stack globals from initialCheck
 * (indexerDatabase / regtestMinerConnector).
 *
 ********************************************************************/

const { expect } = require('chai');
const mariadb = require('mariadb');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, XChainSDK } = require('./sdkHelper');

const DB_HOST = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

// The relay hub may run as a SEPARATE disposable DB rather than the shared stack
// MariaDB (the proven 3-hub venue runs XChain_Relay_Hub on 172.17.0.1:13341).
// Default to the XCALL_DB_* stack DB + 'XChain_Hub'; override to point elsewhere.
const HUB_DB_HOST = process.env.HUB_DB_HOST || DB_HOST;
const HUB_DB_PORT = parseInt(process.env.HUB_DB_PORT || String(DB_PORT), 10);
const HUB_DB_NAME = process.env.HUB_DB_NAME || 'XChain_Hub';

const BTC_TICK  = String(process.env.SWAP_BTC_TICK  || '').trim();
const DOGE_TICK = String(process.env.SWAP_DOGE_TICK || '').trim();
// The BTC address the DOGE maker's cross-chain SWAP named as its get_address
// (swapCrossDogeSetup's DOGE_MAKER_BTC_RECV). The BTC leg releases the escrowed
// BTC-side token here on settlement, so it is required to assert the credit.
const DOGE_MAKER_BTC_RECV = String(process.env.SWAP_DOGE_MAKER_BTC_RECV || '').trim();
const DOGE_SWAP_INDEX = parseInt(process.env.SWAP_DOGE_SWAP_INDEX || '', 10);

// Exact-match amount: Phase A crosses SWAP<->SWAP only when each side's give_amount
// equals the other's get_amount. Keep in lockstep with swapCrossDogeSetup's SWAP_AMOUNT.
const SWAP_AMOUNT = 100;

// Every env this drill needs before it can mean anything. Absent => the venue is a
// plain single-chain SDK stack and the suite skips rather than fails.
const REQUIRED_ENV = ['SWAP_BTC_TICK', 'SWAP_DOGE_TICK', 'SWAP_DOGE_SWAP_INDEX',
    'SWAP_DOGE_MAKER_BTC_RECV', 'HUB_DB_USER', 'DOGE_IDX_DB_USER'];
function missingEnv() {
    return REQUIRED_ENV.filter(k => !String(process.env[k] || '').trim());
}

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
async function btcCount(sql, params) { return Number((await btcIdx(sql, params))[0].n); }

// Latest status of a local SWAP: swap_statuses is append-only, so the highest
// action_index row is current (same rule getOpenCrossChainOffers applies).
async function btcSwapStatus(swapActionIndex) {
    const rows = await btcIdx(
        "SELECT s.status FROM swap_statuses ss JOIN index_statuses s ON s.id=ss.status_id " +
        "WHERE ss.swap_action_index=? ORDER BY ss.action_index DESC LIMIT 1", [swapActionIndex]).catch(() => []);
    return rows.length ? rows[0].status : null;
}

const MATCH_REF_WHERE = "((a_chain='BTC' AND a_action_index = ?) OR (b_chain='BTC' AND b_action_index = ?))";
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] cross-coin SWAP live settlement', function () {
    this.timeout(0);

    let sdk, maker, btcSwapIndex, dogeRecv;

    before(async function () {
        const coinCode = global.COIN_CODE || 'BTC';
        if (coinCode !== 'BTC') {
            console.log('    [swap-cross] pinned to BTC, skipping on ' + coinCode);
            this.skip();
            return;
        }
        const missing = missingEnv();
        if (missing.length) {
            console.log('    [swap-cross] multi-chain venue env absent (' + missing.join(', ') +
                '), skipping. Run test/sdk/swapCrossDogeSetup.js on a BTC+DOGE regtest stack first.');
            this.skip();
            return;
        }
        expect(BTC_TICK,  'SWAP_BTC_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(DOGE_TICK, 'SWAP_DOGE_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(DOGE_SWAP_INDEX, 'SWAP_DOGE_SWAP_INDEX env').to.be.a('number').and.to.be.greaterThan(0);
        expect(DOGE_MAKER_BTC_RECV, 'SWAP_DOGE_MAKER_BTC_RECV env (the BTC addr the DOGE swap pays out to)')
            .to.match(/^[a-zA-Z0-9]+$/);
        expect(global.indexerDatabase, 'indexerDatabase global (initialCheck)').to.be.an('object');

        sdk = makeSdk();
        maker = await fundedGasAddress(sdk, 1);
        // A valid DOGE regtest address for the BTC SWAP's GET_ADDRESS (where this maker
        // receives the DOGE-side token on settlement). swap.js checks format only.
        const dogeSdk = new XChainSDK({ network: 'dogecoin-regtest', timeout: 30000 });
        const dogeKp  = dogeSdk.generateKeyPair();
        dogeRecv = dogeSdk.deriveAddress(dogeKp.publicKey, { type: 'p2pkh' });
        console.log('    [swap-cross] maker=' + maker.address + ' BTC_TICK=' + BTC_TICK + ' DOGE_TICK=' + DOGE_TICK);
        console.log('    [swap-cross] DOGE maker BTC payout addr=' + DOGE_MAKER_BTC_RECV);
    });

    it('ISSUE the BTC token and place the mirroring cross-coin SWAP (GIVE_COIN != GET_COIN)', async function () {
        const iss = await submit(sdk,
            { action: 'ISSUE', params: { tick: BTC_TICK, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'swap-cross-settle', mintSupply: 1000 } },
            { pubkey: maker.address, change: maker.address },
            submitOpts({ wif: maker.wif })
        );
        expect(iss.indexed.status, 'ISSUE ' + BTC_TICK).to.equal('valid');

        // Free-tier expiration (chain clock + 90d) so the SWAP carries no protocol fee.
        const blockTime = Number((await btcIdx('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1', []))[0].block_time);
        const res = await submit(sdk,
            {
                action: 'SWAP',
                params: {
                    version:  0,
                    giveCoin: 'BTC',  giveTick: BTC_TICK,  giveAmount: SWAP_AMOUNT,
                    getCoin:  'DOGE', getTick:  DOGE_TICK, getAmount:  SWAP_AMOUNT,
                    getAddress: dogeRecv, expiration: blockTime + 90 * 86400,
                    memo: 'cross-coin swap btc leg',
                },
            },
            { pubkey: maker.address, change: maker.address },
            submitOpts({ wif: maker.wif })
        );
        expect(res.version, 'should select SWAP v0').to.equal(0);
        expect(res.indexed.status, 'cross-coin SWAP should be accepted (needs CROSS_CHAIN_DEX active)').to.equal('valid');
        btcSwapIndex = Number(res.indexed.actions[0].action_index);
        await mine(1);
        console.log('    [swap-cross] BTC swap=' + btcSwapIndex);

        // It must land in the CROSS-chain book, not the local auto-match path: that is
        // what separates this from swap.sdk.test.js's same-chain coverage.
        const open = await btcIdx(
            "SELECT COUNT(*) n FROM swaps s JOIN index_coins gc ON gc.id=s.give_coin_id " +
            "JOIN index_coins cc ON cc.id=s.get_coin_id WHERE s.action_index=? AND gc.coin<>cc.coin", [btcSwapIndex]);
        expect(Number(open[0].n), 'the BTC swap is recorded with give_coin != get_coin').to.equal(1);
        expect(await btcSwapStatus(btcSwapIndex), 'BTC swap opens').to.equal('open');
    });

    it('the hub finalizes the cross-chain match against the BTC swap', async function () {
        const deadline = Date.now() + 240000;
        let match = null;
        while (Date.now() < deadline) {
            const rows = await hubDb(async (c) => c.query(
                "SELECT match_id, status, a_chain, a_action_index, a_kind, b_chain, b_action_index, b_kind " +
                "FROM cross_chain_matches WHERE " + MATCH_REF_WHERE + " ORDER BY id DESC LIMIT 1",
                [btcSwapIndex, btcSwapIndex]));
            if (rows.length && rows[0].status === 'finalized') { match = rows[0]; break; }
            await mine(1);
            await sleep(3000);
        }
        expect(match, 'hub finalized a cross_chain_matches row for the BTC swap').to.be.an('object');
        const legs = [[match.a_chain, Number(match.a_action_index)], [match.b_chain, Number(match.b_action_index)]];
        expect(legs).to.deep.include(['BTC', btcSwapIndex]);
        expect(legs.map(l => l[0]).sort()).to.deep.equal(['BTC', 'DOGE']);
        // Phase A: both legs are swaps. a_kind/b_kind default to 'swap' when null.
        expect([match.a_kind || 'swap', match.b_kind || 'swap'], 'both legs matched as swaps (Phase A exact fill)')
            .to.deep.equal(['swap', 'swap']);
        console.log('    [swap-cross] hub finalized match ' + match.match_id + ' legs=' + JSON.stringify(legs));
    });

    it('the BTC indexer SETTLES the swap: full escrow released to the DOGE maker', async function () {
        // Wait for the mirrored match to reach the BTC indexer and cross_settle to release
        // the BTC leg's escrow. REQUIRES HubDbSync mirroring the relay hub's rows into the
        // BTC indexer (see header VENUE note); without it this times out.
        //
        // The consensus-correct "did this leg settle" signal is a row in the LOCAL
        // cross_chain_settlements table keyed on this swap's action_index (db.js derives
        // `settled` from that table, never from the mirrored match row).
        const deadline = Date.now() + 240000;
        let settlements = 0, payoutAmt = null;
        while (Date.now() < deadline) {
            await mine(1);
            await sleep(3000);
            settlements = await btcCount(
                "SELECT COUNT(*) n FROM cross_chain_settlements WHERE local_action_index = ?", [btcSwapIndex]);
            const bal = await btcIdx(
                'SELECT b.amount FROM balances b JOIN index_addresses a ON a.id=b.address_id ' +
                'JOIN index_tickers t ON t.id=b.tick_id WHERE a.address=? AND t.tick=? ' +
                'ORDER BY CAST(b.amount AS DECIMAL(60,0)) DESC LIMIT 1', [DOGE_MAKER_BTC_RECV, BTC_TICK]);
            payoutAmt = bal.length ? String(bal[0].amount) : null;
            if (settlements >= 1 && payoutAmt && payoutAmt !== '0') break;
        }

        expect(settlements, 'cross_chain_settlements row recorded for the BTC SWAP leg').to.be.greaterThan(0);
        expect(payoutAmt, 'DOGE maker BTC payout address credited the released escrow').to.be.a('string');
        // Phase A is an exact FULL-amount fill, so the whole escrow moves in one settlement.
        expect(payoutAmt, 'released escrow amount = full ' + SWAP_AMOUNT).to.equal(String(SWAP_AMOUNT));

        // A fully-filled SWAP drops out of the open book; the status must leave 'open'.
        const status = await btcSwapStatus(btcSwapIndex);
        expect(status, 'BTC swap left open after the full fill').to.not.equal('open');

        console.log('    [swap-cross] BTC leg SETTLED: settlements=' + settlements +
            ' payout ' + payoutAmt + ' ' + BTC_TICK + ' -> ' + DOGE_MAKER_BTC_RECV +
            ' (swap_status=' + status + ')');
    });

    it('(best-effort) the DOGE leg also settles out of open on the DOGE indexer', async function () {
        const deadline = Date.now() + 120000;
        let status = null;
        while (Date.now() < deadline) {
            const rows = await dogeIdx(async (c) => c.query(
                "SELECT s.status FROM swap_statuses ss JOIN index_statuses s ON s.id=ss.status_id " +
                "WHERE ss.swap_action_index=? ORDER BY ss.action_index DESC LIMIT 1", [DOGE_SWAP_INDEX]));
            status = rows.length ? rows[0].status : null;
            if (status && status !== 'open') break;
            await sleep(3000);
        }
        // Best-effort: the DOGE indexer must also be HubDbSync-subscribed for this to flip.
        // Log either way; do not fail the suite on the DOGE-leg mirror alone.
        if (status && status !== 'open') console.log('    [swap-cross] DOGE leg settled: swap ' + DOGE_SWAP_INDEX + ' -> ' + status);
        else console.log('    [swap-cross] DOGE leg still ' + status + ' (DOGE indexer HubDbSync mirror not confirmed this run)');
    });
});
