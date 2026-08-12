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
 * XChain Platform E2E - BET live WebSocket channel (spec §11.1, P7 verify line)
 *
 * P7 built the `bet_feed:{index}` entity channel and its unit coverage; this is
 * the leg that was left open: observing it deliver over a real socket against
 * the running explorer. It exercises the whole real-time path, indexer write ->
 * explorer ChangeDetector -> Broadcaster (coin-keyed fan-out) -> WebSocketServer
 * -> SDK dispatch, the same pipeline websocketLive.sdk.test.js covers for the
 * generic `actions` feed.
 *
 * WHY THE CHANNEL NEEDS ITS OWN DRILL rather than riding the generic feed: the
 * routing here is not "an action happened". BET events are keyed on the PARENT
 * market (data.feed_action_index, resolved by getBetActionFeedIndex), so a page
 * subscribed to ONE market must receive bets placed by strangers on that market
 * and nothing from any other. A resolver that returned the action's own index
 * instead of its parent would still deliver events, just to a channel nobody is
 * listening on, which no unit test of the resolver alone would notice.
 *
 * WHAT THIS DRILL PINS about the payload: BET is ONE action name carrying four
 * formats, and the ChangeDetector maps all of them to a single `BET` event type.
 * Without a format discriminator a subscriber is told only "a BET happened" and
 * cannot tell a stake placed (v2) from the payout decision (v3), which are
 * opposite facts for a market page. So the drill asserts `data.action_format` is
 * present and correct, not merely that some event arrived.
 *
 * THE LATCH LEG (closed 2026-07-26). This drill originally asserted the
 * ABSENCE of a close event: the latch is a direct status write in the end-of-block
 * pass with no action row (spec §6), so the ChangeDetector's `actions` cursor had
 * nothing to see and a market page learned that betting had closed only on its next
 * fetch. The explorer now runs a SECOND cursor over `bet_feeds.closed_block` and
 * emits BET_CLOSED, so the assertion is inverted to demand the event. It stays an
 * e2e rather than a unit case because the two halves are structurally blind to each
 * other: the cursor's unit tests stub the query, and only a real latch on a real
 * chain proves the column is stamped, polled, routed to the parent market and
 * accepted by the subscribe filter in one piece.
 *
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk:bet-ws
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, fundedGasAddress } = require('./sdkHelper');
const {
    MIN_REFUND_WINDOW, getFeed, blockTime, jumpTo, releaseClock, resumeMiningAtFrozenClock,
    waitFeedStatus, issueWagerToken, submitBet, actionIndexOf
} = require('./betHelper');

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

// Poll a predicate over collected events until it matches or we time out.
async function waitFor(predicate, timeoutMs = 90000, pollMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const hit = predicate();
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, pollMs));
    }
}

const BET_FORMAT = { CREATE: 0, CANCEL: 1, PLACE: 2, RESOLVE: 3 };

describe('[sdk] BET live websocket channel (§11.1 P7)', function () {
    this.timeout(0);

    let sdk, oracle, punter, tick, events, collector, feedIndex;

    before(async function () {
        if (!haveConnectors()) this.skip();
        // See bet.sdk.test.js: ^id compaction outruns the indexer's wire acceptance.
        sdk = makeSdk({ compactAddresses: false });
        await sdk.connectWs();
        events = [];
        // Collect EVERYTHING the socket pushes, then filter per assertion. A
        // per-type listener would hide the interesting failure, which is an event
        // arriving on the wrong channel or under the wrong type.
        collector = (msg) => { events.push(msg); };
        sdk.ws.on('*', collector);
        oracle = await fundedGasAddress(sdk, 1);
        punter = await fundedGasAddress(sdk, 1);
        tick = await issueWagerToken(sdk, oracle, [[punter.address, '10.00000000']], 1000000, 'BWS');
    });

    after(async function () {
        try { if (collector) sdk.ws.off('*', collector); } catch (e) { /* ignore */ }
        try { sdk.disconnectWs(); } catch (e) { /* ignore */ }
        await releaseClock();
    });

    it('subscribing to one market is confirmed by the server', async function () {
        const now = await blockTime();
        const deadline = now + 900;

        const res = await submitBet(sdk, oracle, sdk.betting.createMarketParams({
            label: 'P7 ws channel', outcomes: ['Yes', 'No'], tick,
            fee: '1.00', deadline, refundWindow: MIN_REFUND_WINDOW, now
        }));
        expect(res.indexed.status, 'create status').to.equal('valid');
        feedIndex = actionIndexOf(res);

        const confirmation = await sdk.ws.subscribeBetFeed(feedIndex);
        expect(confirmation, 'the server answered the subscribe').to.be.an('object');
        expect(sdk.ws.isConnected(), 'still connected after subscribing').to.equal(true);
    });

    it('pushes a bet placed by SOMEONE ELSE on the subscribed market', async function () {
        expect(feedIndex, 'the previous test subscribed').to.not.equal(undefined);
        const before = events.length;

        const bet = await submitBet(sdk, punter, sdk.betting.placeBetParams({
            feedActionIndex: feedIndex, outcome: 0, amount: '3.00000000' }));
        expect(bet.indexed.status, 'the bet is valid').to.equal('valid');
        const betIndex = actionIndexOf(bet);

        // The event must be keyed on the MARKET, not on the bet's own index: that
        // parent resolution is the whole point of the channel.
        const evt = await waitFor(() => events.slice(before).find((e) =>
            e && e.type === 'BET' && e.data
            && Number(e.data.action_index) === Number(betIndex)));

        if (!evt) {
            const seen = events.slice(before).map((e) => e && e.type).filter(Boolean);
            throw new Error(
                'No BET event for the placed bet arrived over the WebSocket within 90s. '
                + 'The bet_feed channel is not delivering (parent resolution, broadcaster '
                + 'coin key, or the subscription itself). Events seen: [' + seen.join(', ') + ']');
        }
        expect(Number(evt.data.feed_action_index), 'event is keyed on the parent market')
            .to.equal(Number(feedIndex));
        expect(Number(evt.data.action_format), 'event says WHICH BET format this was')
            .to.equal(BET_FORMAT.PLACE);
        expect(evt.data.source, 'event carries the bettor, not the oracle')
            .to.equal(punter.address);
    });

    it('pushes the resolve, distinguishable from the bet by its format alone', async function () {
        expect(feedIndex, 'the market exists').to.not.equal(undefined);
        const feed = await getFeed(feedIndex);
        const before = events.length;

        // Betting has to close before the oracle may resolve.
        await jumpTo(Number(feed.deadline) + 120, 2);
        const latched = await waitFeedStatus(feedIndex, 'closed');
        expect(latched.feed_status, 'feed latched closed').to.equal('closed');

        // jumpTo parks the auto-miner for an hour so no block can slip in below the
        // target timestamp, and the resolve below is broadcast rather than mined by
        // this drill, so without this the tx sits in the mempool until the after()
        // hook unparks the miner and the SDK's index wait expires first. Every other
        // clock-driven family already pairs the two (betExpiry, betTerminal). This
        // drill passed on BTC only because some other suite had left that venue's
        // miner in default mode; on LTC it failed the same way twice, which is what
        // a drill relying on venue luck looks like when the luck runs out.
        await resumeMiningAtFrozenClock();

        const res = await submitBet(sdk, oracle, sdk.betting.resolveMarketParams({
            feedActionIndex: feedIndex, outcome: 0 }));
        expect(res.indexed.status, 'resolve is valid').to.equal('valid');
        const resolveIndex = actionIndexOf(res);

        const evt = await waitFor(() => events.slice(before).find((e) =>
            e && e.type === 'BET' && e.data
            && Number(e.data.action_index) === Number(resolveIndex)));

        if (!evt) {
            const seen = events.slice(before).map((e) => e && e.type).filter(Boolean);
            throw new Error(
                'No BET event for the resolve arrived over the WebSocket within 90s. '
                + 'Events seen: [' + seen.join(', ') + ']');
        }
        expect(Number(evt.data.feed_action_index), 'resolve is keyed on the market')
            .to.equal(Number(feedIndex));
        // The assertion the format discriminator exists for: a stake and a payout
        // decision arrive under the identical `type`, so this number is the only
        // thing telling a market page which one it just received.
        expect(Number(evt.data.action_format), 'resolve is format 3, not the bet format 2')
            .to.equal(BET_FORMAT.RESOLVE);
        expect(evt.data.source, 'resolve comes from the oracle').to.equal(oracle.address);
    });

    it('pushes the deadline latch, the one transition with no action behind it', async function () {
        // The latch happened during the resolve test (waitFeedStatus saw `closed`),
        // so if the channel emitted it, it is already in `events`. Given the
        // subscribe in test 1 the whole lifecycle has been collected, and the poll
        // interval is seconds, so a short wait covers a latch observed just now.
        const evt = await waitFor(() => events.find((e) =>
            e && e.type === 'BET_CLOSED' && e.data
            && Number(e.data.feed_action_index) === Number(feedIndex)), 30000);

        if (!evt) {
            const seen = events.map((e) => e && e.type).filter(Boolean);
            throw new Error(
                'The market latched closed but no BET_CLOSED arrived on the bet_feed '
                + 'channel. The latch writes no action row, so this event comes from the '
                + 'explorer ChangeDetector\'s second cursor over bet_feeds.closed_block: '
                + 'check that cursor, its VALID_TYPES entry, and the parent routing. '
                + 'Events seen: [' + seen.join(', ') + ']');
        }

        const feed = await getFeed(feedIndex);
        // The event must name the block the latch was STAMPED in. A cursor that
        // reported its own poll height instead would still deliver an event, and a
        // page rendering "closed at block N" would quietly show the wrong block.
        expect(Number(feed.closed_block), 'the latch is readable on the feed row')
            .to.be.greaterThan(0);
        expect(Number(evt.data.block_index), 'the event names the latch block, not the poll')
            .to.equal(Number(feed.closed_block));
        // No causing action, by design: this is what separates it from every other
        // event on the channel and why the second cursor had to exist at all.
        expect(evt.data.tx_hash, 'the latch has no causing transaction').to.equal(null);
        expect(evt.data.synthetic, 'flagged as actionless, matching the REST timeline').to.equal(true);
        // The TRANSITION, not the live status: by the time this asserts, the feed has
        // already been resolved by the previous test.
        expect(evt.data.status, 'reports the close itself').to.equal('closed');

        const latches = events.filter((e) => e && e.type === 'BET_CLOSED' && e.data
            && Number(e.data.feed_action_index) === Number(feedIndex));
        expect(latches.length, 'the latch is one-way and must push exactly once').to.equal(1);
    });
});
