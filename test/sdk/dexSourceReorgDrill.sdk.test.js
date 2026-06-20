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
 * XChain Platform E2E - Cross-chain DEX MATCH source-chain reorg retraction
 *
 * The DEX twin of xcallSourceReorgDrill.sdk.test.js. Where the XCALL drill
 * proves a source-chain reorg retracts an in-flight cross_chain_calls dispatch,
 * this drill proves the same for a finalized cross_chain_matches row:
 *
 *   indexer rollback.js -> hub_client.retractMatchRange(coin, firstActionIndex)
 *     -> hub pushdexreorg -> CrossChainDexEngine.retractMatchesForReorg:
 *        marks cross_chain_matches rows referencing the reorged chain's rolled-
 *        back ORDER (a_chain/a_action_index OR b_chain/b_action_index) as
 *        status='retracted', restores both legs' remaining capacity, and
 *        broadcasts a deletion; mirroring indexers DELETE their local copy so a
 *        source-chain reorg never leaves an orphaned 'finalized' match eligible
 *        for settlement against an ORDER that no longer exists.
 *
 * Setup (done by dexDogeSetup.js before this runs): a DOGE maker has an OPEN
 * cross-chain ORDER giving DOGE/<DEX_DOGE_TICK> 100, wanting BTC/<DEX_BTC_TICK>
 * 100. This drill places the crossing BTC ORDER (give BTC/<DEX_BTC_TICK> 100,
 * want DOGE/<DEX_DOGE_TICK> 100, 1:1 so the price gate always crosses), waits
 * for the hub's CrossChainDexEngine poll to finalize the match, then orphans the
 * BTC block carrying the BTC ORDER and asserts:
 *   - hub: the match row -> status='retracted' (not deleted; audit continuity);
 *   - source BTC indexer: the orders row + its cross_chain_matches mirror gone;
 *   - target DOGE indexer: the cross_chain_matches mirror gone.
 *
 * SHALLOW/pre-settlement case: exactly like the XCALL source-reorg drill, the
 * scope is the retraction path (retractMatchRange + pushdexreorg), not deep
 * settlement reversal.
 *
 * VENUE: BTC + DOGE regtest with the hub in validator mode (CrossChainDexEngine
 * auto-starts: peerManager present), the hub2 key staked for the cross_chain
 * capability, BTC_INDEXER_URL/DOGE_INDEXER_URL wired (hub pull), and the BTC
 * indexer's HUB_API_URL wired (retraction push). Identical wiring to the XCALL
 * source-reorg venue; no DEX-specific config is needed.
 *
 * Env: DEX_BTC_TICK, DEX_DOGE_TICK, DEX_DOGE_ORDER_INDEX (from dexDogeSetup),
 * HUB_DB_USER/PASS, DOGE_IDX_DB_USER/PASS, XCALL_DB_HOST/PORT. Uses the BTC
 * stack globals from initialCheck (nodeConnector / regtestMinerConnector /
 * indexerDatabase) for the source-chain reorg, exactly like the XCALL drill.
 *
 ********************************************************************/

const { expect } = require('chai');
const mariadb = require('mariadb');
const cryptoHelper = require('../cryptoHelper');
const { makeSdk, submit, fundedGasAddress, mine, submitOpts, XChainSDK } = require('./sdkHelper');

const DB_HOST = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

const BTC_TICK  = String(process.env.DEX_BTC_TICK || '').trim();
const DOGE_TICK = String(process.env.DEX_DOGE_TICK || '').trim();

async function withConn(database, user, password, fn) {
    const conn = await mariadb.createConnection({ host: DB_HOST, port: DB_PORT, database, user, password });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
async function hubDb(fn)   { return withConn('XChain_Hub', process.env.HUB_DB_USER, process.env.HUB_DB_PASS, fn); }
async function dogeIdx(fn) { return withConn('XChain_DOGE_Regtest_Indexer', process.env.DOGE_IDX_DB_USER, process.env.DOGE_IDX_DB_PASS, fn); }

async function btcIdx(sql, params) {
    const db = global.indexerDatabase;
    const conn = await db.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}
async function btcCount(sql, params) { return Number((await btcIdx(sql, params))[0].n); }

const MATCH_REF_WHERE = "((a_chain='BTC' AND a_action_index = ?) OR (b_chain='BTC' AND b_action_index = ?))";
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('[sdk] cross-chain DEX match source-chain reorg retraction (pre-settlement)', function () {
    this.timeout(0);

    let sdk, maker, btcOrderIndex, srcBlock, dogeRecv;
    // Pre-reorg indexer match-mirror counts. The hub->indexer DB mirror (HubDbSync)
    // is only active when HUB_DB_SYNC_ENABLED=true on the indexer; a single-hub
    // regtest venue (like this one and the XCALL drill's) runs it OFF to avoid the
    // match/call/snapshot barriers, so indexers don't mirror cross_chain_matches.
    // We capture the pre-reorg counts and assert the broadcast-deletion only when
    // the mirror was actually populated, so the drill validates the full path under
    // HubDbSync and the hub-only retraction (the consensus property) without it.
    let btcMirrorBefore = 0, dogeMirrorBefore = 0;

    before(async function () {
        expect(BTC_TICK, 'DEX_BTC_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(DOGE_TICK, 'DEX_DOGE_TICK env').to.match(/^[A-Z0-9]{1,12}$/);
        expect(parseInt(process.env.DEX_DOGE_ORDER_INDEX || '', 10), 'DEX_DOGE_ORDER_INDEX env')
            .to.be.a('number').and.to.be.greaterThan(0);
        expect(process.env.HUB_DB_USER, 'HUB_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(process.env.DOGE_IDX_DB_USER, 'DOGE_IDX_DB_USER env').to.be.a('string').and.to.not.equal('');
        expect(global.nodeConnector, 'nodeConnector global (initialCheck)').to.be.an('object');
        expect(global.indexerDatabase, 'indexerDatabase global (initialCheck)').to.be.an('object');
        sdk = makeSdk();
        maker = await fundedGasAddress(sdk, 1);
        // A valid DOGE regtest address for the BTC ORDER's GET_ADDRESS.
        const dogeSdk = new XChainSDK({ network: 'dogecoin-regtest', timeout: 30000 });
        const dogeKp  = dogeSdk.generateKeyPair();
        dogeRecv = dogeSdk.deriveAddress(dogeKp.publicKey, { type: 'p2pkh' });
        console.log('    [dex-srcreorg] maker=' + maker.address + ' BTC_TICK=' + BTC_TICK + ' DOGE_TICK=' + DOGE_TICK);
    });

    it('ISSUE the BTC token and place the crossing BTC cross-chain ORDER', async function () {
        const iss = await submit(sdk,
            { action: 'ISSUE', params: { tick: BTC_TICK, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'dex-reorg', mintSupply: 1000 } },
            { pubkey: maker.address, change: maker.address },
            submitOpts({ wif: maker.wif })
        );
        expect(iss.indexed.status, 'ISSUE ' + BTC_TICK).to.equal('valid');

        // Anchor expiration to the BTC chain clock + 90 days = the free tier, so
        // the ORDER carries no protocol fee.
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

        srcBlock = Number((await btcIdx('SELECT block_index FROM actions WHERE action_index = ? LIMIT 1', [btcOrderIndex]))[0].block_index);
        expect(srcBlock, 'BTC ORDER indexed block').to.be.a('number').and.to.be.greaterThan(0);
        console.log('    [dex-srcreorg] BTC order=' + btcOrderIndex + ' at block ' + srcBlock);
    });

    it('the hub finalizes the cross-chain match against the BTC order', async function () {
        // Wait for the CrossChainDexEngine poll (default 15s) to cross the BTC
        // ORDER against the DOGE ORDER and finalize a match row on the hub.
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
        console.log('    [dex-srcreorg] hub finalized match ' + match.match_id + ' legs=' + JSON.stringify(legs));

        // Record whether the indexers mirror the finalized match (only when HubDbSync
        // is enabled). Poll briefly; on a single-hub regtest venue these stay 0.
        const mdl = Date.now() + 30000;
        while (Date.now() < mdl) {
            btcMirrorBefore  = await btcCount("SELECT COUNT(*) n FROM cross_chain_matches WHERE " + MATCH_REF_WHERE, [btcOrderIndex, btcOrderIndex]);
            dogeMirrorBefore = await dogeIdx(async (c) => Number((await c.query(
                "SELECT COUNT(*) n FROM cross_chain_matches WHERE " + MATCH_REF_WHERE, [btcOrderIndex, btcOrderIndex]))[0].n));
            if (btcMirrorBefore >= 1 && dogeMirrorBefore >= 1) break;
            await sleep(2000);
        }
        console.log('    [dex-srcreorg] indexer match mirrors: BTC=' + btcMirrorBefore + ' DOGE=' + dogeMirrorBefore +
            (btcMirrorBefore || dogeMirrorBefore ? '' : ' (HubDbSync disabled: mirror-deletion not exercised this run)'));
    });

    it('orphaning the source block retracts the match and deletes both mirrors', async function () {
        const node  = global.nodeConnector;
        const miner = global.regtestMinerConnector;

        // Pause auto-mining so the orphaned ORDER tx cannot be re-mined from the
        // mempool, then build an EMPTY competing chain longer than the original
        // tip (same mechanism as reorgBalances.test.js / the XCALL src-reorg drill).
        await miner.setMiningTime(3600000, 3600000);
        try {
            const tipBefore = await node.getBlockCount();
            const srcHash   = await node.getBlockHash(srcBlock);
            const payout    = (await cryptoHelper.getNewAddress('dex-srcreorg-miner', COIN, NETWORK, null, 'legacy', 0)).address;

            await node.invalidateBlock(srcHash);
            expect(await node.getBlockCount(), 'node rolled back below the ORDER block').to.equal(srcBlock - 1);

            const need = tipBefore - (srcBlock - 1) + 2;
            for (let i = 0; i < need; i++) await node.generateBlock(payout, []);
            expect(await node.getBlockCount(), 'competing chain overtakes the original tip').to.be.greaterThan(tipBefore);
            expect(await node.getBlockHash(srcBlock), 'the chain actually reorged').to.not.equal(srcHash);
            console.log('    [dex-srcreorg] BTC reorged onto an empty branch; waiting for rollback.js + hub retraction');

            // Wait for node -> decoder -> indexer rollback -> retractMatchRange (queued
            // via HubPushQueue) -> hub retractMatchesForReorg -> status='retracted'.
            const deadline = Date.now() + 180000;
            let hubStatus = null, btcOrderRows = -1, btcMirror = -1, dogeMirror = -1;
            while (Date.now() < deadline) {
                await sleep(3000);
                const hr = await hubDb(async (c) => c.query(
                    "SELECT status FROM cross_chain_matches WHERE " + MATCH_REF_WHERE + " ORDER BY id DESC LIMIT 1",
                    [btcOrderIndex, btcOrderIndex]));
                hubStatus    = hr.length ? hr[0].status : null;
                btcOrderRows = await btcCount('SELECT COUNT(*) n FROM orders WHERE action_index = ?', [btcOrderIndex]);
                btcMirror    = await btcCount("SELECT COUNT(*) n FROM cross_chain_matches WHERE " + MATCH_REF_WHERE, [btcOrderIndex, btcOrderIndex]);
                dogeMirror   = await dogeIdx(async (c) => Number((await c.query(
                    "SELECT COUNT(*) n FROM cross_chain_matches WHERE " + MATCH_REF_WHERE, [btcOrderIndex, btcOrderIndex]))[0].n));
                if (hubStatus === 'retracted' && btcOrderRows === 0) break;
            }

            // PRIMARY (consensus property): the hub keeps the row for audit but flips it
            // to 'retracted', so it is no longer eligible for settlement.
            expect(hubStatus, 'hub match row marked retracted').to.equal('retracted');

            expect(btcOrderRows, 'source orders row removed by rollback').to.equal(0);

            // CONDITIONAL: the broadcast-deletion is only observable where the indexer
            // mirrored the match (HubDbSync on). Assert deletion only if it was present.
            if (btcMirrorBefore > 0)
                expect(btcMirror, 'source cross_chain_matches mirror deleted').to.equal(0);
            if (dogeMirrorBefore > 0)
                expect(dogeMirror, 'target cross_chain_matches mirror deleted').to.equal(0);

            console.log('    [dex-srcreorg] retracted cleanly: hub=retracted, BTC order rolled back' +
                (btcMirrorBefore || dogeMirrorBefore
                    ? ' (mirrors deleted: BTC=' + (btcMirror === 0) + ' DOGE=' + (dogeMirror === 0) + ')'
                    : ' (indexer mirrors n/a: HubDbSync off)'));
        } finally {
            await miner.setDefaultMiningTime();
        }
    });
});
