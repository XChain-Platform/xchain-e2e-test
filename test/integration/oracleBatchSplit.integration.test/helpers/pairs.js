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

// Four rounds per window, so a split can be a RANGE split (2+2) rather than the
// degenerate one-round-per-wire case a two-round window would force.
const WINDOW_ROUNDS  = 4;
const VALIDATORS     = 4;
const MIN_SIGNATURES = 3;

// Seconds rather than the shipped five minutes: the grace exists so real
// stragglers on a real hour boundary can arrive, and rounds driven back to back
// in-process have no stragglers to wait for.
const GRACE_MS = 8000;

// `PRICE_WIRE_MAX_BYTES`, restated so the calibration evidence is readable
// without opening the hub. It decides nothing: every fit decision in this file
// is delegated to the publisher's own `wireFits`.
const WIRE_MAX_BYTES = 8189;

// The one verdict a well-formed PRICE can legitimately record on a non-BTC
// indexer while the price-capability gap is open. AT3 is a claim about what the
// federation EMITS and what reaches a block, not about the verdict, so this is
// tolerated rather than asserted either way.
const KNOWN_CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Held out of the pair set: `nativeFeeHelper.seedGlobalPrices` clears and
// re-seeds exactly these two on every action transaction, so a drill that priced
// them would have its own rounds rewritten underneath it by its own fee output.
const HELD_OUT_PAIRS = new Set(['XCHAIN/USD', 'DOGE/USD']);

// The widened regtest pair bound (`price_pair_activation.js`, threshold 0 on
// regtest). Restated only to filter the canonical list; the chain enforces its own.
const PAIR_RE = /^[A-Z]{3,6}\/[A-Z]{3,5}$/;

// How many distinct pair names the calibration may reach for. The binary searches
// below never look past this, so building the list once up front costs nothing.
const NAME_POOL = 1600;

// The run's pair names: every canonical pair the federation really prices, in
// sorted order, then synthetic six-letter tickers for the overflow above that.
// Filled in before(), because the canonical set is read off the venue's own
// OracleRound rather than restated here.
let NAMES = [];

// A six-letter ticker. Prefixed 'P' and checked against the canonical set, so a
// synthetic name can never shadow a real pair.
function tickerFor(i) {
    let s = '', n = i;
    for (let k = 0; k < 5; k++) { s = ALPHA[n % 26] + s; n = Math.floor(n / 26); }
    return 'P' + s;
}

function buildNames(venue) {
    const seen = new Set();
    const real = [];
    for (const p of venue['_oracles'][0].round.canonicalPairs) {
        if (HELD_OUT_PAIRS.has(p) || !PAIR_RE.test(p) || seen.has(p)) continue;
        seen.add(p); real.push(p);
    }
    real.sort();
    const out = real.slice(0);
    let i = 0;
    while (out.length < NAME_POOL) {
        const n = tickerFor(i++) + '/USD';
        if (seen.has(n)) continue;
        seen.add(n); out.push(n);
    }
    return { names: out, realCount: real.length };
}

// Three integer digits, always. The federation's trimmed median re-spells every
// price to eight decimals (`bcmath.bcformat(..., 8)`), so a three-digit
// submission lands on the wire as exactly twelve characters and the calibration
// below can predict the byte cost of a pair without predicting the aggregate.
// Constant across rounds for a given pair, which puts every propose-path
// deviation at exactly zero: this drill is a claim about SIZE, and a price walk
// would only add a way for it to fail for an unrelated reason.
function pairPriceFor(i) { return String(100 + (i % 400)); }

// What the hubs are handed.
function submissionSet(pairCount) {
    const out = [];
    for (let i = 0; i < pairCount; i++) out.push({ coinPair: NAMES[i], price: pairPriceFor(i) });
    return out;
}

// What the calibration measures: the same pairs in the shape
// `OraclePublisher.bufferEntryFromEvent` produces ({pair, price}), carrying the
// FINALIZED eight-decimal spelling rather than the submitted one.
function bufferedPairSet(pairCount) {
    const out = [];
    for (let i = 0; i < pairCount; i++) {
        out.push({ pair: NAMES[i], price: pairPriceFor(i) + '.00000000' });
    }
    return out;
}

module.exports = {
    WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES, GRACE_MS, WIRE_MAX_BYTES,
    KNOWN_CAPABILITY_GAP_STATUS, NAME_POOL,
    names: () => NAMES, buildNames, setNames: (n) => { NAMES = n; },
    submissionSet, bufferedPairSet,
};
