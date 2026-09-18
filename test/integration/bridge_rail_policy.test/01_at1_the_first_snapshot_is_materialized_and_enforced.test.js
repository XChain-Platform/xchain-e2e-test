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
 * Policy AT1: a BTC token with a BLOCK_LIST holding one DOGE-format address opts in with
 * format 7 (refused below the flag, applied above it); a v3 lock of 5 to a DOGE address;
 * after the mirror DOGE holds policy_snapshots seq 1, an injected type-2 LIST owned by
 * DOGE's ADDRESS.BRIDGE_BTC with that one member, BTC.<tick>'s BLOCK_LIST pointing at it and
 * ALLOW_LIST NULL, and a SEND of the copy to the blocked address is refused while a SEND to
 * any other address applies.
 *
 * THE REFUSAL STRING. The spec writes `invalid: BLOCK_LIST`; the indexer's send validator
 * refuses a destination its lists exclude with `invalid: DESTINATION (not authorized)`
 * (xchain-indexer src/actions/send/validate.js). The case asserts the indexer's string, the
 * behaviour a holder meets, and journals the spec's beside it.
 *
 ********************************************************************/

'use strict';

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
    hubPolicyRows,
    listOrigin,
    sendCopy,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'policy AT1: the first snapshot is materialized and enforced';
const LOCK = 5;

bridgeRailSuite(GROUP, function () {
    it('policy AT1 (opt-in): format 7 on a token with a BLOCK_LIST applies above the flag, and a v3 lock of 5 to DOGE is valid', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT1 opt-in')) return;
        assert.ok(state.baseline, 'the arming case must have run');
        const M = state.policy.main;
        M.blocked = await fundDoge('POLICY.AT1.BLOCKED', 1);
        M.other = await fundDoge('POLICY.AT1.OTHER', 1);
        M.dest = await fundDoge('POLICY.AT1.DEST', 5);
        Object.assign(M, await listedToken('AT1', ['POLA', 'POLB', 'POLC', 'POLD'], [M.blocked.address]));
        state.evidence.at1_optIn = { tick: M.tick, status: M.optIn.status, flagActive: M.flagActive };
        assert.strictEqual(M.flagActive, true, 'TOKEN_POLICY_INHERITANCE_ACTIVATION is not active at the BTC tip; ' +
            'every leg of this drive is written for the regtest rail, where it is 0');
        assert.strictEqual(M.optIn.status, 'valid', 'ISSUE|7 on a BLOCK_LIST token graded ' + M.optIn.status + ' above the flag');
        M.lock = await btcAction(M.issuer, lockWireV3(M.tick, 'DOGE', M.dest.address, LOCK, 'policy AT1'), 'xbridges');
        assert.strictEqual(M.lock.status, 'valid', 'the v3 lock of ' + M.tick + ' graded ' + M.lock.status);
    });

    // Spec AT1: "opts in with format 7 (refused below the flag, applied above it)". No block on
    // this chain is below TOKEN_POLICY_INHERITANCE_ACTIVATION (regtest 0); the indexer unit tier
    // carries the refusal verdict.
    it.skip('policy AT1 (below the flag): format 7 on a listed token is refused. NOT DRIVABLE on regtest: ' +
        '"refused below the flag", and TOKEN_POLICY_INHERITANCE_ACTIVATION is 0 here');
});

bridgeRailSuite(GROUP, function () {
    it('policy AT1 (mirror): DOGE holds seq 1, a bridge-owned type-2 LIST with the one member, and BTC.<tick> points its BLOCK_LIST at it', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT1 mirror')) return;
        const M = state.policy.main;
        assert.ok(M.lock && M.lock.status === 'valid', 'the opt-in half must have run');
        M.leg = await settleLeg('the policy AT1 lock',
            (r) => String(r.dest_address) === M.dest.address && String(r.tick) === M.tick, 'DOGE');
        const seq1 = await waitForFinalizedSeq(M.tick, 1);
        assert.strictEqual(Number(seq1.policy_seq), 1, 'the first finalized snapshot of ' + M.tick + ' is seq ' + seq1.policy_seq);
        const applied = await waitForAppliedSeq(M.tick, 1);
        const mirrored = await state.venue.queryMirrorDb('DOGE',
            "SELECT snapshot_id FROM policy_snapshots WHERE origin_chain = 'BTC' AND tick = ? AND policy_seq = 1", [M.tick]);
        const copy = await state.venue.tokenParameters('DOGE', 'BTC.' + M.tick);
        const origin = copy ? await listOrigin('DOGE', copy.params.block_list) : null;
        state.evidence.at1_mirror = { seq1: seq1.snapshot_id, applied, copyLists: copy && { allow: copy.params.allow_list,
            block: copy.params.block_list }, listOrigin: origin, hubRows: (await hubPolicyRows(M.tick)).length };
        assert.strictEqual(mirrored.length, 1, 'the DOGE mirror holds ' + mirrored.length + ' seq 1 rows for ' + M.tick);
        assert.strictEqual(applied.snapshotId, String(seq1.snapshot_id), 'DOGE applied ' + applied.snapshotId + ', not the finalized seq 1');
        assert.ok(copy, 'DOGE holds no BTC.' + M.tick + ' row');
        assert.strictEqual(copy.params.allow_list, null, 'BTC.' + M.tick + ' carries ALLOW_LIST ' + copy.params.allow_list);
        assert.ok(copy.params.block_list, 'BTC.' + M.tick + ' carries no BLOCK_LIST after seq 1 applied');
        assert.ok(origin, 'the BLOCK_LIST index ' + copy.params.block_list + ' names no LIST on DOGE');
        assert.strictEqual(String(origin.type), '2', 'the materialized list is type ' + origin.type);
        assert.strictEqual(origin.source, state.evidence.bridgeRoleDoge, 'the materialized list was created by ' + origin.source);
        assert.ok(String(origin.tx_hash).startsWith('XPOLICY-'), 'the materialized list came from tx ' + origin.tx_hash);
        const membership = await state.venue.indexerRpc('DOGE', 'gettokenpolicy',
            { tick: 'BTC.' + M.tick, origin_block: Number((await state.venue.venueTips()).DOGE) });
        assert.deepStrictEqual(membership.block_list, [M.blocked.address], 'the copy\'s block list reads ' + JSON.stringify(membership.block_list));
    });
});

bridgeRailSuite(GROUP, function () {
    it('policy AT1 (enforced): a SEND of the copy to the blocked address is refused and a SEND to another address applies', async function () {
        this.timeout(0);
        if (needsFederation(this, 'policy AT1 enforcement')) return;
        const M = state.policy.main;
        assert.ok(state.evidence.at1_mirror, 'the mirror half must have run');
        const blocked = await sendCopy(M.dest, M.tick, 1, M.blocked.address, 'policy AT1 blocked');
        const other = await sendCopy(M.dest, M.tick, 1, M.other.address, 'policy AT1 other');
        state.evidence.at1_sends = { blocked, other, specString: 'invalid: BLOCK_LIST' };
        assert.strictEqual(blocked.status, 'invalid: DESTINATION (not authorized)',
            'a SEND of BTC.' + M.tick + ' to the blocked address graded ' + blocked.status);
        assert.strictEqual(other.status, 'valid', 'a SEND of BTC.' + M.tick + ' to an unlisted address graded ' + other.status);
    });
});
