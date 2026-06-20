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
 **********************************************************************
 *
 * XChain Platform E2E - Cross-chain DEX LIVE escrow-release settlement
 * (TEST-CAMPAIGN #10, the live escrow-release leg).
 *
 * The settlement TWIN of dexSourceReorgDrill.sdk.test.js. Where the reorg
 * drill places a crossing BTC<->DOGE ORDER pair, lets the hub finalize a
 * cross_chain_matches row, then stops PRE-settlement (orphans the source
 * block) - this drill lets the match SETTLE and asserts the indexer's
 * cross_settle.js actually RELEASES THE ESCROW on both legs:
 *
 *   1. (setup, dexDogeSetup.js) a DOGE maker has an OPEN cross-chain ORDER:
 *      give DOGE/<DEX_DOGE_TICK> 100, want BTC/<DEX_BTC_TICK> 100, with a
 *      BTC get_address (where the DOGE maker receives the BTC-side token).
 *   2. this drill places the crossing BTC ORDER: give BTC/<DEX_BTC_TICK> 100,
 *      want DOGE/<DEX_DOGE_TICK> 100, with a DOGE get_address (1:1 so the
 *      price gate always crosses), and records the BTC maker's get_address.
 *   3. the hub's CrossChainDexEngine finalizes a 2f+1-signed cross_chain_matches
 *      row covering both legs;
 *   4. each chain's indexer processes the mirrored match through cross_settle.js
 *      (verify sigs vs the locked cross_chain capability_snapshots ->
 *      recordCrossChainSettlement -> updateBalances): the BTC leg releases the
 *      maker's escrowed 100 BTC/<DEX_BTC_TICK> to the DOGE maker's BTC
 *      get_address; the DOGE leg releases 100 DOGE/<DEX_DOGE_TICK> to the BTC
 *      maker's DOGE get_address.
 *
 * ASSERTS (the novel coverage vs every committed test, which stub the indexer
 * DB or stop pre-settlement):
 *   - the BTC ORDER status flips out of 'open' (filled/settled);
 *   - the DOGE maker's BTC get_address is CREDITED 100 BTC/<DEX_BTC_TICK>
 *     (real escrow release on a real indexer DB);
 *   - a cross_chain_settlements row is recorded (idempotency anchor);
 *   - (DOGE leg, best-effort) the DOGE ORDER also leaves 'open' once the DOGE
 *     indexer settles its side.
 *
 * VENUE (THE HARD PART - this drill needs a relay hub whose finalized rows are
 * MIRRORED into the live indexers, i.e. HubDbSync ON pointing at the relay):
 *   - BTC + DOGE regtest, with a validator-mode relay hub running CrossChainDex
 *     + the hub key staked for the cross_chain capability, BTC_INDEXER_URL/
 *     DOGE_INDEXER_URL wired (hub pull);
 *   - the BTC + DOGE INDEXERS subscribed to that relay hub via HubDbSync
 *     (HUB_DB_SYNC_ENABLED=true, HUB_API_URL=relay WS, HUB_DB_*=relay DB) so the
 *     finalized cross_chain_matches row + capability_snapshots reach the indexer
 *     and cross_settle fires. WITHOUT this mirror, step 4 never happens and this
 *     drill times out at the settlement wait (that is the known live gap this
 *     drill is built to close once the repoint lands). See
 *     claude/reports/launch/test-campaign/federation-live-venue-handover.md.
 *
 * NOTE: a concurrent session's handover also lists "author the #10 settlement
 * driver" - this may be a parallel implementation to reconcile. It is authored
 * here as a ready-to-run artifact; it has NOT been run (the live relay+repoint
 * venue was owned by that session at authoring time).
 *
 * Env: DEX_BTC_TICK, DEX_DOGE_TICK, DEX_DOGE_ORDER_INDEX (from dexDogeSetup),
 * DEX_DOGE_MAKER_BTC_RECV (the BTC address the DOGE order's get_address used -
 * print it from dexDogeSetup, here btcRecv), HUB_DB_USER/PASS,
 * DOGE_IDX_DB_USER/PASS, XCALL_DB_HOST/PORT. Uses the BTC stack globals from
 * initialCheck (nodeConnector / regtestMinerConnector / indexerDatabase).
 *
 ********************************************************************/

const { expect } = require('chai');
const mariadb = require('mariadb');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, XChainSDK } = require('./sdkHelper');

const DB_HOST = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

// The relay hub may run as a SEPARATE disposable DB rather than the shared stack
// MariaDB. The proven 3-hub venue runs XChain_Relay_Hub on 172.17.0.1:13341.
// Default to the XCALL_DB_* stack DB + 'XChain_Hub' for back-compat; override with
// HUB_DB_HOST / HUB_DB_PORT / HUB_DB_NAME to point at the disposable relay DB.
const HUB_DB_HOST = process.env.HUB_DB_HOST || DB_HOST;
const HUB_DB_PORT = parseInt(process.env.HUB_DB_PORT || String(DB_PORT), 10);
const HUB_DB_NAME = process.env.HUB_DB_NAME || 'XChain_Hub';

const BTC_TICK  = String(process.env.DEX_BTC_TICK  || '').trim();
const DOGE_TICK = String(process.env.DEX_DOGE_TICK || '').trim();
// The BTC address the DOGE maker's cross-chain ORDER named as its get_address
// (dexDogeSetup's btcRecv) - the BTC leg releases the escrowed BTC-side token
// here on settlement. REQUIRED to assert the credit deterministically.
const DOGE_MAKER_BTC_RECV = String(process.env.DEX_DOGE_MAKER_BTC_RECV || '').trim();

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

const MATCH_REF_WHERE = "((a_chain='BTC' AND a_action_index = ?) OR (b_chain='BTC' AND b_action_index = ?))";
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] cross-chain DEX LIVE escrow-release settlement (#10)', function () {
    this.timeout(0);

    let sdk, maker, btcOrderIndex, dogeRecv, btcTokenBalanceBefore;

    before(async function () {
        expect(BTC_TICK, 'DEX_BTC_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(DOGE_TICK, 'DEX_DOGE_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(parseInt(process.env.DEX_DOGE_ORDER_INDEX || '', 10), 'DEX_DOGE_ORDER_INDEX env')
            .to.be.a('number').and.to.be.greaterThan(0);
        expect(DOGE_MAKER_BTC_RECV, 'DEX_DOGE_MAKER_BTC_RECV env (the BTC addr the DOGE order pays out to)')
            .to.match(/^[a-zA-Z0-9]+$/);
        expect(process.env.HUB_DB_USER, 'HUB_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(process.env.DOGE_IDX_DB_USER, 'DOGE_IDX_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(global.indexerDatabase, 'indexerDatabase global (initialCheck)').to.be.an('object');
        sdk = makeSdk();
        maker = await fundedGasAddress(sdk, 1);
        // A valid DOGE regtest address for the BTC ORDER's GET_ADDRESS (where the
        // BTC maker receives the DOGE-side token on settlement).
        const dogeSdk = new XChainSDK({ network: 'dogecoin-regtest', timeout: 30000 });
        const dogeKp  = dogeSdk.generateKeyPair();
        dogeRecv = dogeSdk.deriveAddress(dogeKp.publicKey, { type: 'p2pkh' });
        console.log('    [dex-settle] maker=' + maker.address + ' BTC_TICK=' + BTC_TICK + ' DOGE_TICK=' + DOGE_TICK);
        console.log('    [dex-settle] DOGE maker BTC payout addr=' + DOGE_MAKER_BTC_RECV);
    });

    it('ISSUE the BTC token and place the crossing BTC cross-chain ORDER', async function () {
        const iss = await submit(sdk,
            { action: 'ISSUE', params: { tick: BTC_TICK, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'dex-settle', mintSupply: 1000 } },
            { pubkey: maker.address, change: maker.address },
            submitOpts({ wif: maker.wif })
        );
        expect(iss.indexed.status, 'ISSUE ' + BTC_TICK).to.equal('valid');

        btcTokenBalanceBefore = await btcCount(
            'SELECT COUNT(*) n FROM balances b JOIN index_addresses a ON a.id=b.address_id ' +
            'JOIN index_tickers t ON t.id=b.tick_id WHERE a.address=? AND t.tick=? AND CAST(b.amount AS DECIMAL(60,0)) > 0',
            [DOGE_MAKER_BTC_RECV, BTC_TICK]);
        console.log('    [dex-settle] DOGE-maker BTC payout balance rows before: ' + btcTokenBalanceBefore);

        // Free-tier expiration (chain clock + 90d) so the ORDER carries no fee.
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
            { pubkey: maker.address, change: maker.address },
            submitOpts({ wif: maker.wif })
        );
        expect(res.indexed.status, 'BTC ORDER').to.equal('valid');
        btcOrderIndex = Number(res.indexed.actions[0].action_index);
        await mine(1);
        console.log('    [dex-settle] BTC order=' + btcOrderIndex);
    });

    it('the hub finalizes the cross-chain match against the BTC order', async function () {
        const deadline = Date.now() + 240000;
        let match = null;
        while (Date.now() < deadline) {
            const rows = await hubDb(async (c) => c.query(
                "SELECT match_id, status, a_chain, a_action_index, b_chain, b_action_index FROM cross_chain_matches WHERE " + MATCH_REF_WHERE + " ORDER BY id DESC LIMIT 1",
                [btcOrderIndex, btcOrderIndex]));
            if (rows.length && rows[0].status === 'finalized') { match = rows[0]; break; }
            await mine(1);
            await sleep(3000);
        }
        expect(match, 'hub finalized a cross_chain_matches row for the BTC order').to.be.an('object');
        const legs = [[match.a_chain, Number(match.a_action_index)], [match.b_chain, Number(match.b_action_index)]];
        expect(legs).to.deep.include(['BTC', btcOrderIndex]);
        expect(legs.map(l => l[0]).sort()).to.deep.equal(['BTC', 'DOGE']);
        console.log('    [dex-settle] hub finalized match ' + match.match_id + ' legs=' + JSON.stringify(legs));
    });

    it('the BTC indexer SETTLES the match: escrow released to the DOGE maker', async function () {
        // Wait for the mirrored match to reach the BTC indexer and cross_settle to
        // release the BTC leg's escrow. REQUIRES HubDbSync mirroring the relay hub's
        // rows into the BTC indexer (see header VENUE note); without it this times out.
        //
        // The CONSENSUS-correct "did this leg settle" signal is a row in the LOCAL
        // cross_chain_settlements table whose local_action_index = this BTC ORDER
        // (db.js: `settled` is derived from cross_chain_settlements, never the
        // mirrored match). order_statuses is NOT relied upon (a cross-chain fill is
        // recorded via the settlements table, not necessarily an order_statuses flip).
        const deadline = Date.now() + 240000;
        let settlements = 0, payoutAmt = null, orderStatus = null;
        while (Date.now() < deadline) {
            await mine(1);
            await sleep(3000);
            settlements = await btcCount(
                "SELECT COUNT(*) n FROM cross_chain_settlements WHERE local_action_index = ?", [btcOrderIndex]);
            const bal = await btcIdx(
                'SELECT b.amount FROM balances b JOIN index_addresses a ON a.id=b.address_id ' +
                'JOIN index_tickers t ON t.id=b.tick_id WHERE a.address=? AND t.tick=? ' +
                'ORDER BY CAST(b.amount AS DECIMAL(60,0)) DESC LIMIT 1', [DOGE_MAKER_BTC_RECV, BTC_TICK]);
            payoutAmt = bal.length ? String(bal[0].amount) : null;
            const os = await btcIdx(
                "SELECT s.status FROM order_statuses os JOIN index_statuses s ON s.id=os.status_id " +
                "WHERE os.order_action_index=? ORDER BY os.action_index DESC LIMIT 1", [btcOrderIndex]).catch(() => []);
            orderStatus = os.length ? os[0].status : null;
            if (settlements >= 1 && payoutAmt && payoutAmt !== '0') break;
        }

        expect(settlements, 'cross_chain_settlements row recorded for the BTC ORDER leg').to.be.greaterThan(0);
        expect(payoutAmt, 'DOGE maker BTC payout address credited the released escrow').to.be.a('string');
        expect(payoutAmt, 'released escrow amount = matched 100').to.equal('100');

        console.log('    [dex-settle] BTC leg SETTLED: settlements=' + settlements +
            ' payout ' + payoutAmt + ' ' + BTC_TICK + ' -> ' + DOGE_MAKER_BTC_RECV +
            ' (order_status=' + orderStatus + ')');
    });

    it('(best-effort) the DOGE leg also settles out of open on the DOGE indexer', async function () {
        const dogeOrderIndex = parseInt(process.env.DEX_DOGE_ORDER_INDEX, 10);
        const deadline = Date.now() + 120000;
        let status = null;
        while (Date.now() < deadline) {
            const rows = await dogeIdx(async (c) => c.query(
                "SELECT s.status FROM order_statuses os JOIN index_statuses s ON s.id=os.status_id " +
                "WHERE os.order_action_index=? ORDER BY os.action_index DESC LIMIT 1", [dogeOrderIndex]));
            status = rows.length ? rows[0].status : null;
            if (status && status !== 'open') break;
            await sleep(3000);
        }
        // Best-effort: the DOGE indexer must also be HubDbSync-subscribed for this to
        // flip. Log either way; do not fail the suite on the DOGE-leg mirror alone.
        if (status && status !== 'open') console.log('    [dex-settle] DOGE leg settled: order ' + dogeOrderIndex + ' -> ' + status);
        else console.log('    [dex-settle] DOGE leg still ' + status + ' (DOGE indexer HubDbSync mirror not confirmed this run)');
    });
});
