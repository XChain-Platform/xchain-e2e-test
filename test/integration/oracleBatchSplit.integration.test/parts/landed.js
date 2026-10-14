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
const { KNOWN_CAPABILITY_GAP_STATUS } = require('../helpers/pairs');

// Registers part of the assertions inside the caller's describe.
module.exports = function registerLanded(ctx) {
    it('every split wire LANDED: mined, parsed and stored by the landing chain', function () {
        const { venue, signerSet, landedA, notes } = ctx;
        assert.strictEqual(landedA.length, 2, 'window A produced ' + landedA.length + ' publications');
        for (const l of landedA) {
            assert.ok(/^[0-9a-f]{64}$/.test(String(l.pub.txid)),
                'PUSH rung: the publish returned ' + l.pub.txid + ' rather than a transaction id');
            assert.ok(l.block && Number.isFinite(Number(l.block.height)),
                'PUSH rung: transaction ' + l.pub.txid + ' is not in a block on the ' + venue.rail.code +
                ' node, so "they all land" is unproven for it. ' + notes.join(' | '));
            assert.ok(l.indexed,
                'PARSE rung: the ' + venue.rail.code + ' indexer wrote no prices row for ' + l.pub.txid);
            assert.strictEqual(Number(l.indexed.version), 0,
                'PARSE rung: the indexer recorded PRICE version ' + l.indexed.version + ' for a batch wire');
            assert.strictEqual(Number(l.indexed.batch_first_round), l.parsed.firstRound,
                'PARSE rung: the indexer stored batch_first_round ' + l.indexed.batch_first_round +
                ' for a wire whose FIRST_ROUND is ' + l.parsed.firstRound);
            assert.strictEqual(Number(l.indexed.batch_last_round), l.parsed.lastRound);
            assert.strictEqual(Number(l.indexed.round_count), l.parsed.roundCount,
                'PARSE rung: the indexer stored round_count ' + l.indexed.round_count + ' for a ' +
                l.parsed.roundCount + '-round batch');
            assert.strictEqual(Number(l.indexed.round_number), l.parsed.firstRound,
                'D21: a batch row carries FIRST_ROUND in round_number');
            const stored = JSON.parse(l.indexed.rounds_json || '[]');
            assert.strictEqual(stored.length, l.parsed.roundCount,
                'PARSE rung: rounds_json holds ' + stored.length + ' round(s), not ' + l.parsed.roundCount);
            // A split wire must not be silently downgraded to some other failure: the
            // only two verdicts a well-formed batch may record here are "valid" and the
            // known off-BTC capability status.
            const status = String(l.indexed.status);
            assert.ok(status === 'valid' || status === KNOWN_CAPABILITY_GAP_STATUS,
                'SIGNER RESOLUTION rung: a split wire indexed as "' + status + '". Expected either ' +
                '"valid" or the known capability-gap status "' + KNOWN_CAPABILITY_GAP_STATUS + '". ' +
                'Anything else is a parse, fee or wire regression, not the known gap.' +
                drive.railDiagnosis(venue, signerSet));
        }
    });
};
