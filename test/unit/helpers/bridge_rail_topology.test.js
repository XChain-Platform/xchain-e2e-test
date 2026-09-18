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
 * The rail venue's topology and the policy drive's pure layer.
 *
 * Three decisions a rail drive can only otherwise discover hours in:
 *   each venue hub reads its OWN BTC indexer (a retraction is co-signed only by a hub
 *     whose own indexer pushed the reorg, so one shared indexer can never retract);
 *   a mesh that names a venue never falls back to the standing indexer's URL;
 *   the policy cap leg holds the ledger to the indexer's own apply order.
 *
 * Nothing here touches a chain, a database or a socket.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    hubIndexerEnvMap,
    venueBtcIndexerCount,
    listCreateWire,
    listEditWire,
    policyListsWire,
    controllerBindWire,
    sleepTickWire,
    sendWireV0,
    policyDueOrder,
    policyCapOrderReading,
} = require('../../helpers/bridgeRailVenue');
const { hubExtraEnvFor } = require('../../helpers/attestMirrorVenue');
const { resolveMeshBtcIndexerUrl } = require('../../helpers/multiValidatorHubHelper');

describe('bridge rail venue: one BTC indexer per hub (token rail finding 3)', function () {

    const three = [
        { index: 0, followsHub: 0, apiUrl: 'http://127.0.0.1:45010' },
        { index: 1, followsHub: 1, apiUrl: 'http://127.0.0.1:45011' },
        { index: 2, followsHub: 2, apiUrl: 'http://127.0.0.1:45012' },
    ];

    it('points every hub at the indexer that follows it, never at a shared one', function () {
        const map = hubIndexerEnvMap(three, 'BTC');
        assert.deepStrictEqual(map, {
            0: { BTC_INDEXER_URL: 'http://127.0.0.1:45010' },
            1: { BTC_INDEXER_URL: 'http://127.0.0.1:45011' },
            2: { BTC_INDEXER_URL: 'http://127.0.0.1:45012' },
        });
        const urls = Object.values(map).map((e) => e.BTC_INDEXER_URL);
        assert.strictEqual(new Set(urls).size, three.length, 'two hubs share an origin indexer');
    });

    it('replaces one hub\'s endpoint with an override and leaves the others on their own', function () {
        const map = hubIndexerEnvMap(three, 'btc', { 1: 'http://127.0.0.1:1' });
        assert.strictEqual(map[1].BTC_INDEXER_URL, 'http://127.0.0.1:1');
        assert.strictEqual(map[0].BTC_INDEXER_URL, 'http://127.0.0.1:45010');
        assert.strictEqual(map[2].BTC_INDEXER_URL, 'http://127.0.0.1:45012');
    });

    it('refuses two indexers on one hub and an unknown chain', function () {
        assert.throws(() => hubIndexerEnvMap([three[0], Object.assign({}, three[1], { followsHub: 0 })], 'BTC'),
            /two indexers follow hub 0/);
        assert.throws(() => hubIndexerEnvMap(three, 'ETH'), /unknown chain ETH/);
    });

    it('stands up one BTC indexer per hub unless opted out or served by the standing indexer', function () {
        assert.strictEqual(venueBtcIndexerCount(3, undefined, null), 3);
        assert.strictEqual(venueBtcIndexerCount(3, true, null), 3);
        assert.strictEqual(venueBtcIndexerCount(3, false, null), 1);
        assert.strictEqual(venueBtcIndexerCount(3, true, 'http://standing:3024'), 1);
        assert.throws(() => venueBtcIndexerCount(0, true, null), /positive integer/);
    });

    it('spawns a hub with its own overlay over the venue-wide env, and an unset hub with the venue object itself', function () {
        const venueWide = { XBRIDGE_POLL_MS: '15000', BTC_INDEXER_URL: 'http://shared:1' };
        const perHub = hubIndexerEnvMap(three, 'BTC');
        assert.deepStrictEqual(hubExtraEnvFor(venueWide, perHub, 2),
            { XBRIDGE_POLL_MS: '15000', BTC_INDEXER_URL: 'http://127.0.0.1:45012' });
        assert.strictEqual(hubExtraEnvFor(venueWide, {}, 0), venueWide);
        assert.strictEqual(hubExtraEnvFor(null, undefined, 0), null);
    });
});

describe('MultiValidatorHub: a venue names its own indexer (token rail finding 2)', function () {

    const railEnv = { INDEXER_URL: 'xchain-node-indexer', INDEXER_API_PORT: '3024' };

    it('uses the venue\'s URL and ignores a rail host\'s indexer env', function () {
        const url = resolveMeshBtcIndexerUrl({ venue: 'pending source', btcIndexerApiUrl: 'http://127.0.0.1:5555/pending/shared/BTC' },
            Object.assign({ BTC_INDEXER_API_URL: 'http://standing:3024' }, railEnv));
        assert.strictEqual(url, 'http://127.0.0.1:5555/pending/shared/BTC');
    });

    it('refuses a venue that passed no URL instead of reading the standing indexer', function () {
        assert.throws(() => resolveMeshBtcIndexerUrl({ venue: 'pending source' }, railEnv),
            /venue pending source passed no btcIndexerApiUrl.*http:\/\/xchain-node-indexer:3024/);
    });

    it('keeps the historical precedence for a caller that names no venue', function () {
        assert.strictEqual(resolveMeshBtcIndexerUrl({}, railEnv), 'http://xchain-node-indexer:3024');
        assert.strictEqual(resolveMeshBtcIndexerUrl({}, { BTC_INDEXER_API_URL: 'http://a:1' }), 'http://a:1');
        assert.strictEqual(resolveMeshBtcIndexerUrl({ btcIndexerApiUrl: 'http://b:2' }, railEnv), 'http://b:2');
        assert.strictEqual(resolveMeshBtcIndexerUrl({}, {}), 'http://localhost:12001');
    });
});

describe('bridge rail policy drive: the wires', function () {

    it('spells each policy action in the indexer\'s own field order', function () {
        assert.strictEqual(listCreateWire(2, ['nA', 'nB'], 'm'), 'LIST|0|2|m|nA|nB');
        assert.strictEqual(listEditWire(1, 812, ['nC'], ''), 'LIST|1|1|812||nC');
        assert.strictEqual(listEditWire(2, 812, ['nA'], 'x'), 'LIST|1|2|812|x|nA');
        assert.strictEqual(policyListsWire('POLA', null, 812, 'attach'), 'ISSUE|5|POLA||812|attach');
        assert.strictEqual(controllerBindWire('CTRL', 77, 'transfer', 0, 'b'), 'ISSUE|6|CTRL|77|transfer|0|0|b');
        assert.strictEqual(sleepTickWire('POLA', -1, 's'), 'SLEEP|1|-1|POLA|s');
        assert.strictEqual(sendWireV0('BTC.POLA', 1, 'nD', ''), 'SEND|0|BTC.POLA|1|nD|');
    });

    it('refuses an edit verb other than add or remove, and an edit with no items', function () {
        assert.throws(() => listEditWire(3, 1, ['a']), /must be 1 \(add\) or 2 \(remove\)/);
        assert.throws(() => listEditWire(1, 1, []), /at least one item/);
    });
});

describe('bridge rail policy drive: the apply order and the cap', function () {

    const row = (id, tick, seq, block) => ({ snapshot_id: id, origin_chain: 'BTC', tick: tick, policy_seq: seq, snapshot_block: block || 900 });
    const applied = (id, block, index) => ({ transfer_id: id, block_index: block, action_index: index });

    // Two ticks, three seqs each, one snapshot_block: tick B's group ranks first by its
    // lowest snapshot_id, and seq orders within a group whatever the ids say.
    const six = [row('f1', 'A', 1), row('a9', 'A', 2), row('c3', 'A', 3), row('b2', 'B', 1), row('01', 'B', 2), row('e7', 'B', 3)];

    it('orders by snapshot_block, then tick group by its lowest id, then policy_seq, as the indexer does', function () {
        assert.deepStrictEqual(policyDueOrder(six.slice().reverse()), ['b2', '01', 'e7', 'f1', 'a9', 'c3']);
        assert.deepStrictEqual(policyDueOrder([row('zz', 'A', 1, 901), row('aa', 'B', 1, 900)]), ['aa', 'zz']);
    });

    it('reads 5 then 1 when six due snapshots apply in the pinned order', function () {
        const order = ['b2', '01', 'e7', 'f1', 'a9', 'c3'];
        const settlements = order.map((id, i) => applied(id, i < 5 ? 7000 : 7001, 100 + i));
        const r = policyCapOrderReading(six, settlements, 5);
        assert.strictEqual(r.ok, true, r.reason);
        assert.deepStrictEqual(r.groups, [{ block: 7000, count: 5 }, { block: 7001, count: 1 }]);
    });

    it('fails a snapshot applied before one that sorts ahead of it, inside one block', function () {
        const order = ['b2', '01', 'e7', 'f1', 'a9', 'c3'];
        const settlements = order.map((id, i) => applied(id, i < 5 ? 7000 : 7001, 100 + i));
        settlements[0].action_index = 104;
        settlements[4].action_index = 100;
        const r = policyCapOrderReading(six, settlements, 5);
        assert.strictEqual(r.ok, false);
        assert.match(r.reason, /snapshot 01 applied at block 7000 index 101, not after the snapshot that sorts before it/);
    });

    it('fails six in one block against a cap of five, and an unapplied snapshot', function () {
        const settlements = ['b2', '01', 'e7', 'f1', 'a9', 'c3'].map((id, i) => applied(id, 7000, 100 + i));
        assert.match(policyCapOrderReading(six, settlements, 5).reason, /block 7000 applied 6 snapshots, over the cap of 5/);
        assert.match(policyCapOrderReading(six, settlements.slice(0, 5), 5).reason, /snapshot c3 was never applied/);
        assert.throws(() => policyCapOrderReading(six, settlements, 0), /cap must be a positive integer/);
    });
});
