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
 * Token AT8, the cap and the invariant: 30 locks across two ticks mined in ONE BTC block
 * apply on DOGE as 25 then 5 in (snapshot_block, transfer_id) order (D29); then
 * `getbridgeinvariant` reads equal per tick on both chains, in-flight 0, and the XCHAIN
 * entry is unaffected throughout (the retraction half ran first, in 00_).
 *
 * ONE SENDER PER LOCK. The harness spends only CONFIRMED outputs, so one address cannot
 * broadcast thirty locks into one block; thirty funded senders each holding one unit can,
 * under the paused BTC miner, with one block mined by hand at the end.
 *
 * "25 THEN 5" IS A CLAIM ABOUT THIRTY LEGS DUE TOGETHER. The destination applies what is
 * due at each of its blocks, so the DOGE side is held still until every leg has finalized
 * and every effective_time has passed, and released; the first block then carries the cap
 * and the next the rest. The standing DOGE block loop is external to the miner sidecar's
 * pause, so it must honour BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE for the split to be exact;
 * without that file the leg still proves the order and the cap and journals the split.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    lockWireV3,
    optInWire,
    issueHelper,
    transactionHelper,
    classifyInvariant,
    capOrderReading,
    GAS_TICK,
    LOCK,
    BURN,
    state,
    btcAction,
    fundBtc,
    fundDoge,
    pickFreeTick,
    tokenSnapshot,
    chainHalves,
    capPerBlock,
    mineBtcBlocks,
    needsFederation,
    bridgeRailSuite,
} = require('./support');
const { withMiningPaused } = require('../../helpers/bridgeRailVenue');

const GROUP = 'token AT8: the cap and the invariant per tick';
const PER_TICK = 15;

// A second bridgeable tick beside FUFU, minted to a fresh issuer.
async function secondCapTick() {
    const C = state.tokens.cap;
    C.tick2 = await pickFreeTick(['CAPB', 'CAPC', 'CAPD']);
    assert.ok(C.tick2, 'no free tick for the cap leg');
    C.issuer2 = await fundBtc('TOKEN.AT8.CAP.ISSUER');
    const issue = await btcAction(C.issuer2, () => issueHelper.sendIssueV0Raw(C.issuer2, C.tick2, 1000, 1000, 0, 'token AT8 cap', 100), 'issues');
    assert.strictEqual(issue.status, 'valid', 'ISSUE ' + C.tick2 + ' graded ' + issue.status);
    const optIn = await btcAction(C.issuer2, optInWire(C.tick2, 'DOGE', '', '', 'AT8 cap opt-in'), 'issues');
    assert.strictEqual(optIn.status, 'valid', 'ISSUE|7 ' + C.tick2 + ' graded ' + optIn.status);
}

// Fifteen funded senders per tick, each airdropped one unit by that tick's issuer.
async function fundSenders(issuer, tick, tag) {
    const senders = [];
    for (let i = 0; i < PER_TICK; i++) senders.push(await fundBtc('TOKEN.AT8.' + tag + '.S' + i));
    const list = await btcAction(issuer, 'LIST|0|2||' + senders.map((s) => s.address).join('|'), 'lists');
    assert.strictEqual(list.status, 'valid', 'the ' + tag + ' sender LIST graded ' + list.status);
    const airdrop = await btcAction(issuer, 'AIRDROP|0|' + tick + '|1|' + list.actionIndex + '|', 'airdrops');
    assert.strictEqual(airdrop.status, 'valid', 'the AIRDROP of ' + tick + ' over list ' + list.actionIndex + ' graded ' + airdrop.status);
    for (const s of senders) {
        assert.strictEqual(Number(await state.venue.addressBalance('BTC', s.address, tick)), 1, s.address + ' holds no ' + tick + ' to lock');
    }
    return senders;
}

// Thirty locks into the mempool under the paused miner, then ONE block by hand; every
// lock must sit in that block and grade valid.
async function lockThirtyInOneBlock(legs, dest) {
    return withMiningPaused(regtestMinerConnector, async () => {
        const txs = [];
        for (const leg of legs) {
            txs.push({ tick: leg.tick, tx: await transactionHelper.createAndSendTransaction(
                leg.sender, lockWireV3(leg.tick, 'DOGE', dest.address, 1, 'AT8 cap')) });
        }
        const tip = await mineBtcBlocks(1, 'the block holding the thirty locks');
        const blockHash = await nodeConnector.getBlockHash(tip);
        for (const t of txs) {
            const node = await nodeConnector.getTransaction(t.tx);
            assert.strictEqual(node && node.blockhash, blockHash, 'lock ' + t.tx + ' is not in block ' + tip);
            const got = await state.venue.verdict('BTC', 'xbridges', t.tx);
            assert.ok(got && got.status === 'valid', 'lock ' + t.tx + ' of ' + t.tick + ' graded ' + (got && got.status));
            t.actionIndex = got.actionIndex;
        }
        return { block: tip, blockHash, txs };
    });
}

// Hold the DOGE side still until every leg has finalized and is due, then release it.
async function holdDogeUntilDue(dest, count) {
    const venue = state.venue;
    const dogeMiner = state.dogeRail.globals.regtestMinerConnector;
    const pauseFile = process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE || '';
    const rows = await withMiningPaused(dogeMiner, async () => {
        let finalized = [];
        await venue.waitUntil('all ' + count + ' cap locks to finalize', async () => {
            finalized = await venue.queryHubDb(venue.hubs[0].dbName,
                "SELECT transfer_id, snapshot_block, effective_time, tick FROM bridge_transfers " +
                "WHERE dest_address = ? AND status = 'finalized'", [dest.address]);
            return finalized.length >= count;
        }, { timeoutMs: 45 * 60 * 1000 });
        const due = Math.max(...finalized.map((r) => Number(r.effective_time))) + 5;
        const waitMs = Math.max(0, due * 1000 - Date.now());
        console.log('  cap legs finalized; holding DOGE ' + Math.round(waitMs / 1000) + 's until every effective_time has passed');
        // A wait on the CLOCK condition itself, not a fixed settle: the release must follow
        // the last effective_time, and the hold is exactly as long as that takes.
        await venue.waitUntil('every cap leg\'s effective_time to pass', () => Date.now() >= due * 1000,
            { timeoutMs: waitMs + 60000, everyMs: 5000 });
        return finalized;
    }, { pauseFile });
    return { rows, held: !!pauseFile };
}

bridgeRailSuite(GROUP, function () {
    it('token AT8 (cap): 30 locks across two ticks mined in one BTC block apply on DOGE as 25 then 5 in (snapshot_block, transfer_id) order', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT8 cap')) return;
        const T = state.tokens, C = state.tokens.cap;
        assert.ok(state.evidence.at1_dogeChild, 'AT1 must have run');
        const cap = capPerBlock();
        assert.strictEqual(2 * PER_TICK, cap + 5, 'the leg locks ' + (2 * PER_TICK) + ' where the cap reads ' + cap);
        await secondCapTick();
        const legs = [];
        for (const s of await fundSenders(T.issuer, T.tick, 'A')) legs.push({ tick: T.tick, sender: s });
        for (const s of await fundSenders(C.issuer2, C.tick2, 'B')) legs.push({ tick: C.tick2, sender: s });
        C.dest = await fundDoge('TOKEN.AT8.CAP.DEST', 2);
        const mined = await lockThirtyInOneBlock(legs, C.dest);
        const held = await holdDogeUntilDue(C.dest, legs.length);
        const ids = held.rows.map((r) => String(r.transfer_id));
        let settlements = [];
        await state.venue.waitUntil('all ' + ids.length + ' cap legs to apply on DOGE', async () => {
            settlements = await state.venue.queryIndexerDb('DOGE',
                'SELECT transfer_id, block_index FROM bridge_settlements WHERE transfer_id IN (' + ids.map(() => '?').join(',') + ')', ids);
            return settlements.length >= ids.length;
        }, { timeoutMs: 30 * 60 * 1000 });
        const reading = capOrderReading(held.rows, settlements, cap);
        state.evidence.at8_cap = { block: mined.block, locks: mined.txs.length, dogeHeld: held.held, reading,
            destA: await state.venue.addressBalance('DOGE', C.dest.address, T.bridged),
            destB: await state.venue.addressBalance('DOGE', C.dest.address, 'BTC.' + C.tick2) };
        assert.ok(reading.ok, reading.reason);
        assert.strictEqual(Number(state.evidence.at8_cap.destA), PER_TICK, C.dest.address + ' holds ' + state.evidence.at8_cap.destA + ' ' + T.bridged);
        assert.strictEqual(Number(state.evidence.at8_cap.destB), PER_TICK, C.dest.address + ' holds ' + state.evidence.at8_cap.destB + ' BTC.' + C.tick2);
        if (held.held) {
            assert.deepStrictEqual(reading.groups.map((g) => g.count), [cap, 5],
                'a held destination applied the thirty legs as ' + JSON.stringify(reading.groups) + ' and not as ' + cap + ' then 5');
        } else {
            console.log('  token AT8 cap split read ' + JSON.stringify(reading.groups) + ' with the DOGE loop NOT held (no BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE)');
        }
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT8 (invariant): getbridgeinvariant reads equal per tick on both chains, in-flight 0, and the XCHAIN entry equals the baseline', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT8 invariant')) return;
        const T = state.tokens;
        assert.ok(state.baseline && state.evidence.at1_dogeChild, 'the baseline and AT1 must have run');
        const ticks = [T.tick, state.tokens.at3.tick, state.tokens.reorg.tick, state.tokens.at5.tick, state.tokens.cap.tick2].filter(Boolean);
        const r = { perTick: {} };
        for (const tick of ticks) {
            const settled = await state.venue.waitForRailSettled(tick, { timeoutMs: 30 * 60 * 1000 });
            assert.ok(settled, 'the rail never settled for ' + tick + ': ' + JSON.stringify(state.venue._lastSettlePoll));
            const snap = await tokenSnapshot('at8_' + tick, tick, null);
            const inv = await state.venue.bridgeInvariant(tick);
            const entry = inv && inv[tick] && inv[tick].DOGE;
            r.perTick[tick] = { escrow: snap.escrow, supply: snap.supply, hub: entry, verdict: classifyInvariant(entry).verdict };
            assert.strictEqual(snap.escrow, snap.supply, tick + ': BTC escrow ' + snap.escrow + ' against DOGE supply ' + snap.supply);
            assert.strictEqual(String(entry && entry.in_flight), '0', tick + ': in_flight reads ' + JSON.stringify(entry));
            assert.strictEqual(classifyInvariant(entry).verdict, 'equal', tick + ': the hub reads ' + JSON.stringify(entry));
        }
        // AT1 locked 5, AT2 burned 2, AT7 moved units inside DOGE, the cap leg locked 15 more.
        assert.strictEqual(r.perTick[T.tick].escrow, LOCK - BURN + PER_TICK, T.tick + ' escrow reads ' + r.perTick[T.tick].escrow);
        r.xchainNow = await chainHalves();
        state.evidence.at8_invariant = r;
        assert.strictEqual(r.xchainNow.backed, state.baseline.xchain.backed,
            'the XCHAIN backed quantity moved from ' + state.baseline.xchain.backed + ' to ' + r.xchainNow.backed);
        assert.strictEqual(String(r.xchainNow.supply), String(state.baseline.xchain.supply),
            'the XCHAIN DOGE supply moved from ' + state.baseline.xchain.supply + ' to ' + r.xchainNow.supply);
        const xchain = (await state.venue.bridgeInvariant(GAS_TICK))[GAS_TICK].DOGE;
        assert.strictEqual(String(xchain.in_flight), '0', 'XCHAIN in_flight reads ' + JSON.stringify(xchain));
    });
});
