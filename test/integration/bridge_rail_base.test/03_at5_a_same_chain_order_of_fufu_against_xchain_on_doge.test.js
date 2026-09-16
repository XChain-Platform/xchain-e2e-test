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
    chainRail,
    cryptoHelper,
    issueHelper,
    GAS_TICK,
    EXPIRY,
    state,
    dogeAction,
    needsFederation,
    bridgeRailSuite,
} = require('./support');

async function prepareMaker() {
    // The venue's seeded DOGE/USD is older than the 1800 s an ISSUE will price
    // against by the time this case runs; see refreshVenuePrices. Recorded before the
    // reseed AND after it, so a later reader can tell a clock refusal from a pricing
    // one without re-running the drive: drive 11's red claimed the clock, and
    // `at5_price.before.stale` is the reading that either confirms that or refutes it.
    state.evidence.at5_price = { asThisCaseStarted: state.priceBeforeCase };
    // Right before the priced action, and CONFIRMED ON THE MIRROR the venue DOGE indexer
    // grades from: drive 18 reseeded the hub in front of this case and the indexer still
    // refused a row 48 minutes old, because the hub row is not the one it reads.
    const reseed = await state.venue.refreshVenuePrices();
    state.evidence.at5_price.reseed = reseed;
    state.evidence.at5_price.afterReseed = {
        hub: await state.venue.readVenuePrice('DOGE/USD'),
        mirror: await state.venue.readMirrorPrice('DOGE', 'DOGE/USD'),
    };
    assert.ok(reseed && reseed.mirrors.DOGE && reseed.mirrors.DOGE.confirmed,
        'the DOGE/USD and XCHAIN/USD reseed (round ' + (reseed ? reseed.round : 'none') +
        ') never reached the venue DOGE indexer\'s mirror, so the FUFU issue below would be ' +
        'priced against ' + JSON.stringify(state.evidence.at5_price.afterReseed.mirror) +
        ': ' + JSON.stringify(reseed && reseed.mirrors));
    const maker = await state.venue.funded('AT5.MAKER',
        () => chainRail.withRail(state.dogeRail, () => cryptoHelper.getNewFundedAddress(
            'AT5.MAKER', 'dogecoin', NETWORK, null, 'legacy', 0, 5, false)));

    // Raw, and read on the VENUE ledger: `sendIssueV0` waits on the standing DOGE
    // indexer's database, which is a different ledger from this one.
    const issue = await dogeAction(maker,
        () => issueHelper.sendIssueV0Raw(maker, 'FUFU', 1000, 1000, 0, 'AT5 base pair', 100),
        'issues');
    state.evidence.at5_issue = issue;
    return { maker, issue };
}

async function makeMakerOrder(maker) {
    const expiry = EXPIRY();
    // ORDER v0: VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|
    // GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|
    // MEMO. EXPIRATION is a unix timestamp and not a height; at a height-shaped value
    // both sides refuse `invalid: EXPIRATION (past)` before any tick logic runs.
    // GET_ADDRESS is left empty on both legs so they meet on the book rather than
    // being directed at each other, which is the same match a real pair makes.
    const makerOrder = await dogeAction(maker,
        'ORDER|0|DOGE|FUFU|1||DOGE|' + GAS_TICK + '|1|||' + expiry + '|||AT5 base pair', 'orders');
    state.evidence.at5_makerOrder = makerOrder;
    return { expiry, makerOrder };
}

async function makeTakerOrder(expiry) {
    const takerOrder = await dogeAction(state.at1Dest,
        'ORDER|0|DOGE|' + GAS_TICK + '|1||DOGE|FUFU|1|||' + expiry + '|||AT5 base pair', 'orders');
    state.evidence.at5_takerOrder = takerOrder;
    return takerOrder;
}

async function findMatch(makerOrder, takerOrder) {
    // The match is the indexer's own row, polled because it is written when the
    // second order's block is parsed and not when the broadcast returns.
    const deadline = Date.now() + 10 * 60 * 1000;
    let match = null;
    while (Date.now() < deadline && !match) {
        const rows = await state.venue.queryIndexerDb('DOGE',
            'SELECT m.*, s.status AS status FROM order_matches m ' +
            'LEFT JOIN index_statuses s ON s.id = m.status_id ' +
            'WHERE (m.give_action_index = ? AND m.get_action_index = ?) ' +
            '   OR (m.give_action_index = ? AND m.get_action_index = ?) LIMIT 1',
            [makerOrder.actionIndex, takerOrder.actionIndex,
             takerOrder.actionIndex, makerOrder.actionIndex]);
        if (rows.length) match = rows[0];
        else await new Promise((r) => setTimeout(r, 5000));
    }
    return match;
}

// ── AT5 ────────────────────────────────────────────────────────────────────────
bridgeRailSuite('AT5: a same-chain ORDER of FUFU against XCHAIN on DOGE', function () {

    it('matches and settles locally with no COINPAY', async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT5')) return;
        // The base-pair goal: once XCHAIN is a real balance on DOGE, a DOGE-native token
        // trades against it LOCALLY. Two orders, not one: a single ORDER names a price,
        // and the claim AT5 makes is about what happens when the two sides MEET. The
        // assertion that carries it is `settlement_type = 'instant'` on the match plus
        // the ABSENCE of any coinpay obligation against it, because a native-coin leg
        // would have produced both.
        assert.ok(state.at1Dest && state.baseline, 'AT5 trades against the XCHAIN AT1 bridged in, so AT1 must have run');
        const { maker, issue } = await prepareMaker();
        assert.strictEqual(issue.status, 'valid',
            'the FUFU issue on the venue DOGE ledger was graded ' + issue.status);

        const { expiry, makerOrder } = await makeMakerOrder(maker);
        assert.strictEqual(makerOrder.status, 'valid',
            'the FUFU-for-XCHAIN order was graded ' + makerOrder.status);

        const takerOrder = await makeTakerOrder(expiry);
        assert.strictEqual(takerOrder.status, 'valid',
            'the XCHAIN-for-FUFU order was graded ' + takerOrder.status);

        const match = await findMatch(makerOrder, takerOrder);
        assert.ok(match, 'the two DOGE-local orders (' + makerOrder.actionIndex + ' giving FUFU, ' +
            takerOrder.actionIndex + ' giving ' + GAS_TICK + ') never produced an order_matches row ' +
            'on the venue DOGE ledger.\n' + state.venue.indexerTails(40));
        state.evidence.at5_match = { actionIndex: String(match.action_index),
            settlementType: String(match.settlement_type), status: String(match.status) };
        assert.strictEqual(String(match.settlement_type), 'instant',
            'the DOGE-local FUFU/' + GAS_TICK + ' match settled as ' + match.settlement_type +
            ' rather than instant, which means it took the native-coin path this AT exists to rule out');
        assert.strictEqual(String(match.status), 'valid');

        // NO COINPAY, asserted against the match by id rather than by an empty-table
        // count, which would pass on a ledger where the tables were never built.
        const obligations = await state.venue.queryIndexerDb('DOGE',
            'SELECT * FROM coinpay_obligations WHERE action_index = ?', [String(match.action_index)]);
        state.evidence.at5_coinpayObligations = obligations.length;
        assert.strictEqual(obligations.length, 0,
            'the same-chain match raised ' + obligations.length + ' coinpay obligation(s)');

        // And the units actually moved, by identity on both sides.
        const makerXchain = await state.venue.addressBalance('DOGE', maker.address, GAS_TICK);
        const takerFufu   = await state.venue.addressBalance('DOGE', state.at1Dest.address, 'FUFU');
        state.evidence.at5_settled = { maker: maker.address, makerXchain: makerXchain,
            taker: state.at1Dest.address, takerFufu: takerFufu };
        assert.strictEqual(Number(makerXchain), 1,
            'the maker ' + maker.address + ' holds ' + makerXchain + ' ' + GAS_TICK + ' and not 1');
        assert.strictEqual(Number(takerFufu), 1,
            'the taker ' + state.at1Dest.address + ' holds ' + takerFufu + ' FUFU and not 1');
    });
});
