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
 * Token AT1: FUFU issued on BTC with BRIDGE_CHAINS=DOGE, a v3 lock of 5 to a DOGE
 * address; after the mirror DOGE holds child BTC.FUFU under the BTC root, owned by
 * ADDRESS.BRIDGE_BTC with decimals matching, the address is +5, supply 5, escrow 5, and a
 * user ISSUE of BTC.OTHER on DOGE is refused `parent issued by another address`.
 *
 * The BTC root was created by the retraction leg's ride-back (00_); this leg asserts the
 * child is created under it by ITS in-leg, absent before and present after.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    lockWireV3,
    optInWire,
    issueHelper,
    LOCK,
    DECIMALS,
    MINT,
    state,
    btcAction,
    dogeAction,
    fundBtc,
    fundDoge,
    tokenSnapshot,
    settleLeg,
    rowsLike,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'token AT1: a v3 lock of a BTC-native token to a DOGE address';

bridgeRailSuite(GROUP, function () {
    it('token AT1: issues the token on BTC, opts it in to DOGE with format 7, and the v3 lock credits the escrow by exactly ' + LOCK, async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT1 issue and lock')) return;
        assert.ok(state.baseline, 'the arming case must have run');
        const T = state.tokens;
        T.issuer = await fundBtc('TOKEN.ISSUER');
        const issue = await btcAction(T.issuer, () => issueHelper.sendIssueV0Raw(
            T.issuer, T.tick, 1000000, 1000000, DECIMALS, 'token AT1', MINT), 'issues');
        state.evidence.at1_issue = issue;
        assert.strictEqual(issue.status, 'valid', 'ISSUE ' + T.tick + ' on BTC graded ' + issue.status);

        const optIn = await btcAction(T.issuer, optInWire(T.tick, 'DOGE', '', '', 'token AT1 opt-in'), 'issues');
        state.evidence.at1_optIn = optIn;
        assert.strictEqual(optIn.status, 'valid', 'ISSUE|7 ' + T.tick + ' BRIDGE_CHAINS=DOGE graded ' + optIn.status);
        const btcRow = await state.venue.tokenParameters('BTC', T.tick);
        state.evidence.at1_btcRow = btcRow;
        assert.ok(btcRow && btcRow.ownerAddress === T.issuer.address, 'the BTC row is not owned by the issuer');
        assert.strictEqual(String(btcRow.params.bridge_chains), 'DOGE', 'the BTC row reads bridge_chains ' + btcRow.params.bridge_chains);

        T.dest = await fundDoge('TOKEN.AT1.DEST', 5);
        assert.strictEqual(await state.venue.hasTokenRow('DOGE', T.bridged), false,
            'DOGE already holds ' + T.bridged + ' before the AT1 lock');
        const before = await tokenSnapshot('at1_before_lock', T.tick, T.dest);
        const lock = await btcAction(T.issuer, lockWireV3(T.tick, 'DOGE', T.dest.address, LOCK, 'token AT1'), 'xbridges');
        state.evidence.at1_lock = lock;
        assert.strictEqual(lock.status, 'valid', 'XBRIDGE v3 lock of ' + LOCK + ' ' + T.tick + ' graded ' + lock.status);
        const after = await tokenSnapshot('at1_after_lock', T.tick, T.dest);
        assert.strictEqual(after.escrow - before.escrow, LOCK,
            'the BTC escrow for DOGE did not gain exactly ' + LOCK + ' ' + T.tick + ': ' + JSON.stringify(after.btc));
        // tokenParameters drops `bridged` from params on purpose (it differs between an origin row
        // and its copy), so the bit is read off the origin ledger directly.
        const bridgedBit = await state.venue.queryIndexerDb('BTC',
            'SELECT tk.bridged FROM tokens tk INNER JOIN index_tickers ti ON (ti.id=tk.tick_id) WHERE ti.tick=? LIMIT 1', [T.tick]);
        assert.strictEqual(String(bridgedBit[0] && bridgedBit[0].bridged), '1', 'the applied lock did not set the origin row\'s bridged bit');
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT1: the federation finalizes the lock and DOGE gains child BTC.<tick> owned by BRIDGE_BTC at the signed decimals, +' + LOCK + ' to the address, supply ' + LOCK, async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT1 mirror')) return;
        const T = state.tokens;
        assert.ok(state.evidence.at1_lock && state.evidence.at1_lock.status === 'valid', 'the lock half must have run');
        const leg = await settleLeg('the AT1 lock',
            (r) => String(r.src_chain) === 'BTC' && String(r.dest_chain) === 'DOGE' &&
                   String(r.dest_address) === T.dest.address && String(r.tick) === T.tick, 'DOGE');
        state.evidence.at1_transfer = leg.transfer;
        assert.strictEqual(leg.transfer.decimals, String(DECIMALS), 'the signed record carries decimals ' + leg.transfer.decimals);

        // The ticker keeps the first spelling any action interned (lookup is case-insensitive),
        // so a chain that saw a refused ISSUE of btc holds the root under that spelling.
        const root = await state.venue.tokenParameters('DOGE', ((await rowsLike('DOGE', 'BTC'))[0] || {}).tick || 'BTC');
        const child = await state.venue.tokenParameters('DOGE', T.bridged);
        state.evidence.at1_dogeRoot = root;
        state.evidence.at1_dogeChild = child;
        assert.ok(root, 'DOGE holds no BTC root row after the in leg');
        assert.ok(child, 'DOGE holds no ' + T.bridged + ' row after the in leg');
        assert.strictEqual(root.ownerAddress, state.evidence.bridgeRoleDoge, 'the BTC root on DOGE is owned by ' + root.ownerAddress);
        assert.strictEqual(child.ownerAddress, state.evidence.bridgeRoleDoge, T.bridged + ' on DOGE is owned by ' + child.ownerAddress);
        assert.strictEqual(String(child.params.decimals), String(DECIMALS), T.bridged + ' decimals ' + child.params.decimals);
        const snap = await tokenSnapshot('at1_after_mirror', T.tick, T.dest);
        assert.strictEqual(Number(snap.destBridged), LOCK, T.dest.address + ' holds ' + snap.destBridged + ' ' + T.bridged);
        assert.strictEqual(snap.supply, LOCK, T.bridged + ' supply on DOGE reads ' + snap.supply);
        assert.strictEqual(snap.escrow, LOCK, 'the BTC escrow holds ' + snap.escrow);
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT1: a user ISSUE of BTC.OTHER on DOGE is refused: parent issued by another address', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT1 closure')) return;
        const T = state.tokens;
        assert.ok(state.evidence.at1_dogeChild, 'the mirror half must have run');
        const r = await dogeAction(T.dest, () => issueHelper.sendIssueV0Raw(T.dest, 'BTC.OTHER', 1000, 1000, 0, 'token AT1 closure', 0), 'issues');
        state.evidence.at1_btcOtherIssue = r;
        assert.strictEqual(r.status, 'invalid: TICK (parent issued by another address)');
    });
});
