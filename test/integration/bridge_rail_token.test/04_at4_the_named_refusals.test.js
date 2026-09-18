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
 * Token AT4: the named refusals. Every verdict below is the token spec section 5 string
 * the indexer's XBridge.VERDICTS carries, asserted verbatim: a regex on `invalid: `
 * would pass a lock refused for funds and call it a shape refusal.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    lockWireV3,
    burnWireV4,
    issueHelper,
    GAS_TICK,
    state,
    btcAction,
    dogeAction,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

const GROUP = 'token AT4: the named refusals';

bridgeRailSuite(GROUP, function () {
    it('token AT4: v4 on a native row, v3 of the GAS tick, v3 of a dotted native tick, v3 of a 247-character tick and a broadcast v5 are each refused with the named verdict', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT4 origin side')) return;
        const T = state.tokens;
        assert.ok(state.evidence.at1_dogeChild, 'AT1 must have run');
        const r = {};
        r.v4OnNative = await btcAction(T.issuer, burnWireV4(T.tick, T.issuer.address, 1, 'AT4'), 'xbridges');
        r.v3OfGas = await btcAction(T.issuer, lockWireV3(GAS_TICK, 'DOGE', T.dest.address, 1, 'AT4'), 'xbridges');
        // A real subasset of the native row, so the dotted refusal is about the SHAPE and
        // not about an unknown tick.
        const sub = T.tick + '.SUB';
        r.subIssue = await btcAction(T.issuer, () => issueHelper.sendIssueV0Raw(T.issuer, sub, 100, 100, 0, 'AT4 sub', 10), 'issues');
        r.v3OfDotted = await btcAction(T.issuer, lockWireV3(sub, 'DOGE', T.dest.address, 1, 'AT4'), 'xbridges');
        // 247 characters: `BTC.` plus 247 is 251, one over MAX_TICK_LENGTH on the destination.
        r.v3OfLong = await btcAction(T.issuer, lockWireV3('L'.repeat(247), 'DOGE', T.dest.address, 1, 'AT4'), 'xbridges');
        r.v5Broadcast = await btcAction(T.issuer, ['XBRIDGE', '5', T.tick, 'DOGE', T.dest.address, '1', 'AT4'].join('|'), 'xbridges');
        state.evidence.at4_origin = r;
        assert.strictEqual(r.v4OnNative.status, 'invalid: TICK (not bridged)', 'v4 on the native row graded ' + r.v4OnNative.status);
        assert.strictEqual(r.v3OfGas.status, 'invalid: TICK (use XBRIDGE v0)', 'v3 of ' + GAS_TICK + ' graded ' + r.v3OfGas.status);
        assert.strictEqual(r.subIssue.status, 'valid', 'the subasset issue graded ' + r.subIssue.status);
        assert.strictEqual(r.v3OfDotted.status, 'invalid: TICK (subassets are not bridgeable yet)', 'v3 of ' + sub + ' graded ' + r.v3OfDotted.status);
        assert.strictEqual(r.v3OfLong.status, 'invalid: TICK (too long to bridge)', 'v3 of a 247-character tick graded ' + r.v3OfLong.status);
        assert.strictEqual(r.v5Broadcast.status, 'invalid: XBRIDGE v5 is system-injected', 'a broadcast v5 graded ' + r.v5Broadcast.status);
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT4: a v3 on the bridged row and a DESTROY of BTC.<tick> on DOGE are refused with the named verdicts', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT4 destination side')) return;
        const T = state.tokens;
        assert.ok(state.evidence.at1_dogeChild, 'AT1 must have run');
        const r = {};
        r.v3OnBridged = await dogeAction(T.dest, lockWireV3(T.bridged, 'BTC', T.issuer.address, 1, 'AT4'), 'xbridges');
        r.destroyCopy = await dogeAction(T.dest, ['DESTROY', '0', T.bridged, '1', 'AT4'].join('|'), 'destroys');
        state.evidence.at4_destination = r;
        assert.strictEqual(r.v3OnBridged.status, 'invalid: TICK (not native here)', 'v3 of ' + T.bridged + ' on DOGE graded ' + r.v3OnBridged.status);
        assert.strictEqual(r.destroyCopy.status, 'invalid: TICK (use XBRIDGE v4)', 'DESTROY of ' + T.bridged + ' graded ' + r.destroyCopy.status);
    });
});

bridgeRailSuite(GROUP, function () {
    it('token AT4: an ISSUE|7 below TOKEN_BRIDGE_ACTIVATION is invalid: VERSION (unknown)', function () {
        // Not drivable on this rail: the activation is height 0 on regtest, so no block a
        // drive can broadcast into is below it. The below-activation verdict is the
        // indexer's own unit coverage; named here so the frontier can tell "not driven
        // because it cannot be" from "not written".
        console.log('  token AT4 below-activation leg NOT DRIVABLE on regtest (TOKEN_BRIDGE_ACTIVATION is 0); unit-covered in xchain-indexer');
        this.skip();
    });
});
