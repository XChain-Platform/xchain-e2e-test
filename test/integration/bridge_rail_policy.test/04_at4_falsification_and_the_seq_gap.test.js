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
 * Policy AT4 (falsification): a mirrored snapshot whose membership JSON does not hash to
 * policy_hash, one whose arrays are out of canonical order, one with a bad signature, one with
 * a foreign network or btc_chain_id, applies nothing and logs one refusal naming snapshot_id;
 * DOGE hashes unchanged. A snapshot at seq 3 arriving with seq 2 absent applies (full
 * membership) with one log line.
 *
 * EACH FORGERY ON ITS OWN TICK, and the reason is the apply-order guard: a terminally refused
 * row still counts as an earlier finalized seq, so a forgery on a live tick would carry every
 * later genuine snapshot of that tick forward forever. A tick with no copy on DOGE is enough,
 * because every one of these refusals is taken before the copy is looked up
 * (src/consensus/bridge_settle/policy.js: screen, order, membership, quorum, then copy).
 *
 * THE SEQ-GAP ROW GOES TO EVERY HUB, not only the one the DOGE indexer follows: a hub's next
 * seq is its own last finalized row plus one, so a row only hub 0 held would split the
 * federation's numbering for that tick. With every hub holding seq 3, the origin's unchanged
 * policy then differs from it everywhere at once and the federation signs seq 4, which is
 * asserted too, so the copy ends the leg enforcing the origin's policy again.
 *
 ********************************************************************/

'use strict';

const HUB = require('../../helpers/bridgeHubRecord');
const { ValidatorIdentity } = require('../../helpers/multiValidatorHubHelper');
const {
    assert,
    lockWireV3,
    state,
    btcAction,
    fundDoge,
    settleLeg,
    listedToken,
    waitForFinalizedSeq,
    waitForAppliedSeq,
    copyPolicy,
    appliedLedger,
    policyLines,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT4: falsification and the seq gap';

// A genuine finalized row, the template every forgery copies its snapshot_block, view and
// chain id from so the only defect in each is the one named.
function template() {
    const row = state.policy.main.seq2;
    assert.ok(row, 'AT4 forges against a snapshot the federation really signed, so AT2 must have run');
    return row;
}

function venueSigners() {
    return state.venue.identities.map((id) => new ValidatorIdentity(id.privkeyHex));
}

function forged(tick, fields, signOpts) {
    const t = template();
    const row = HUB.buildPolicyRow(Object.assign({
        snapshotBlock: Number(t.snapshot_block), originChain: 'BTC', tick: tick, policySeq: 1,
        originBlock: Number(t.origin_block), effectiveTime: Number(t.effective_time), network: String(t.network),
        view: Number(t.finalizing_view || 0), btcChainId: t.btc_chain_id,
    }, fields));
    return HUB.signRecord(row, venueSigners(), signOpts);
}

const A = 'mPolicyForgeryMemberAXXXXXXXXXXXXX';
const B = 'mPolicyForgeryMemberBXXXXXXXXXXXXX';

const FORGERIES = [
    { name: 'membership that does not hash to policy_hash', tick: 'FORGH',
      build: (tick) => forged(tick, { block: [A], policyHash: HUB.hubEngine().policyHash(null, [B], false) }) },
    { name: 'arrays out of canonical order', tick: 'FORGO', build: (tick) => forged(tick, { block: [B, A] }) },
    { name: 'a bad signature', tick: 'FORGS', build: (tick) => forged(tick, { block: [A] }, { message: 'not the canonical' }) },
    { name: 'a foreign network', tick: 'FORGN', build: (tick) => forged(tick, { block: [A], network: 'testnet' }) },
    { name: 'a foreign btc_chain_id', tick: 'FORGC', build: (tick) => forged(tick, { block: [A], btcChainId: 'f'.repeat(64) }) },
];

// Inject one forgery, let the DOGE indexer pass over it for three blocks, and read what it did.
async function injectAndObserve(row) {
    const venue = state.venue;
    const startTip = Number((await venue.venueTips()).DOGE);
    const hashBefore = await venue.blockHashes('DOGE', startTip);
    await venue.dogeVenue.injectMirrorRow(row, { table: 'policy_snapshots', key: ['snapshot_id'] });
    await venue.waitForVenueTip('DOGE', startTip + 3, 'past the forged snapshot ' + row.snapshot_id.slice(0, 16),
        { timeoutMs: 15 * 60 * 1000, everyMs: 5000 });
    const settled = await venue.queryIndexerDb('DOGE',
        "SELECT transfer_id FROM bridge_settlements WHERE kind = 'policy' AND transfer_id = ?", [row.snapshot_id]);
    const mirrored = await venue.queryMirrorDb('DOGE', 'SELECT snapshot_id FROM policy_snapshots WHERE snapshot_id = ?', [row.snapshot_id]);
    return { settled: settled.length, mirrored: mirrored.length, lines: policyLines(row.snapshot_id),
        hashBefore: String(hashBefore[0].ledger_hash), hashAfter: String((await venue.blockHashes('DOGE', startTip))[0].ledger_hash) };
}

for (const f of FORGERIES) {
    bridgeRailSuite(GROUP, function () {
        it('policy AT4 (falsification): a mirrored snapshot carrying ' + f.name + ' applies nothing and logs exactly one refusal naming snapshot_id', async function () {
            this.timeout(0);
            if (needsFederation(this, 'policy AT4 ' + f.name)) return;
            const row = f.build(f.tick + String(Date.now() % 100000));
            const got = await injectAndObserve(row);
            state.evidence['at4_' + f.tick] = Object.assign({ snapshotId: row.snapshot_id }, got);
            assert.strictEqual(got.settled, 0, 'the DOGE ledger recorded a policy settlement for a snapshot carrying ' + f.name);
            assert.strictEqual(got.hashAfter, got.hashBefore, 'the DOGE ledger_hash moved across a snapshot carrying ' + f.name);
            assert.strictEqual(got.lines.length, 1, 'the DOGE indexer logged ' + got.lines.length + ' line(s) naming ' +
                row.snapshot_id.slice(0, 16) + ' (mirrored: ' + got.mirrored + '): ' + JSON.stringify(got.lines));
        });
    });
}

bridgeRailSuite(GROUP, function () {
    it('policy AT4 (seq gap setup): a second listed token bridges and DOGE applies its seq 1', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT4 seq gap setup')) return;
        const G = state.policy.gap;
        G.member1 = await fundDoge('POLICY.AT4.MEMBER1', 1);
        G.member2 = await fundDoge('POLICY.AT4.MEMBER2', 1);
        G.dest = await fundDoge('POLICY.AT4.DEST', 2);
        Object.assign(G, await listedToken('AT4GAP', ['GAPA', 'GAPB', 'GAPC'], [G.member1.address]));
        assert.strictEqual(G.optIn.status, 'valid', 'ISSUE|7 of the gap token graded ' + G.optIn.status);
        const lock = await btcAction(G.issuer, lockWireV3(G.tick, 'DOGE', G.dest.address, 1, 'policy AT4 gap'), 'xbridges');
        assert.strictEqual(lock.status, 'valid', 'the gap token lock graded ' + lock.status);
        await settleLeg('the policy AT4 gap lock', (r) => String(r.dest_address) === G.dest.address && String(r.tick) === G.tick, 'DOGE');
        G.seq1 = await waitForFinalizedSeq(G.tick, 1);
        await waitForAppliedSeq(G.tick, 1);
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT4 (seq gap): a signed seq 3 with seq 2 absent applies its full membership with one log line, and the federation then restores the origin policy as seq 4', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT4 seq gap')) return;
        const G = state.policy.gap;
        assert.ok(G.seq1, 'the seq gap setup must have run');
        const row = HUB.signRecord(HUB.buildPolicyRow({
            snapshotBlock: Number(G.seq1.snapshot_block), originChain: 'BTC', tick: G.tick, policySeq: 3,
            originBlock: Number(G.seq1.origin_block), effectiveTime: Number(G.seq1.effective_time), network: String(G.seq1.network),
            view: Number(G.seq1.finalizing_view || 0), btcChainId: G.seq1.btc_chain_id, block: [G.member2.address],
        }), venueSigners());
        await state.venue.dogeVenue.injectMirrorRow(row, { table: 'policy_snapshots', key: ['snapshot_id'],
            hubs: state.venue.hubs.map((h) => h.index) });
        const applied = await waitForAppliedSeq(G.tick, 3);
        const copyAt3 = await copyPolicy(G.tick);
        const lines = policyLines(row.snapshot_id);
        const seq4 = await waitForFinalizedSeq(G.tick, 4);
        await waitForAppliedSeq(G.tick, 4);
        const copyAt4 = await copyPolicy(G.tick);
        state.evidence.at4_seqGap = { snapshotId: row.snapshot_id, applied, copyAt3, lines, seq4: seq4 && seq4.snapshot_id,
            copyAt4, ledger: await appliedLedger(G.tick) };
        assert.strictEqual(applied.snapshotId, row.snapshot_id, 'DOGE applied ' + applied.snapshotId + ' at seq 3');
        assert.deepStrictEqual(copyAt3.block_list, [G.member2.address], 'seq 3 did not materialize its full membership: ' + JSON.stringify(copyAt3.block_list));
        assert.strictEqual(lines.length, 1, 'the DOGE indexer logged ' + lines.length + ' line(s) naming seq 3: ' + JSON.stringify(lines));
        assert.strictEqual(Number(seq4.policy_seq), 4, 'the federation restored the origin policy as seq ' + seq4.policy_seq);
        assert.deepStrictEqual(copyAt4.block_list, [G.member1.address], 'after seq 4 the copy reads ' + JSON.stringify(copyAt4.block_list));
    });
});
