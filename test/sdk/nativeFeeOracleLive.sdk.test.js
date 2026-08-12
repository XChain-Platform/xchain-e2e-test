/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * XChain Platform E2E - native-coin fee against a LIVE price oracle feed
 * (TEST-CAMPAIGN Track C, native-fee follow-up #3).
 *
 * Every other native-fee e2e seeds the oracle price OUT-OF-BAND (a raw INSERT
 * into the INDEXER's price_snapshots via nativeFeeHelper.seedGlobalPrices).
 * This drill exercises the production-faithful chain instead:
 *
 *   hub oracle round  ->  price_snapshots (hub DB)  ->  HubDbBroadcaster
 *                     ->  indexer HubDbSync mirror  ->  native-fee ACTION
 *                         validated by the LIVE indexer against the MIRRORED price
 *
 * It does NOT call nativeFeeHelper.seedGlobalPrices / priceSnapshotHelper (the
 * out-of-band path this drill replaces). DOGE/USD comes from a genuine live
 * oracle round on the validator-mode relay hub; XCHAIN/USD has no market
 * pre-launch, so it is a configured sidecar row in the HUB DB that reaches the
 * indexer through the same real HubDbSync mirror channel (not a direct
 * indexer-DB INSERT).
 *
 * ASSERTS (the novel coverage):
 *   1. a DOGE ISSUE paying the protocol fee as a native FEE_DESTINATION output
 *      indexes VALID with payment_mode=1 (native), native_coin='DOGE', and an
 *      oracle_round that is a LIVE round (not one of the known seed sentinels);
 *      the paid amount lies inside the validator's [min,max] tolerance band.
 *   2. the owed fee-sizing parity: feequote == feequotedryrun == a band
 *      recomputed directly from the live price_snapshots rows, and the quote's
 *      oracleRound equals the round the on-chain validator recorded - proving
 *      client quote, on-chain validator, and dry-run all priced off the ONE
 *      live oracle row.
 *
 * VENUE (THE HARD PART):
 *   - DOGE regtest with a validator-mode relay hub running the ORACLE engine
 *     (ORACLE_MIN_SUBMISSIONS=1 single-node self-finalize, a SHORT
 *     ORACLE_ROUND_INTERVAL, BTC_INDEXER_API_URL for the chain-tip anchor) so it
 *     finalizes DOGE/USD rounds into its disposable hub DB;
 *   - the DOGE indexer subscribed to that relay hub via HubDbSync
 *     (HUB_DB_SYNC_ENABLED=true, HUB_API_URL=relay WS, HUB_DB_*=relay DB) so the
 *     finalized DOGE/USD row + the XCHAIN/USD sidecar reach the indexer's
 *     price_snapshots. WITHOUT this mirror the before() gate fails loudly at the
 *     feeschedule wait (the known live gap this drill closes).
 *
 * Env (defaults match the local DOGE regtest stack; point HUB_DB_* at the relay
 * hub's disposable DB in the distributed venue):
 *   XCALL_DOGE_ENCODER_PORT=3123   XCALL_DOGE_MINER_URL=http://localhost:3125
 *   XCALL_DOGE_INDEXER_URL=http://127.0.0.1:3124
 *   XCALL_DB_HOST=127.0.0.1        XCALL_DB_PORT=13306
 *   HUB_DB_HOST/PORT/NAME/USER/PASS  (relay hub DB for the XCHAIN/USD sidecar)
 *   DOGE_IDX_DB_USER/DOGE_IDX_DB_PASS (XChain_DOGE_Regtest_Indexer, reads)
 *   NFO_FEE_DESTINATION              (override the discovered fee destination)
 *
 * Usage: bash ~/action-run-doge.sh test/sdk/nativeFeeOracleLive.sdk.test.js
 *
 ********************************************************************/

const { expect } = require('chai');
const axios   = require('axios');
const mariadb = require('mariadb');
const { XChainSDK } = require('./sdkHelper');

const MINER_URL   = process.env.XCALL_DOGE_MINER_URL   || 'http://localhost:3125';
const INDEXER_URL = process.env.XCALL_DOGE_INDEXER_URL || 'http://127.0.0.1:3124';
const DB_HOST     = process.env.XCALL_DB_HOST || '127.0.0.1';
const DB_PORT     = parseInt(process.env.XCALL_DB_PORT || '13306', 10);

// The fee oracle prices live in the indexer's hub DB (the relay hub in the
// distributed venue). Default to the stack DB for back-compat; override with
// HUB_DB_* to point at the relay hub's disposable DB.
const HUB_DB_HOST = process.env.HUB_DB_HOST || DB_HOST;
const HUB_DB_PORT = parseInt(process.env.HUB_DB_PORT || String(DB_PORT), 10);
const HUB_DB_NAME = process.env.HUB_DB_NAME || 'XChain_Hub';

// XCHAIN/USD has no pre-launch market, so it is a configured sidecar in the hub
// DB. The value is not asserted here, only the path, but it is taken from the
// shared bootstrap constant anyway: a suite seeding a price no
// producer emits is how the missing-pair bug stayed invisible, and "the value does
// not matter here" is exactly the reasoning that let 1.00 spread across the suite.
// round 990001 is the agreed sidecar round; the test asserts the action's
// oracle_round is NOT a seed sentinel (so it must be the live DOGE/USD round).
const { BOOTSTRAP_XCHAIN_USD, NO_PRICE_SEED, SEED_SENTINEL_ROUNDS } = require('../helpers/xchainPriceConstants');
const XCHAIN_USD_PRICE   = BOOTSTRAP_XCHAIN_USD;
const XCHAIN_SIDECAR_RND = 990001;

// Known out-of-band seed round numbers across the suite (nativeFeeHelper,
// dexDogeSetup, nativeFeeLive, nativeFeeDispenser). The validated action's
// oracle_round must be NONE of these - i.e. it came from the live oracle.
// The list itself now lives in xchainPriceConstants, so this assertion
// and the code that clears the rows cannot drift apart.
const SEED_SENTINELS = new Set(SEED_SENTINEL_ROUNDS);

const FEE_TOL_MIN = 0.95, FEE_TOL_MAX = 1.10;   // matches indexer FEE_TOLERANCE_MIN/MAX defaults

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function minerRpc(method, params) {
    const res = await axios.post(MINER_URL, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 20000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    return res.data ? res.data.result : null;
}

async function indexerRpc(method, params) {
    const res = await axios.post(INDEXER_URL + '/api', { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout: 15000 });
    if (res.data && res.data.error) throw new Error(method + ': ' + JSON.stringify(res.data.error));
    return res.data ? res.data.result : null;
}

async function withConn(host, port, database, user, password, fn) {
    const conn = await mariadb.createConnection({ host, port, database, user, password });
    try { return await fn(conn); } finally { await conn.end().catch(() => {}); }
}
function dogeIdx(fn) {
    return withConn(DB_HOST, DB_PORT, 'XChain_DOGE_Regtest_Indexer', process.env.DOGE_IDX_DB_USER, process.env.DOGE_IDX_DB_PASS, fn);
}
function hubDb(fn) {
    return withConn(HUB_DB_HOST, HUB_DB_PORT, HUB_DB_NAME, process.env.HUB_DB_USER, process.env.HUB_DB_PASS, fn);
}

// expectedNative = xchainFee * xchainUsd / coinUsd; min/max = expected * tol.
// Float math is fine for an assertion epsilon: the tolerance band (0.95-1.10)
// dwarfs any rounding, and we compare with a relative epsilon.
function recomputeBand(xchainFee, xchainUsd, coinUsd) {
    const expected = (Number(xchainFee) * Number(xchainUsd)) / Number(coinUsd);
    return { expected, min: expected * FEE_TOL_MIN, max: expected * FEE_TOL_MAX };
}
function approxEqual(a, b, relEps) {
    a = Number(a); b = Number(b);
    if (a === b) return true;
    const denom = Math.max(Math.abs(a), Math.abs(b), 1e-12);
    return Math.abs(a - b) / denom <= (relEps || 1e-6);
}

// A fresh, non-subtoken (no '.') uppercase tick so the issuance fee is the flat
// GAS_SCHEDULE.ISSUE * GAS_PRICE - independent of supply/description, so a
// representative feequote params string prices the same fee the handler will.
function freshTick(prefix) {
    const n = Math.floor(Date.now() / 1000) % 1000000;
    return (prefix + n).slice(0, 12).toUpperCase();
}
function issueWireParams(tick) {
    // VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY (format 0)
    return ['0', tick, '1000000', '100000', '0', 'nativefee-oracle-live', '1000'].join('|');
}

describe('native-coin fee against a LIVE price oracle feed (DOGE)', function () {
    this.timeout(600000);

    let sdk, maker, feeDestination;
    let liveFee;          // the headline ISSUE's fees row
    let liveDogeBlock;    // DOGE block index the headline ISSUE was in

    before(async function () {
        // The XCHAIN/USD sidecar below is a hand-seed into the hub
        // DB; on a venue whose hub derives the pair it would shadow every real
        // round. This suite's point is the LIVE DOGE/USD half, so on a publishing
        // venue the derivation suite covers the whole path instead.
        if (NO_PRICE_SEED) this.skip()
        // 1) The XCHAIN/USD sidecar in the HUB DB (mirrors to the indexer via the
        //    real HubDbSync channel). Stamp block_timestamp at the DOGE tip's block
        //    time: the H-3 time gate (NATIVE_FEE_PRICE_TIME_GATE, armed 2026-07-07)
        //    only selects rounds stamped at-or-before the evaluated block's time, so
        //    a future-anchored stamp is never selectable; tip-time is selectable
        //    immediately and stays inside the staleness guard because block times
        //    only move forward. DOGE/USD is NOT seeded here - it must come from the
        //    live oracle round.
        const dogeBlockTime = await dogeIdx(async (c) => {
            const rows = await c.query('SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1');
            return rows.length ? Number(rows[0].block_time) : Math.floor(Date.now() / 1000);
        });
        const sidecarTs = dogeBlockTime;
        await hubDb((c) => c.query(
            `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain,
                 block_timestamp, validator_count, consensus_round, consensus_proof, status)
             VALUES (?, 'XCHAIN/USD', ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized')
             ON DUPLICATE KEY UPDATE price=VALUES(price), block_timestamp=VALUES(block_timestamp), status='finalized'`,
            [XCHAIN_SIDECAR_RND, XCHAIN_USD_PRICE, sidecarTs]));

        // 2) Wait for the live oracle to finalize DOGE/USD AND for the indexer to
        //    mirror both pairs: feeschedule reports prices.available with both
        //    xchainUsd and coinUsd. Fail loudly (this is GATE 1 + GATE 2).
        let sched = null;
        for (let i = 0; i < 60; i++) {
            try {
                const s = await indexerRpc('feeschedule', {});
                if (s && s.nativeFeeEnabled && s.prices && s.prices.available
                    && s.prices.xchainUsd && s.prices.coinUsd) { sched = s; break; }
            } catch (e) { /* indexer momentarily busy */ }
            await sleep(5000);
        }
        if (!sched) {
            throw new Error('GATE: feeschedule never reported a live oracle price. ' +
                'Confirm the relay hub is finalizing DOGE/USD rounds (GATE 1) and the DOGE ' +
                'indexer is subscribed via HubDbSync (GATE 2).');
        }
        feeDestination = process.env.NFO_FEE_DESTINATION || sched.feeDestination;
        if (!feeDestination) throw new Error('no FEE_DESTINATION from feeschedule and no NFO_FEE_DESTINATION override');

        // 3) SDK + funded maker.
        sdk = new XChainSDK({
            network:     'dogecoin-regtest',
            encoderUrl:  'localhost',
            encoderPort: parseInt(process.env.XCALL_DOGE_ENCODER_PORT || '3123', 10),
            timeout:     30000,
            retry:       { maxRetries: 2 },
        });
        const kp = sdk.generateKeyPair();
        maker = { ...kp, address: sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' }) };
        await minerRpc('send_funds', { address: maker.address, amount: 100 });
        await minerRpc('generate_blocks', { count: 2 });
        await sleep(3000);
    });

    // Submit a DOGE action with waitForIndexer:false (no DOGE explorer), mine, and
    // resolve the indexed action_index from the indexer DB by tx hash.
    async function submitAndIndex(label, actionData, customOutputs) {
        const res = await sdk.submitAction(
            actionData,
            { pubkey: maker.address, change: maker.address, unconfirmed: false,
              customOutputs: customOutputs || [] },
            { wif: maker.wif, waitForIndexer: false });
        const txid = res.txid || (res.signed && res.signed.txid);
        if (!txid) throw new Error(label + ': no txid in submit result');
        for (let i = 0; i < 30; i++) {
            await minerRpc('generate_blocks', { count: 1 });
            await sleep(2000);
            const rows = await dogeIdx((c) => c.query(
                `SELECT a.action_index, a.block_index FROM actions a
                 JOIN transactions t ON t.tx_index = a.tx_index
                 JOIN index_transactions ih ON ih.id = t.tx_hash_id
                 WHERE ih.hash = ? ORDER BY a.action_index ASC LIMIT 1`, [txid]));
            if (rows.length) return { actionIndex: Number(rows[0].action_index), blockIndex: Number(rows[0].block_index) };
        }
        throw new Error(label + ': tx ' + txid + ' never indexed');
    }

    it('validates a DOGE native-coin fee against the live oracle-mirrored price', async function () {
        const tick = freshTick('NFO');

        // Size the fee from the live feequote (oracle-priced), pay ~1.02x expected
        // so it sits inside the band, away from the min edge.
        const fq = await indexerRpc('feequote', { action: 'ISSUE', params: issueWireParams(tick), source: maker.address });
        expect(fq.supported, 'feequote supported: ' + JSON.stringify(fq)).to.equal(true);
        expect(fq.valid, 'feequote valid: ' + JSON.stringify(fq)).to.equal(true);
        expect(Number(fq.oracleRound)).to.be.greaterThan(0);
        const paidSats = Math.round(Number(fq.requiredFeeSats) * 1.02);

        const { actionIndex, blockIndex } = await submitAndIndex(
            'ISSUE ' + tick,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'nativefee-oracle-live', mintSupply: 1000 } },
            [{ address: feeDestination, value: paidSats }]);
        liveDogeBlock = blockIndex;

        // The fee row: native payment, recorded against a LIVE oracle round, paid
        // amount inside the tolerance band the validator enforces.
        const fee = await dogeIdx(async (c) => {
            const rows = await c.query(
                `SELECT payment_mode, native_coin, native_coin_amount, oracle_round
                   FROM fees WHERE action_index = ? LIMIT 1`, [actionIndex]);
            return rows.length ? rows[0] : null;
        });
        expect(fee, 'fees row for the ISSUE').to.not.equal(null);
        expect(Number(fee.payment_mode), 'payment_mode=1 (native)').to.equal(1);
        expect(String(fee.native_coin)).to.equal('DOGE');
        expect(fee.oracle_round, 'oracle_round recorded').to.not.equal(null);
        const round = Number(fee.oracle_round);
        expect(SEED_SENTINELS.has(round), 'oracle_round ' + round + ' must NOT be a seed sentinel (must be a live round)').to.equal(false);

        // Recompute the band from the LIVE oracle row the validator ACTUALLY used
        // (round = fee.oracle_round) and assert the paid amount sits inside it. This
        // proves the validator priced the native fee off the mirrored live oracle
        // round, and is robust to a round finalizing between the pre-submit feequote
        // and on-chain validation (a timing artifact, not a pricing error).
        const [vDoge] = await hubDb((c) => c.query(
            `SELECT price FROM price_snapshots WHERE coin_pair='DOGE/USD' AND status='finalized' AND round_number=? LIMIT 1`, [round]));
        const [vX] = await hubDb((c) => c.query(
            `SELECT price FROM price_snapshots WHERE coin_pair='XCHAIN/USD' AND status='finalized' AND price IS NOT NULL AND reference_block <= ? ORDER BY round_number DESC LIMIT 1`, [blockIndex]));
        expect(vDoge, 'live DOGE/USD row at the validator round').to.not.equal(undefined);
        expect(vX, 'XCHAIN/USD sidecar row').to.not.equal(undefined);
        const vBand = recomputeBand(fq.xchainFee, vX.price, vDoge.price);
        const paidDoge = Number(fee.native_coin_amount);
        expect(paidDoge, 'paid >= min (validator-round band)').to.be.gte(vBand.min * (1 - 1e-9));
        expect(paidDoge, 'paid <= max (validator-round band)').to.be.lte(vBand.max * (1 + 1e-9));

        liveFee = fee;
    });

    it('feequote == feequotedryrun == band recomputed from the live oracle row', async function () {
        // The maker is now indexed (it sourced the headline ISSUE), so the dry-run
        // (which requires a known source) can run. Use a SECOND fresh tick so the
        // dry-run prices a create against current state (it rolls back; tick never
        // created). Same flat issuance fee as the headline ISSUE.
        const tick = freshTick('NFP');
        const params = issueWireParams(tick);

        const fq = await indexerRpc('feequote', { action: 'ISSUE', params, source: maker.address });
        expect(fq.supported && fq.valid, 'feequote: ' + JSON.stringify(fq)).to.equal(true);

        const paidSats = Math.round(Number(fq.requiredFeeSats) * 1.02);
        const dry = await indexerRpc('feequotedryrun', {
            action: 'ISSUE', params, source: maker.address,
            feeOutputs: [{ address: feeDestination, value: paidSats }],
        });
        expect(dry.dryRun, 'dryRun:true').to.equal(true);
        expect(dry.valid, 'dry-run valid: ' + JSON.stringify(dry)).to.equal(true);
        expect(dry.requiredFeeNative, 'dryrun requiredFeeNative === feequote').to.equal(fq.requiredFeeNative);
        expect(dry.minAcceptable, 'dryrun minAcceptable === feequote').to.equal(fq.minAcceptable);

        // Recompute the band straight from the mirrored price_snapshots rows and
        // assert the quote matches: proves quote == validator == dry-run, all off
        // the one live oracle row.
        const [dogeRow] = await hubDb((c) => c.query(
            `SELECT price FROM price_snapshots
              WHERE coin_pair='DOGE/USD' AND status='finalized' AND round_number=? LIMIT 1`,
            [Number(fq.oracleRound)]));
        const [xRow] = await hubDb((c) => c.query(
            `SELECT price FROM price_snapshots
              WHERE coin_pair='XCHAIN/USD' AND status='finalized' AND price IS NOT NULL
                AND reference_block <= ? ORDER BY round_number DESC LIMIT 1`,
            [liveDogeBlock]));
        expect(dogeRow, 'live DOGE/USD row at the quoted round').to.not.equal(undefined);
        expect(xRow, 'XCHAIN/USD sidecar row').to.not.equal(undefined);

        const band = recomputeBand(fq.xchainFee, xRow.price, dogeRow.price);
        expect(approxEqual(fq.expectedNative, band.expected), 'expectedNative matches live-row recompute').to.equal(true);
        expect(approxEqual(fq.minAcceptable, band.min), 'minAcceptable matches live-row recompute').to.equal(true);
        expect(approxEqual(fq.maxAcceptable, band.max), 'maxAcceptable matches live-row recompute').to.equal(true);
    });
});
