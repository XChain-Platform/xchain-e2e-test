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
 *********************************************************************/

'use strict';

const {
    assert,
    cryptoHelper,
    mintHelper,
    classifyInvariant,
    GAS_TICK,
    state,
    dogeAction,
    chainHalves,
    assertBacked,
    assertHubInvariantBacked,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function createSurplus(escrowAddr) {
    const before = await chainHalves();
    const hubBefore = classifyInvariant((await state.venue.bridgeInvariant(GAS_TICK))[GAS_TICK].DOGE);
    const sender = await state.venue.funded('AT6.SEND',
        () => cryptoHelper.getNewFundedAddress('AT6.SEND', 'bitcoin', NETWORK, null, 'legacy', 0, 1, false));
    await mintHelper.sendMintV0(sender, GAS_TICK, 1, sender.address, '');
    const sendHelper = require('../../helpers/sendHelper');
    await sendHelper.sendSendV0(sender, GAS_TICK, 1, escrowAddr, '');

    const inv = await state.venue.bridgeInvariant(GAS_TICK);
    const doge = inv[GAS_TICK].DOGE;
    const cls = classifyInvariant(doge);
    const after = await chainHalves();
    state.evidence.at6_surplus = { hub: doge, escrowAddr: escrowAddr, before: before, after: after,
        hubBefore: hubBefore, hubAfter: cls };
    return { before, hubBefore, inv, doge, cls, after };
}

// ── AT6 ────────────────────────────────────────────────────────────────────────
bridgeRailSuite('AT6: the invariant, the two closures and the D65 surplus', function () {

    it('reads equal on BTC and DOGE with nothing in flight', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT6 invariant')) return;
        const inv = await state.venue.bridgeInvariant(GAS_TICK);
        const doge = inv[GAS_TICK].DOGE;
        // BOTH readings recorded: the two chain halves the invariant is a claim about,
        // and the hub's own verdict over them. They can disagree, and which one is wrong
        // is the finding. `delta = escrow - (supply + in_flight)`; since the indexer's
        // pending read gained its settled filter the in_flight term drains to 0 and the
        // hub's delta is exactly the escrow's non-bridge credits (drive 18: 165 / 161 /
        // 0 / 4 against four plain SENDs), so the verdict is held to that measured term
        // rather than to the virgin rail's literal `equal`.
        const halves = await chainHalves();
        state.evidence.at6_invariant = { hub: doge, chainHalves: halves };
        assertBacked(halves, 'AT6');
        state.evidence.at6_hubReading = assertHubInvariantBacked(doge, halves, 'AT6');
        assert.strictEqual(String(doge.in_flight), '0');
    });
});

bridgeRailSuite('AT6: the invariant, the two closures and the D65 surplus', function () {
    it('refuses a DESTROY of XCHAIN on DOGE with invalid: TICK (use XBRIDGE v1)', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT6 DESTROY closure')) return;
        // Federation-gated NOT because the refusal needs one, but because `invalid:
        // TICK (unknown)` is checked FIRST in destroy.js: with no XCHAIN row on DOGE
        // the action refuses for the wrong reason and the case would pass while proving
        // nothing. So the row has to exist, which means AT1 has to have run.
        assert.ok(state.at1Dest, 'the DESTROY is signed by the address AT1 credited, so AT1 must have run');
        await state.venue.refreshVenuePrices();
        const got = await dogeAction(state.at1Dest, 'DESTROY|0|' + GAS_TICK + '|1|', 'destroys');
        state.evidence.at6_destroy = got;
        assert.strictEqual(got.status, 'invalid: TICK (use XBRIDGE v1)',
            'the DOGE closure wrote ' + got.status + ' for tx ' + got.tx);
    });
});

bridgeRailSuite('AT6: the invariant, the two closures and the D65 surplus', function () {
    it('reports a surplus of exactly 1 for DOGE after a plain SEND to the escrow, and the watch raises WARN not CRIT', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT6 D65 surplus')) return;

        const escrowAddr = await state.venue.roleAddress('BTC', 'BRIDGE_DOGE');
        assert.ok(escrowAddr, 'the BTC config carries no ADDRESS.BRIDGE_DOGE for ' + NETWORK);
        const { before, hubBefore, inv, doge, cls, after } = await createSurplus(escrowAddr);
        // The stray credit landed on the escrow and nowhere else: that is the D65 claim,
        // and it is asserted on the chain halves as well as on the hub's verdict.
        assert.strictEqual(Number(after.escrow) - Number(before.escrow), 1,
            'the escrow ' + escrowAddr + ' moved from ' + before.escrow + ' to ' + after.escrow +
            ' on a plain SEND of 1');
        assert.strictEqual(after.supply, before.supply,
            'the DOGE supply moved on a BTC-side stray credit, which it must not (D65)');
        // AND THE LEDGER RECORDED IT AS A NON-BRIDGE CREDIT, which is the other half of
        // D65: the unit reached the escrow through a SEND, no transfer record was created
        // for it, and nothing on the destination was minted against it. Asserted on the
        // measured term rather than inferred from the supply staying still.
        assert.strictEqual(Number(after.nonBridge.net) - Number(before.nonBridge.net), 1,
            'the non-bridge credits to ' + escrowAddr + ' moved from ' + before.nonBridge.net +
            ' to ' + after.nonBridge.net + ' on a plain SEND of 1, so the ledger did not ' +
            'record the stray credit as a non-bridge credit');
        assert.strictEqual(after.backed, before.backed,
            'the units BACKED by locks moved from ' + before.backed + ' to ' + after.backed +
            ' on a stray SEND, which mints nothing and therefore backs nothing (D65)');
        // THE HUB'S OWN VERDICT, asserted as a MOVEMENT. Its `delta` is
        // `escrow - (supply + in_flight)`, and on a rail with earlier stray SENDs the
        // absolute reading is already a surplus before this case runs (the invariant case
        // above holds it to the measured term). What THIS SEND must do is move it by
        // exactly one, in the surplus direction, which is the same claim with the rail's
        // history factored out. The absolute reading is in the evidence.
        assert.strictEqual(cls.delta - hubBefore.delta, 1,
            'the hub delta moved from ' + hubBefore.delta + ' to ' + cls.delta +
            ' on a plain SEND of 1 to the escrow, so the surplus it reports is not this ' +
            'stray credit: ' + JSON.stringify(doge));

        // THE WATCH ITEM, driven rather than described: the real classifier from
        // the platform's own watch script is handed the real answer.
        const watch = require('../../../../claude/scripts/xchain-watch.js');
        const items = watch.bridgeInvariantVerdicts([{ label: 'venue-hub-0', ok: true, byTick: inv }]);
        const forDoge = items.filter((i) => i.tick === GAS_TICK && i.chain === 'DOGE');
        state.evidence.at6_watch = forDoge.map((i) => ({ sev: i.sev, kind: i.kind }));
        assert.strictEqual(forDoge.length, 1);
        // D65's asymmetry, driven on the REAL hub answer and deliberately not on a
        // corrected copy of it. A CRIT here is not the classifier being wrong: it means
        // the hub read a deficit (an in_flight term that did not drain, or a destination
        // holding more than the escrow backs), which is a production finding, and feeding
        // this assertion a patched invariant would hide it.
        assert.strictEqual(forDoge[0].sev, 'warn',
            'the watch raised ' + forDoge[0].sev + '/' + forDoge[0].kind + ' on the hub answer ' +
            JSON.stringify(doge) + '. A deficit here with the chain halves level (escrow ' +
            after.escrow + ', non-bridge ' + after.nonBridge.net + ', supply ' + after.supply +
            ') is the in_flight term, not a real deficit.');
        assert.strictEqual(forDoge[0].kind, 'BRIDGE_INVARIANT_SURPLUS');
    });
});
