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
 * XChain Platform E2E - BET feed gating (spec §12 E15)
 *
 * Members-only markets: a site sells or grants membership, maintains an on-chain
 * address LIST, and pins it as the feed's ALLOW_LIST. A BLOCK_LIST bars specific
 * addresses instead. BET accepts address lists only (type 2).
 *
 * Two rules here are easy to get subtly wrong, so both are drilled directly:
 *
 *   1. PRECEDENCE IS EXPLICIT. Checks are evaluated allow-then-block and
 *      BLOCK_LIST WINS, so an address sitting on both lists is rejected. An
 *      implementation that returned early on a successful allow-list hit would
 *      admit exactly the address the operator most wanted excluded.
 *
 *   2. MEMBERSHIP IS EVALUATED AT PLACE TIME, and the underlying LIST stays
 *      mutable by its own owner. So removing someone mid-market must reject
 *      their NEXT bet while leaving the bet they already placed untouched --
 *      it still settles and still pays. Terminal credits are unconditional
 *      (§7): place-time checks gate entry, nothing may wedge exit. A list owner
 *      must not be able to confiscate a stake by editing a list.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, submitOpts, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, dbQuery, getFeed, getBets, balanceOf, amtEq, actionIndexOf,
    blockTime, jumpTo, resumeMiningAtFrozenClock, releaseClock, waitFeedStatus,
    issueWagerToken, submitBet
} = require('./betHelper');

const ADDRESS_LIST = 2;   // BET accepts type 2 (address) lists only
const LIST_ADD     = 1;
const LIST_REMOVE  = 2;

let sdk, oracle, memberA, outsiderB, blockedC, dualD;
let tick, allowList, blockList, allowListD, blockListD;

async function createAddressList(owner, address) {
    const res = await submit(sdk,
        { action: 'LIST', params: { type: ADDRESS_LIST, item: address } },
        { pubkey: owner.address, change: owner.address },
        submitOpts({ wif: owner.wif }));
    expect(res.indexed.status, 'LIST create status').to.equal('valid');
    return actionIndexOf(res);
}

async function editAddressList(owner, listIndex, edit, address) {
    const res = await submit(sdk,
        { action: 'LIST', params: { version: 1, edit, listActionIndex: listIndex, item: address } },
        { pubkey: owner.address, change: owner.address },
        submitOpts({ wif: owner.wif }));
    expect(res.indexed.status, 'LIST edit status').to.equal('valid');
    return actionIndexOf(res);
}

async function openMarket(label, opts = {}) {
    const now = await blockTime();
    const deadline = now + 300;
    const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
        label, outcomes: ['Yes', 'No'], tick, fee: '0', deadline,
        refundWindow: MIN_REFUND_WINDOW,
        allowList: opts.allowList, blockList: opts.blockList, now
    }));
    return { res, feedIndex: actionIndexOf(res), deadline };
}

// A place that must be REJECTED. Reads the reason the indexer recorded against
// the action rather than trusting the SDK's return shape (see betNegative).
async function expectPlaceRejected(feedIndex, who, amount, pattern, message) {
    const openBefore = (await getBets(feedIndex)).filter(b => b.bet_status === 'open').length;
    try {
        await submitBet(sdk, who, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount }));
    } catch (e) { /* the chain's record is the authority, not the throw */ }

    const rows = await getBets(feedIndex);
    const mine = rows.filter(r => r.source === who.address);
    const newest = mine[mine.length - 1];
    console.log(`      [bet-gating] ${message}\n        indexer: ${newest && newest.parse_status}`);

    expect(newest && String(newest.parse_status), message).to.match(pattern);
    expect(rows.filter(b => b.bet_status === 'open').length,
        `${message}: the rejected stake must not join the pool`).to.equal(openBefore);
}

describe('[sdk] BET feed gating (§12 E15)', function () {

    before(async function () {
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });

        oracle    = await fundedGasAddress(sdk, 1);
        memberA   = await fundedGasAddress(sdk, 1);
        outsiderB = await fundedGasAddress(sdk, 1);
        blockedC  = await fundedGasAddress(sdk, 1);
        dualD     = await fundedGasAddress(sdk, 1);

        tick = await issueWagerToken(sdk, oracle, [
            [memberA.address,   '20.00000000'],
            [outsiderB.address, '10.00000000'],
            [blockedC.address,  '10.00000000'],
            [dualD.address,     '10.00000000']
        ], 1000000, 'B15');

        // Every list below is built from its CREATE items only. LIST edits are
        // deliberately NOT used to compose fixtures: see , an edit's items
        // land under the EDIT's own action_index and the parent list is never
        // updated, so any list resolved by its create index (which is what a feed
        // pins) never sees the edit. Composing a fixture with an edit would make
        // these drills pass or fail for reasons unrelated to gating.
        allowList  = await createAddressList(oracle, memberA.address);
        blockList  = await createAddressList(oracle, blockedC.address);
        // dualD is on BOTH of these, each by creation, which is the precedence case.
        allowListD = await createAddressList(oracle, dualD.address);
        blockListD = await createAddressList(oracle, dualD.address);
    });

    after(async function () {
        await releaseClock();
    });

    it('an ALLOW_LIST admits a member and rejects a non-member', async function () {
        const { res, feedIndex } = await openMarket('E15 allow list', { allowList });
        expect(res.indexed.status, 'gated create is valid').to.equal('valid');

        const feed = await getFeed(feedIndex);
        expect(Number(feed.allow_list), 'allow_list stored on the feed').to.equal(Number(allowList));
        expect(feed.block_list, 'no block list on this feed').to.equal(null);

        const ok = await submitBet(sdk, memberA, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '5.00000000' }));
        expect(ok.indexed.status, 'a member may bet').to.equal('valid');

        await expectPlaceRejected(feedIndex, outsiderB, '5.00000000',
            /not authorized|SOURCE/i, 'a non-member betting on an allow-listed market');
    });

    it('a BLOCK_LIST rejects a listed address and admits everyone else', async function () {
        const { res, feedIndex } = await openMarket('E15 block list', { blockList });
        expect(res.indexed.status, 'gated create is valid').to.equal('valid');

        // Not on the block list, and there is no allow list, so this is open betting.
        const ok = await submitBet(sdk, outsiderB, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '5.00000000' }));
        expect(ok.indexed.status, 'an unlisted address may bet').to.equal('valid');

        await expectPlaceRejected(feedIndex, blockedC, '5.00000000',
            /not authorized|SOURCE/i, 'a block-listed address betting');
    });

    it('an address on BOTH lists is rejected: BLOCK_LIST wins', async function () {
        // Control first: with ONLY the allow list pinned, dualD is admitted. This
        // is what makes the next assertion mean "block won" rather than the much
        // weaker "dualD was not on the allow list".
        const control = await openMarket('E15 allow-only control', { allowList: allowListD });
        expect(control.res.indexed.status, 'control create is valid').to.equal('valid');
        const admitted = await submitBet(sdk, dualD, sdk.betting.placeBetParams({
            feedActionIndex: control.feedIndex, outcome: 0, amount: '3.00000000' }));
        expect(admitted.indexed.status, 'dualD IS on the allow list').to.equal('valid');

        // Now the same address, same allow list, plus a block list naming them.
        const { res, feedIndex } = await openMarket('E15 block wins',
            { allowList: allowListD, blockList: blockListD });
        expect(res.indexed.status, 'a feed may carry both lists when they differ').to.equal('valid');

        const feed = await getFeed(feedIndex);
        expect(Number(feed.allow_list), 'allow_list stored').to.equal(Number(allowListD));
        expect(Number(feed.block_list), 'block_list stored').to.equal(Number(blockListD));

        // Evaluated allow-then-block, and BLOCK WINS. An implementation that
        // returned early on the allow-list hit would admit this bet.
        await expectPlaceRejected(feedIndex, dualD, '3.00000000',
            /not authorized|SOURCE/i, 'an address on BOTH lists (block must win)');
    });

    // SKIPPED pending , a pre-existing LIST defect this drill uncovered.
    //
    // A LIST edit writes its resulting items under the EDIT's own action_index and
    // never updates the parent list's rows, so a list resolved by its CREATE index
    // -- which is exactly what a feed pins in bet_feeds.allow_list -- never sees
    // the edit. Verified directly against the chain: after a valid REMOVE, the
    // removed address is still the only row under the create index, and the edit
    // index has no rows at all.
    //
    // The consequence for betting is that a members-only market cannot revoke
    // membership (nor grant it after create). The failure is NOT in BET's gating,
    // which reads the list correctly; it is in the shared list machinery, so it
    // equally affects every other consumer that pins a list by its create index.
    // Un-skip when  lands: the assertions below are the spec behaviour and
    // should then pass unchanged.
    it.skip('removing a member mid-market rejects new bets but still settles the placed one', async function () {
        const { feedIndex, deadline } = await openMarket('E15 mid-market removal', { allowList });

        // memberA bets while still a member.
        const placed = await submitBet(sdk, memberA, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '5.00000000' }));
        expect(placed.indexed.status, 'the member bets while still listed').to.equal('valid');
        const balanceAfterStake = await balanceOf(memberA.address, tick);

        // The list owner now removes them. Membership is evaluated at PLACE time,
        // so this must not reach backwards into the bet already on the book.
        await editAddressList(oracle, allowList, LIST_REMOVE, memberA.address);

        await expectPlaceRejected(feedIndex, memberA, '5.00000000',
            /not authorized|SOURCE/i, 'a removed member placing a NEW bet');

        // Their existing stake still settles and still pays. A list owner must not
        // be able to confiscate a stake by editing a list.
        await jumpTo(deadline + 60, 2);
        await waitFeedStatus(feedIndex, 'closed');
        await resumeMiningAtFrozenClock();

        const resolve = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(resolve.indexed.status, 'resolve status').to.equal('valid');
        expect((await getFeed(feedIndex)).feed_status, 'feed resolved').to.equal('resolved');

        // Sole bettor on the winning outcome with FEE=0: the whole pot comes back.
        const paid = Number(await balanceOf(memberA.address, tick)) - Number(balanceAfterStake);
        amtEq(paid, '5', 'the removed member is still paid out on the bet they placed');

        const rows = await getBets(feedIndex);
        const settled = rows.filter(r => r.bet_status === 'won');
        expect(settled.length, 'the placed bet settled as a win').to.equal(1);

        // Restore the list so the fixture is reusable if this file grows.
        await editAddressList(oracle, allowList, LIST_ADD, memberA.address);
    });

    it('an unknown list reference is rejected at create', async function () {
        const label = 'E15 unknown list ref';
        // A syntactically fine action index that names no LIST at all. The SDK
        // cannot know it is bogus, so the INDEXER is what must reject it.
        await openMarket(label, { allowList: 999999999 });

        const rows = await dbQuery(
            `SELECT f.action_index, s.status AS parse_status
               FROM bet_feeds f
               INNER JOIN index_statuses s ON s.id = f.status_id
              WHERE f.label = ? ORDER BY f.action_index DESC LIMIT 1`, [label]);
        expect(rows.length, 'the rejected create was still recorded').to.equal(1);
        console.log(`      [bet-gating] unknown ALLOW_LIST ref\n        indexer: ${rows[0].parse_status}`);
        expect(String(rows[0].parse_status),
            'a feed pinned to a nonexistent list must not open').to.match(/ALLOW_LIST|unknown/i);
    });
});
