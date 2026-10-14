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
const drive = require('../../helpers/oracleBatchDrive');
const { WINDOW_ROUNDS, MIN_SIGNATURES } = require('./helpers/pairs');
const { sumStat, roundsOn } = require('./helpers/wire');

// Registers the ceiling assertions (counter, dead-letter, CRITICAL line, and the
// neighbours that still published) inside the caller's describe.
module.exports = function registerCeilingParts(ctx) {
    it('the round that cannot fit incremented batchUnpublishableCount', function () {
        const { venue, signerSet, statsAfterA, statsAfterB } = ctx;
        assert.strictEqual(sumStat(statsAfterA, 'batchUnpublishableCount'), 0,
            'batchUnpublishableCount was already ' + sumStat(statsAfterA, 'batchUnpublishableCount') +
            ' after window A, which published cleanly. The counter must be moved by the oversized ' +
            'round in window B and by nothing else, or the assertion below measures the wrong event.');
        assert.strictEqual(sumStat(statsAfterB, 'batchUnpublishableCount'), 1,
            'exactly ONE round in this run cannot fit any wire form, so the federation-wide ' +
            'batchUnpublishableCount must be 1; it is ' +
            sumStat(statsAfterB, 'batchUnpublishableCount') + '. Zero means the leader never reached ' +
            'the ceiling path at all: check signRounds and signTimeouts below, because the counter ' +
            'is incremented AFTER the signing round returns quorum.' +
            drive.railDiagnosis(venue, signerSet));
    });

    it('the round that cannot fit was DEAD-LETTERED with its content and its reason', function () {
        const { venue, calib, deadLetters } = ctx;
        const bigRound = venue.roundBase + WINDOW_ROUNDS + 2;
        const mine = deadLetters.filter((d) => Number(d.round) === bigRound);
        assert.strictEqual(mine.length, 1,
            'expected exactly one dead-letter record for round ' + bigRound + ', found ' + mine.length +
            ' (across ' + deadLetters.length + ' record(s) in total: ' +
            deadLetters.map((d) => d.round + '/' + d.reason).join(' ; ') + ')');
        const rec = mine[0];
        assert.ok(/exceeds encoder limit/i.test(String(rec.reason)),
            'the dead-letter reason is "' + rec.reason + '", which does not name the size refusal; an ' +
            'operator reading this file must be able to tell a ceiling breach from an attempts-exhausted ' +
            'abandon');
        assert.strictEqual(Number(rec.batchFirstRound), bigRound,
            'the dead-letter record claims window [' + rec.batchFirstRound + '..' + rec.batchLastRound +
            '], but the ceiling case is reached only for a SINGLE round');
        assert.strictEqual(Number(rec.batchLastRound), bigRound);
        // The record has to be replayable, which means it carries the round, not a
        // pointer to it.
        assert.ok(Array.isArray(rec.rounds) && rec.rounds.length === 1,
            'the dead-letter record carries ' + (rec.rounds ? rec.rounds.length : 'no') + ' round ' +
            'bodies; an operator cannot replay a round the file does not contain');
        assert.ok(Array.isArray(rec.rounds[0].pairs) && rec.rounds[0].pairs.length === calib.pairsBig,
            'the dead-lettered round carries ' +
            (rec.rounds[0].pairs ? rec.rounds[0].pairs.length : 'no') + ' pairs, not the ' +
            calib.pairsBig + ' the federation finalized for it');
        assert.ok(Array.isArray(rec.sigs) && rec.sigs.length >= MIN_SIGNATURES,
            'the dead-lettered round carries ' + (rec.sigs ? rec.sigs.length : 'no') + ' signature(s); ' +
            'the ceiling is reached only AFTER quorum, so a short set means something else refused it');
    });

    it('the ceiling was LOUD: a CRITICAL line naming the round and the bound it breached', function () {
        const { venue, errorLines } = ctx;
        const bigRound = venue.roundBase + WINDOW_ROUNDS + 2;
        const criticals = errorLines.filter((l) => /OraclePublisher: CRITICAL/.test(l));
        assert.ok(criticals.length >= 1,
            'the rail refused a round and logged no CRITICAL line at all. The counter and the ' +
            'dead-letter are machine-checkable, but section 8 makes the log line the deliverable an ' +
            'operator actually sees, and the hub has no other alerting rail. Lines captured: ' +
            errorLines.length);
        const named = criticals.filter((l) => l.indexOf(String(bigRound)) !== -1);
        assert.ok(named.length >= 1,
            'a CRITICAL line was logged but none names round ' + bigRound + '; an alert that does not ' +
            'say WHICH round is unpublishable cannot be acted on. Captured CRITICAL lines: ' +
            criticals.map((l) => l.split('\n')[0]).join(' || '));
        assert.ok(/8189/.test(named[0]) && /does not fit/i.test(named[0]),
            'the CRITICAL line for round ' + bigRound + ' does not state the byte limit it breached: "' +
            named[0].split('\n')[0] + '"');
    });

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
