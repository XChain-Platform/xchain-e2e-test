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
const { WIRE_MAX_BYTES } = require('../helpers/pairs');

// Registers part of the assertions inside the caller's describe.
module.exports = function registerPremise(ctx) {
    it('the overflow premise is the publisher\'s OWN bound, measured not assumed', function () {
        const { venue, calib } = ctx;
        assert.ok(calib, 'the calibration never ran; the venue did not come up');
        // The overflow is filler ON TOP OF the real feed, not instead of it: if the
        // canonical set ever stopped reaching the venue, every round here would be
        // synthetic and the drill would quietly stop resembling a real window.
        assert.ok(calib.realPairs >= 30,
            'only ' + calib.realPairs + ' canonical pair(s) reached the venue, so these rounds are ' +
            'almost entirely synthetic; the federation prices 36 and this drill holds out 2');
        assert.ok(calib.pairsMid === null || calib.pairsMid > calib.realPairs,
            'the calibrated pair count (' + calib.pairsMid + ') does not exceed the canonical set (' +
            calib.realPairs + '), so no overflow filler was needed and the premise is untested');
        assert.ok(calib.pairsMid !== null,
            'no pair count satisfies "2 rounds fit AND 3 rounds do not" anywhere in 4..900 pairs. ' +
            'The largest pair count where 2 rounds fit is ' + calib.hiTwo + ' and the smallest where ' +
            '3 rounds do not is ' + calib.loThree + '. AT3 is unforceable on this wire bound, which ' +
            'means the bound moved, not that the rail broke.');
        assert.strictEqual(calib.mid2.fits, true,
            'two ' + calib.pairsMid + '-pair rounds do not fit one wire (body ' + calib.mid2.bodyBytes +
            'B, wire ' + calib.mid2.wireBytes + 'B); window A would then split one-round-per-wire and ' +
            'prove nothing about range packing');
        assert.strictEqual(calib.mid3.fits, false,
            'three ' + calib.pairsMid + '-pair rounds DO fit one wire (body ' + calib.mid3.bodyBytes +
            'B); window A would publish a single wire and there would be no split to observe');
        assert.strictEqual(calib.big1.fits, false,
            'one ' + calib.pairsBig + '-pair round fits a wire on its own (body ' + calib.big1.bodyBytes +
            'B, wire ' + calib.big1.wireBytes + 'B); there is no ceiling case to reach');
        // The interesting half of section 8, asserted rather than asserted-about: the
        // oversized round's EMITTED wire is comfortably legal and its INFLATED body is
        // not, so what refuses it is the reader's cap. Compression buys fee, not capacity.
        assert.ok(calib.big1.bodyBytes > WIRE_MAX_BYTES,
            'the oversized round\'s uncompressed body is ' + calib.big1.bodyBytes + 'B, which is not ' +
            'over the ' + WIRE_MAX_BYTES + 'B reader cap; the ceiling would then be a compression ' +
            'artifact rather than a capacity fact');
    });
};
