'use strict';

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
 ********************************************************************/

const assert = require('assert');
const drive = require('../../../helpers/oracleBatchDrive');
const { WINDOW_ROUNDS } = require('../helpers/pairs.test');
const { roundsOn } = require('../helpers/wire.test');

// Registers part of the assertions inside the caller's describe.
module.exports = function registerNeighbours(ctx) {
    it('the unfittable round poisoned nothing: its window still published its neighbours', function () {
        const { venue, signerSet, roundsB, pubsB, wiresA, wiresB, landedB, settleB } = ctx;
        const bigRound = venue.roundBase + WINDOW_ROUNDS + 2;
        const expected = roundsB.map((r) => r.round).filter((r) => r !== bigRound);

        assert.ok(settleB && settleB.settled,
            'window B was still emitting wires when the quiet window expired, so what it published is ' +
            'a snapshot of a race rather than the window\'s result.' + drive.railDiagnosis(venue, signerSet));
        assert.strictEqual(pubsB.length, 2,
            'window B holds three publishable rounds around one unpublishable one, so the packer must ' +
            'emit two wires ([' + expected.slice(0, 2).join(',') + '] and [' + expected[2] + ']); it ' +
            'emitted ' + pubsB.length + '. Zero means the ceiling aborted the whole window, which is ' +
            'the failure mode this assertion exists to catch.' + drive.railDiagnosis(venue, signerSet));

        for (const p of wiresB) assert.ok(p.ok, 'a window B wire does not parse: ' + p.reason);
        assert.deepStrictEqual(roundsOn(wiresB), expected,
            'window B published rounds [' + roundsOn(wiresB).join(', ') + ']; expected [' +
            expected.join(', ') + '], i.e. every finalized round except the unpublishable one');

        // The strongest form of "it never reached the chain": no wire this federation
        // emitted, in either window, carries it.
        const everything = roundsOn(wiresA.concat(wiresB));
        assert.strictEqual(everything.indexOf(bigRound), -1,
            'round ' + bigRound + ' was declared unpublishable and dead-lettered, yet it rode a wire ' +
            'anyway. That is a DOGE fee spent on an action every indexing node refuses to inflate.');

        for (const l of landedB) {
            assert.ok(l.block && Number.isFinite(Number(l.block.height)),
                'PUSH rung: window B transaction ' + l.pub.txid + ' is not in a block');
            assert.ok(l.indexed, 'PARSE rung: no prices row for window B transaction ' + l.pub.txid);
            assert.strictEqual(Number(l.indexed.batch_first_round), l.parsed.firstRound);
            assert.strictEqual(Number(l.indexed.batch_last_round), l.parsed.lastRound);
            assert.strictEqual(Number(l.indexed.round_count), l.parsed.roundCount);
        }
    });
};
