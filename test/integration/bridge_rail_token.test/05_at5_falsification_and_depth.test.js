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
 * Token AT5 (falsification and depth). Three claims:
 *   a mirrored row whose `tick` or `decimals` differs from the source lock applies
 *     nothing and logs one refusal (the signatures no longer cover the canonical);
 *   an in-leg SIGNED by the federation at decimals other than an existing BTC.FUFU row's,
 *     with supply outstanding, is refused with one line naming the id (D16);
 *   with the origin row at MIN_DEPTH=3 on a rail pinned to depth 1, a lock does not
 *     finalize before 3 confirmations and does at 3 (D24).
 * The injected rows follow the base reorg suite's AT4 shape: a row the federation really
 * signed, one thing changed, injected through the destination's own venue, judged on the
 * destination's ledger and log.
 *
 ********************************************************************/

'use strict';

// describeRow, not JSON.stringify: the min_depth row carries BigInt columns that JSON cannot serialize.
const { describeRow } = require('../../helpers/bridgeRailVenue');

const {
    assert,
    lockWireV3,
    optInWire,
    issueHelper,
    transactionHelper,
    effectiveLockDepth,
    state,
    btcAction,
    fundBtc,
    fundDoge,
    pickFreeTick,
    settleLeg,
    mineBtcBlocks,
    needsFederation,
    bridgeRailSuite,
} = require('./support');
const { withMiningPaused } = require('../../helpers/bridgeRailVenue');
const HUB = require('../../helpers/bridgeHubRecord');
const { ValidatorIdentity } = require('../../helpers/multiValidatorHubHelper');

const GROUP = 'token AT5: falsification and depth';

// A row the federation really signed for THIS token, the template every injection perturbs.
async function signedTokenTemplate() {
    const rows = await state.venue.queryHubDb(state.venue.hubs[0].dbName,
        "SELECT * FROM bridge_transfers WHERE tick = ? AND dest_chain = 'DOGE' AND status = 'finalized' " +
        "AND transfer_id NOT LIKE 'at5%' ORDER BY id DESC LIMIT 1", [state.tokens.tick]);
    assert.ok(rows.length, 'AT5 perturbs a row the federation really signed for ' + state.tokens.tick + ', so AT1 must have run');
    return rows[0];
}

// Inject `row` into the DOGE mirror and hold until the destination has logged a refusal
// naming it and run two more passes over it; answer the balance and the refusal lines.
async function injectAndObserve(row, dest) {
    const venue = state.venue;
    await venue.dogeVenue.injectMirrorRow(row, { table: 'bridge_transfers', key: ['transfer_id'] });
    const idPrefix = row.transfer_id.slice(0, 16);
    const refusalsNow = () => venue.indexerTails(400).split('\n').filter((l) => l.includes(idPrefix));
    await venue.waitUntil('the destination to log a refusal naming ' + idPrefix,
        () => refusalsNow().length >= 1, { timeoutMs: 180000 });
    const atRefusal = Number((await venue.venueTips()).DOGE);
    await venue.waitUntil('two more DOGE blocks after the refusal',
        async () => Number((await venue.venueTips()).DOGE) >= atRefusal + 2, { timeoutMs: 300000 });
    const settled = await venue.queryIndexerDb('DOGE',
        'SELECT transfer_id FROM bridge_settlements WHERE transfer_id = ?', [row.transfer_id]);
    return {
        balance: await venue.addressBalance('DOGE', dest.address, 'BTC.' + String(row.tick)),
        settled: settled.length,
        refusals: refusalsNow().map((l) => l.trim().slice(0, 240)),
    };
}

const MUTATIONS = [
    { name: 'a tick other than the source lock\'s',     mutate: (r) => ({ tick: 'FAKE' + String(r.tick).slice(0, 4) }) },
    { name: 'decimals other than the source lock\'s',   mutate: (r) => ({ decimals: Number(r.decimals) + 1 }) },
];

for (const m of MUTATIONS) {
    bridgeRailSuite(GROUP, function () {
        it('token AT5 (falsification): a mirrored row carrying ' + m.name + ' applies nothing and logs exactly one refusal', async function () {
            this.timeout(0);
            if (needsFederation(this, 'token AT5 falsification')) return;
            const template = await signedTokenTemplate();
            const dest = await fundDoge('TOKEN.AT5.' + m.name.replace(/[^A-Za-z]/g, '').slice(0, 12), 1);
            const row = Object.assign({}, template, {
                src_action_index: 750000 + MUTATIONS.indexOf(m) + Number(template.src_action_index || 0),
                transfer_id: ('at5' + Date.now().toString(16) + m.name.replace(/[^a-f0-9]/g, '')).padEnd(64, '0').slice(0, 64),
                dest_address: dest.address,
            }, m.mutate(template));
            delete row.id;
            const got = await injectAndObserve(row, dest);
            state.evidence['at5_' + m.name.replace(/[^A-Za-z]/g, '')] = { transferId: row.transfer_id, got };
            assert.strictEqual(got.balance, '0', dest.address + ' was credited from a record carrying ' + m.name);
            assert.strictEqual(got.settled, 0, 'the destination recorded a settlement for a record carrying ' + m.name);
            assert.strictEqual(got.refusals.length, 1, 'the destination logged ' + got.refusals.length +
                ' line(s) naming ' + row.transfer_id.slice(0, 16) + ': ' + JSON.stringify(got.refusals));
        });
    });
}

bridgeRailSuite(GROUP, function () {
    it('token AT5 (existing row): a federation-signed in-leg at other decimals than BTC.<tick> with supply outstanding is refused with one line naming the id', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT5 decimals with supply')) return;
        const T = state.tokens;
        const template = await signedTokenTemplate();
        const child = await state.venue.tokenParameters('DOGE', T.bridged);
        assert.ok(child && Number((await state.venue.bridgeBalances('DOGE', T.bridged)).supply) > 0,
            T.bridged + ' must exist with supply on DOGE for this claim to be about D16');
        const dest = await fundDoge('TOKEN.AT5.DECIMALS', 1);
        const row = HUB.buildTransferRow({
            snapshotBlock: template.snapshot_block, network: template.network, srcChain: 'BTC',
            srcActionIndex: 760000 + Number(template.src_action_index || 0), srcAddress: template.src_address,
            destChain: 'DOGE', destAddress: dest.address, tick: T.tick,
            decimals: Number(child.params.decimals) + 1, amount: '1',
            effectiveTime: Math.floor(Date.now() / 1000), view: template.finalizing_view,
            btcChainId: template.btc_chain_id,
        });
        // Signed by the venue's OWN mesh, the keys the destination's cross_chain snapshot seats,
        // so the only thing wrong with this record is its decimals.
        HUB.signRecord(row, state.venue.identities.map((id) => new ValidatorIdentity(id.privkeyHex)));
        const got = await injectAndObserve(row, dest);
        state.evidence.at5_decimalsWithSupply = { transferId: row.transfer_id, got };
        assert.strictEqual(got.balance, '0', dest.address + ' was credited at the wrong decimals');
        assert.strictEqual(got.settled, 0, 'the destination recorded a settlement for the wrong-decimals record');
        assert.strictEqual(got.refusals.length, 1, 'the destination logged ' + got.refusals.length + ' line(s): ' + JSON.stringify(got.refusals));
        assert.match(got.refusals[0], /decimals mismatch/, 'the refusal was not the decimals guard: ' + got.refusals[0]);
    });
});

// A third token at MIN_DEPTH=3, its lock broadcast and confirmed ONE block deep under the
// paused miner; answers what the depth leg needs to mine and read.
async function lockAtDepthOne() {
    const D = state.tokens.at5;
    D.tick = await pickFreeTick(['DEEP', 'DEEQ', 'DEER']);
    assert.ok(D.tick, 'no free tick for the depth leg');
    D.issuer = await fundBtc('TOKEN.AT5.DEPTH.ISSUER');
    D.dest = await fundDoge('TOKEN.AT5.DEPTH.DEST', 1);
    const issue = await btcAction(D.issuer, () => issueHelper.sendIssueV0Raw(D.issuer, D.tick, 1000, 1000, 0, 'token AT5 depth', 10), 'issues');
    assert.strictEqual(issue.status, 'valid', 'ISSUE ' + D.tick + ' graded ' + issue.status);
    const optIn = await btcAction(D.issuer, optInWire(D.tick, 'DOGE', 3, '', 'AT5 MIN_DEPTH=3'), 'issues');
    assert.strictEqual(optIn.status, 'valid', 'ISSUE|7 MIN_DEPTH=3 graded ' + optIn.status);
    const row = await state.venue.tokenParameters('BTC', D.tick);
    assert.strictEqual(String(row.params.min_depth), '3', 'the BTC row reads min_depth ' + row.params.min_depth);
    return { issue, optIn };
}

async function confirmLockAtDepth(D) {
    const tx = await transactionHelper.createAndSendTransaction(
        D.issuer, lockWireV3(D.tick, 'DOGE', D.dest.address, 1, 'AT5 depth'));
    await mineBtcBlocks(1, 'the depth lock\'s confirming block');
    const got = await state.venue.verdict('BTC', 'xbridges', tx);
    assert.ok(got && got.status === 'valid', 'the depth lock graded ' + (got && got.status));
    const stamped = await state.venue.queryIndexerDb('BTC',
        'SELECT min_depth FROM xbridges WHERE action_index = ? LIMIT 1', [String(got.actionIndex)]);
    assert.strictEqual(String(stamped[0] && stamped[0].min_depth), '3', 'the lock stamped min_depth ' + describeRow(stamped));
    return { tx, actionIndex: got.actionIndex };
}

bridgeRailSuite(GROUP, function () {
    it('token AT5 (depth): with the origin row at MIN_DEPTH=3 on the rail pinned to 1, the lock does not finalize before 3 confirmations and does at 3', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT5 depth')) return;
        const D = state.tokens.at5;
        const venue = state.venue;
        const want = effectiveLockDepth(venue.confirmations.BTC, 3);
        assert.strictEqual(want, 3, 'the venue pins BTC at ' + venue.confirmations.BTC + ', so the effective depth reads ' + want);
        const setup = await lockAtDepthOne();
        const notYet = (r) => String(r.dest_address) === D.dest.address && String(r.tick) === D.tick;
        // Three poll cycles is long enough for the engine to have seen every depth below 3.
        const settleWindowMs = 3 * Number(venue.pollMs) + 5000;
        const reading = await withMiningPaused(regtestMinerConnector, async () => {
            const lock = await confirmLockAtDepth(D);
            const atDepth = {};
            for (const depth of [1, 2]) {
                atDepth[depth] = await venue.waitForFinalizedTransfer(notYet, { timeoutMs: settleWindowMs });
                if (depth < want - 1) await mineBtcBlocks(1, 'depth ' + (depth + 1) + ' for the depth lock');
            }
            await mineBtcBlocks(1, 'depth ' + want + ' for the depth lock');
            atDepth[want] = await venue.waitForFinalizedTransfer(notYet, { timeoutMs: 10 * 60 * 1000 });
            return { lock, atDepth };
        });
        state.evidence.at5_depth = { tick: D.tick, setup, lockTx: reading.lock.tx, pollMs: venue.pollMs,
            finalizedAtDepth: Object.keys(reading.atDepth).filter((d) => reading.atDepth[d]).map(Number) };
        assert.strictEqual(reading.atDepth[1], null, 'the lock finalized at depth 1 against MIN_DEPTH=3');
        assert.strictEqual(reading.atDepth[2], null, 'the lock finalized at depth 2 against MIN_DEPTH=3');
        assert.ok(reading.atDepth[want], 'the lock never finalized at depth ' + want + '.\n' + venue.hubTails(30));
        // Applied on DOGE before the invariant leg reads in_flight 0.
        const leg = await settleLeg('the depth lock', (r) => String(r.transfer_id) === String(reading.atDepth[want].transfer_id), 'DOGE');
        state.evidence.at5_depth.transfer = leg.transfer;
    });
});
