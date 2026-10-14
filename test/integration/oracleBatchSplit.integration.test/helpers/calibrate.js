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

const { VALIDATORS, bufferedPairSet, names } = require('./pairs');

// Measures N rounds of M pairs against the venue publisher's OWN packer.
function makeMeasure(venue, pub) {
    return (roundCount, pairCount, sigCount) => {
        const pairs  = bufferedPairSet(pairCount);
        const rounds = [];
        for (let k = 0; k < roundCount; k++) {
            rounds.push({
                round:          venue.roundBase + k,
                timestamp:      venue.anchorTimeBase + k * 600,
                btcBlockHeight: venue.anchorHeight,
                pairs:          pairs
            });
        }
        const emitted = pub.emitWire(
            rounds[0].round, rounds[rounds.length - 1].round,
            venue.anchorHeight, rounds, pub.placeholderSigs(sigCount));
        return {
            fits:       pub.wireFits(emitted),
            bodyBytes:  emitted.bodyBytes,
            wireBytes:  emitted.bytes,
            compressed: emitted.compressed
        };
    };
}

// Both predicates are monotone in the pair count (the body grows strictly),
// so a binary search is exact rather than a sample.
function largestFitting(measure, roundCount, sigCount, lo, hi) {
    let best = lo - 1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (measure(roundCount, m, sigCount).fits) { best = m; lo = m + 1; } else { hi = m - 1; }
    }
    return best;
}

function smallestNotFitting(measure, roundCount, sigCount, lo, hi) {
    let best = hi + 1;
    while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (!measure(roundCount, m, sigCount).fits) { best = m; hi = m - 1; } else { lo = m + 1; }
    }
    return best;
}

function logCalibration(calib) {
    const NAMES = names();
    console.log('\n  --- AT3: calibration against the real packer ---');
    console.log('  canonical pairs priced: ' + calib.realPairs + ' (' + NAMES.slice(0, 3).join(', ') +
        ', ...); synthetic overflow beyond that starts at ' + NAMES[calib.realPairs]);
    console.log('  signature-set hint: ' + calib.sigHint + ' (sizing against ' + calib.sigMax + ')');
    console.log('  largest pair count where 2 rounds fit: ' + calib.hiTwo);
    console.log('  smallest pair count where 3 rounds do NOT fit: ' + calib.loThree);
    console.log('  smallest pair count where 1 round does NOT fit: ' + calib.loOne);
    console.log('  chosen: pairsMid=' + calib.pairsMid + '  pairsBig=' + calib.pairsBig);
    if (calib.mid2) {
        for (const [label, m] of [['x1', calib.mid1], ['x2', calib.mid2], ['x3', calib.mid3]]) {
            console.log('    mid ' + label + ': body ' + m.bodyBytes + 'B wire ' + m.wireBytes + 'B fits=' + m.fits);
        }
    }
    console.log('    big x1: body ' + calib.big1.bodyBytes + 'B wire ' + calib.big1.wireBytes +
        'B compressed=' + calib.big1.compressed + ' fits=' + calib.big1.fits);
    console.log('  -----------------------------------------------\n');
}

// Calibrates pair counts by binary search against the publisher's own emitWire,
// placeholderSigs and wireFits, using the same signature-set hint it will size
// against (`priceSetSizeHint`).
async function calibrate(venue, realCount, notes) {
    const pub = venue.publishers[0];
    let sigHint = VALIDATORS;
    try { sigHint = await pub.priceSetSizeHint(venue.anchorHeight, VALIDATORS); }
    catch (e) { notes.push('priceSetSizeHint threw (' + (e && e.message) + '); falling back to ' + VALIDATORS); }
    const sigMax = Math.max(1, sigHint, VALIDATORS);
    const measure = makeMeasure(venue, pub);

    // TWO rounds must fit even with the largest signature set the federation can
    // return; THREE must not fit even with a single signature, so the split is a
    // statement about round data rather than about how many peers co-signed.
    const hiTwo   = largestFitting(measure, 2, sigMax, 4, 900);
    const loThree = smallestNotFitting(measure, 3, 1, 4, 900);
    // ONE round must not fit even with a single signature.
    const loOne   = smallestNotFitting(measure, 1, 1, 4, 1600);

    const pairsMid = (loThree <= hiTwo) ? Math.floor((loThree + hiTwo) / 2) : null;
    const pairsBig = Math.min(1600, Math.ceil(loOne * 1.25));

    const calib = {
        sigHint: sigHint, sigMax: sigMax,
        realPairs: realCount,
        hiTwo: hiTwo, loThree: loThree, loOne: loOne,
        pairsMid: pairsMid, pairsBig: pairsBig,
        mid1: pairsMid === null ? null : measure(1, pairsMid, sigMax),
        mid2: pairsMid === null ? null : measure(2, pairsMid, sigMax),
        mid3: pairsMid === null ? null : measure(3, pairsMid, 1),
        big1: measure(1, pairsBig, 1),
        big1Max: measure(1, pairsBig, sigMax)
    };
    logCalibration(calib);
    return calib;
}

module.exports = { calibrate };
