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
const { sumStat } = require('../helpers/wire.test');

// Registers part of the assertions inside the caller's describe.
module.exports = function registerCounter(ctx) {
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
};
