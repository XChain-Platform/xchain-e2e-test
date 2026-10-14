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
const { WINDOW_ROUNDS, MIN_SIGNATURES } = require('../helpers/pairs');

// Registers part of the assertions inside the caller's describe.
module.exports = function registerDeadletter(ctx) {
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
};
