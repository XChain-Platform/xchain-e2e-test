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
 * Token AT7: an ORDER of a DOGE-native token against BTC.FUFU matches and settles
 * locally on DOGE with no COINPAY leg (D46: ORDER only). The shape is the base drive's
 * AT5 same-chain pair, with the bridged copy in the XCHAIN seat.
 *
 ********************************************************************/

'use strict';

const {
    assert,
    issueHelper,
    EXPIRY,
    state,
    dogeAction,
    fundDoge,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

// The order_matches row for the maker/taker pair, polled on the venue DOGE ledger.
async function waitForMatch(makerIndex, takerIndex) {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
        const rows = await state.venue.queryIndexerDb('DOGE',
            'SELECT m.*, s.status AS status FROM order_matches m LEFT JOIN index_statuses s ON s.id = m.status_id ' +
            'WHERE (m.give_action_index = ? AND m.get_action_index = ?) OR (m.give_action_index = ? AND m.get_action_index = ?) LIMIT 1',
            [makerIndex, takerIndex, takerIndex, makerIndex]);
        if (rows.length) return rows[0];
        await new Promise((res) => setTimeout(res, 5000));
    }
    return null;
}

bridgeRailSuite('token AT7: a DOGE-native token ordered against the bridged copy', function () {
    it('token AT7: the ORDER matches and settles locally on DOGE with no COINPAY leg', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT7')) return;
        const T = state.tokens;
        assert.ok(state.evidence.at1_dogeChild, 'AT1 must have run');
        const maker = await fundDoge('TOKEN.AT7.MAKER', 5);
        let natv = null;
        for (const cand of ['NATV', 'NATW', 'NATX']) { if (!(await state.venue.hasTokenRow('DOGE', cand))) { natv = cand; break; } }
        assert.ok(natv, 'no free DOGE-native tick');
        const issue = await dogeAction(maker, () => issueHelper.sendIssueV0Raw(maker, natv, 1000, 1000, 0, 'AT7 native', 100), 'issues');
        assert.strictEqual(issue.status, 'valid', 'ISSUE ' + natv + ' graded ' + issue.status);
        const expiry = EXPIRY();
        const makerOrder = await dogeAction(maker, 'ORDER|0|DOGE|' + natv + '|1||DOGE|' + T.bridged + '|1|||' + expiry + '|||AT7', 'orders');
        assert.strictEqual(makerOrder.status, 'valid', 'the maker order graded ' + makerOrder.status);
        const takerOrder = await dogeAction(T.dest, 'ORDER|0|DOGE|' + T.bridged + '|1||DOGE|' + natv + '|1|||' + expiry + '|||AT7', 'orders');
        assert.strictEqual(takerOrder.status, 'valid', 'the taker order graded ' + takerOrder.status);

        const match = await waitForMatch(makerOrder.actionIndex, takerOrder.actionIndex);
        assert.ok(match, 'no order_matches row for ' + makerOrder.actionIndex + '/' + takerOrder.actionIndex + '\n' + state.venue.indexerTails(40));
        const obligations = await state.venue.queryIndexerDb('DOGE', 'SELECT * FROM coinpay_obligations WHERE action_index = ?', [String(match.action_index)]);
        state.evidence.at7 = { natv, issue, makerOrder, takerOrder,
            match: { actionIndex: String(match.action_index), settlementType: String(match.settlement_type), status: String(match.status) },
            coinpayObligations: obligations.length,
            makerBridged: await state.venue.addressBalance('DOGE', maker.address, T.bridged),
            takerNatv: await state.venue.addressBalance('DOGE', T.dest.address, natv) };
        assert.strictEqual(String(match.settlement_type), 'instant', 'the match settled as ' + match.settlement_type);
        assert.strictEqual(String(match.status), 'valid', 'the match is ' + match.status);
        assert.strictEqual(obligations.length, 0, 'a same-chain match produced ' + obligations.length + ' COINPAY obligation(s)');
        assert.strictEqual(Number(state.evidence.at7.makerBridged), 1, maker.address + ' holds ' + state.evidence.at7.makerBridged + ' ' + T.bridged);
        assert.strictEqual(Number(state.evidence.at7.takerNatv), 1, T.dest.address + ' holds ' + state.evidence.at7.takerNatv + ' ' + natv);
    });
});
