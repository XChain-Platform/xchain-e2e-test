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
 * Policy AT8 (invariants, cap, reorg): getappliedpolicy equals the origin policy on every
 * destination after AT1 to AT7; six snapshots across two ticks finalized for one block apply
 * as 5 then 1 in the pinned order; a DOGE regtest reorg below the block that applied a snapshot
 * drops the injected rows and replay re-applies them with the copy repointed, hashes identical
 * across nodes.
 *
 * THE CAP LEG holds `policy_snapshots` at the DOGE indexer's mirror proxy while three issuer
 * edits on each of two bridged ticks finalize as six snapshots, waits out every
 * effective_time, then releases the table with the DOGE miner paused until the mirror holds
 * all six, so the whole set becomes due at ONE block.
 *
 * THE REORG LEG needs a snapshot that CREATED a list (only that one repoints the copy), applied
 * in a block this drive mined and still inside the reorg window, so it bridges a fresh token
 * and orphans the block that applied its seq 1. The replacement blocks come from the DOGE
 * miner under its pause, not from `generateblock`, which Dogecoin Core's RPC does not carry.
 *
 ********************************************************************/

'use strict';

const {
    POLICY_LIST_EDIT,
    listEditWire,
    policyCapOrderReading,
    assertShallowOrphan,
    withMiningPaused,
} = require('../../helpers/bridgeRailVenue');
const {
    assert,
    cryptoHelper,
    lockWireV3,
    state,
    btcAction,
    fundDoge,
    settleLeg,
    listedToken,
    hubPolicyRows,
    waitForFinalizedSeq,
    waitForAppliedSeq,
    originPolicy,
    copyPolicy,
    appliedPolicyRead,
    appliedLedger,
    listOrigin,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT8: invariants, the cap and a destination reorg';
const TABLE = 'policy_snapshots';
const DOGE_UNDO_BLOCKS = 12;

async function newestFinalized(tick) {
    const rows = (await hubPolicyRows(tick)).filter((r) => String(r.status) === 'finalized');
    return rows[rows.length - 1];
}

bridgeRailSuite(GROUP, function () {
    it('policy AT8 (invariant): every bridged tick\'s applied policy on DOGE equals its origin policy, by hash and by getappliedpolicy', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT8 invariant')) return;
        const readings = [];
        for (const tick of state.policy.ticks) {
            const newest = await newestFinalized(tick);
            if (!newest) continue;
            await waitForAppliedSeq(tick, Number(newest.policy_seq));
            const origin = await originPolicy(tick);
            readings.push({ tick, seq: Number(newest.policy_seq), originHash: origin.policy_hash,
                copyHash: (await copyPolicy(tick)).policy_hash, applied: await appliedPolicyRead(tick) });
        }
        state.evidence.at8_invariant = readings;
        assert.ok(readings.length >= 2, 'the invariant covers ' + readings.length + ' bridged ticks; AT1 to AT5 bridge three');
        for (const r of readings) {
            assert.strictEqual(r.copyHash, r.originHash, r.tick + ': the copy\'s materialized policy differs from the origin');
            assert.strictEqual(String(r.applied.policy_hash), String(r.originHash),
                r.tick + ': getappliedpolicy on DOGE reads ' + JSON.stringify(r.applied) + ', the origin hash is ' + r.originHash);
        }
    });
});

// Three rounds of one issuer edit per tick, each round's two snapshots finalized before the
// next, so six distinct snapshots exist; answers them.
async function sixSnapshots(tokens) {
    const made = [];
    for (let round = 0; round < 3; round++) {
        for (const t of tokens) {
            const before = Number((await newestFinalized(t.tick)).policy_seq);
            const member = (await cryptoHelper.getNewAddress('POLICY.AT8.CAP.' + t.tick + '.' + round, 'dogecoin', NETWORK, null, 'legacy', 0)).address;
            const edit = await btcAction(t.issuer, listEditWire(POLICY_LIST_EDIT.ADD, t.listIndex, [member], 'policy AT8 cap'), 'lists');
            assert.strictEqual(edit.status, 'valid', 'the cap edit on ' + t.tick + ' graded ' + edit.status);
            made.push(await waitForFinalizedSeq(t.tick, before + 1));
        }
    }
    return made;
}

bridgeRailSuite(GROUP, function () {
    it('policy AT8 (cap): six snapshots across two ticks, due at one DOGE block, apply as 5 then 1 in the pinned order', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT8 cap')) return;
        const tokens = [state.policy.main, state.policy.lag];
        assert.ok(tokens.every((t) => t.tick && t.listIndex), 'AT1 and AT5 must have bridged their tokens');
        const doge = state.venue.dogeVenue;
        doge.withholdMirrorTable(0, TABLE);
        let rows = [];
        try {
            rows = await sixSnapshots(tokens);
            const due = Math.max(...rows.map((r) => Number(r.effective_time))) + 5;
            await state.venue.waitUntil('every cap snapshot\'s effective_time to pass', () => Date.now() / 1000 >= due,
                { timeoutMs: Math.max(0, due * 1000 - Date.now()) + 120000, everyMs: 5000 });
        } finally {
            const pauseFile = process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE || '';
            await withMiningPaused(state.dogeRail.globals.regtestMinerConnector, async () => {
                doge.releaseMirrorTable(0, TABLE);
                if (rows.length) {
                    await state.venue.waitUntil('the DOGE mirror to hold all six cap snapshots', async () => (await state.venue.queryMirrorDb('DOGE',
                        'SELECT COUNT(*) AS n FROM policy_snapshots WHERE snapshot_id IN (?)', [rows.map((r) => r.snapshot_id)]))[0].n >= rows.length,
                    { timeoutMs: 10 * 60 * 1000, everyMs: 3000 });
                }
            }, { pauseFile });
        }
        for (const t of tokens) await waitForAppliedSeq(t.tick, Number((await newestFinalized(t.tick)).policy_seq));
        const settlements = await state.venue.queryIndexerDb('DOGE',
            "SELECT transfer_id, block_index, action_index FROM bridge_settlements WHERE kind = 'policy' AND transfer_id IN (?)",
            [rows.map((r) => r.snapshot_id)]);
        const reading = policyCapOrderReading(rows, settlements, 5);
        state.evidence.at8_cap = { reading, dogePauseHeld: !!process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE };
        assert.strictEqual(reading.ok, true, reading.reason);
        assert.deepStrictEqual(reading.groups.map((g) => g.count), [5, 1], 'the six snapshots applied in groups ' + JSON.stringify(reading.groups));
    });
});

// Orphan the DOGE block at `height` and build a longer chain through the paused DOGE miner.
async function reorgDogeAt(height) {
    const node = state.dogeRail.globals.nodeConnector;
    const miner = state.dogeRail.globals.regtestMinerConnector;
    assert.ok(height > Number(state.policy.reorg.dogeTipAtStart),
        'refusing to orphan DOGE block ' + height + ', which existed before this leg started');
    const tipBefore = Number(await node.getBlockCount());
    assertShallowOrphan(height, tipBefore, DOGE_UNDO_BLOCKS);
    const hash = await node.getBlockHash(height);
    await node.invalidateBlock(hash);
    assert.strictEqual(Number(await node.getBlockCount()), height - 1, 'the DOGE node did not roll back below ' + height);
    await miner.generateBlocks(tipBefore - height + 2);
    const newHash = await node.getBlockHash(height);
    assert.notStrictEqual(newHash, hash, 'DOGE block ' + height + ' kept its hash, so nothing reorged');
    return { height, hash, newHash, tipBefore, tipAfter: Number(await node.getBlockCount()) };
}

bridgeRailSuite(GROUP, function () {
    it('policy AT8 (reorg): a DOGE reorg of the block that applied a list-creating snapshot drops it and replay re-applies it with the copy repointed at a live bridge-owned list', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT8 reorg')) return;
        const R = state.policy.reorg = { dogeTipAtStart: Number((await state.venue.venueTips()).DOGE) };
        R.blocked = await fundDoge('POLICY.AT8.BLOCKED', 1);
        R.dest = await fundDoge('POLICY.AT8.DEST', 2);
        Object.assign(R, await listedToken('AT8REORG', ['RORA', 'RORB', 'RORC'], [R.blocked.address]));
        assert.strictEqual(R.optIn.status, 'valid', 'ISSUE|7 of the reorg token graded ' + R.optIn.status);
        const lock = await btcAction(R.issuer, lockWireV3(R.tick, 'DOGE', R.dest.address, 1, 'policy AT8 reorg'), 'xbridges');
        assert.strictEqual(lock.status, 'valid', 'the reorg token lock graded ' + lock.status);
        await settleLeg('the policy AT8 reorg lock', (r) => String(r.dest_address) === R.dest.address && String(r.tick) === R.tick, 'DOGE');
        await waitForFinalizedSeq(R.tick, 1);
        // Applied FIRST, then the pause: a paused DOGE miner produces no block to apply it in.
        const applied = await waitForAppliedSeq(R.tick, 1);
        const pauseFile = process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE || '';
        const before = await withMiningPaused(state.dogeRail.globals.regtestMinerConnector, async () => {
            const copy = await state.venue.tokenParameters('DOGE', 'BTC.' + R.tick);
            const orphan = await reorgDogeAt(applied.block);
            return { applied, blockList: copy.params.block_list, orphan };
        }, { pauseFile });
        await state.venue.waitForVenueTip('DOGE', before.orphan.tipAfter, 'past the policy reorg', { timeoutMs: 15 * 60 * 1000, everyMs: 5000 });
        const ledger = await appliedLedger(R.tick);
        const copy = await state.venue.tokenParameters('DOGE', 'BTC.' + R.tick);
        const list = await listOrigin('DOGE', copy.params.block_list);
        state.evidence.at8_reorg = { tick: R.tick, before, ledger, blockListAfter: copy.params.block_list, list,
            copyPolicy: await copyPolicy(R.tick), originPolicy: await originPolicy(R.tick) };
        assert.strictEqual(ledger.length, 1, 'the DOGE ledger holds ' + ledger.length + ' applications of ' + R.tick + ' seq 1 after the reorg');
        assert.ok(ledger[0].block >= before.orphan.height, 'seq 1 re-applied at block ' + ledger[0].block + ', below the orphaned ' + before.orphan.height);
        assert.ok(list && String(list.tx_hash).startsWith('XPOLICY-') && list.source === state.evidence.bridgeRoleDoge,
            'the copy\'s BLOCK_LIST ' + copy.params.block_list + ' is not a live bridge-owned list: ' + JSON.stringify(list));
        assert.strictEqual(state.evidence.at8_reorg.copyPolicy.policy_hash, state.evidence.at8_reorg.originPolicy.policy_hash,
            'after the reorg the copy\'s policy differs from the origin');
    });

    // Spec AT8: "hashes identical across nodes". This venue runs ONE DOGE indexer on the tree's
    // code (a second one replays the DOGE chain from genesis, hours per indexer), so there is no
    // second node here to compare; the replay identity is the replay corpus's claim.
    it.skip('policy AT8 (reorg, across nodes): the DOGE hashes after the reorg are identical across nodes. NOT DRIVABLE on this venue: ' +
        '"hashes identical across nodes", and the venue runs one DOGE indexer on the tree\'s code');
});
