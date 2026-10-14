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

const drive = require('../../../helpers/oracleBatchDrive');
const { WIRE_PREFIX } = require('./constants');

// ---------------------------------------------------------------------------
// Reading and re-encoding a batch wire
//
// HELPER GAP, WORKED AROUND HERE RATHER THAN EDITED: `oracleBatchDrive
// .parsePriceBatchWire` still refuses anything whose version field is not `2`
// (`if (version !== 2) return { ok:false, reason:'not-version-2' }`), which the
// v0 collapse of 2026-08-26 made unreachable for every wire the shipped publisher
// emits. The reader below is that helper's body with the version gate moved onto
// 0, and it inflates through the SAME consensus module (`price_batch_compression`,
// reached as `drive.priceBatch`), so a wire this file accepts is a wire the chain
// accepts and a wire it re-encodes is one an indexer will read.
// ---------------------------------------------------------------------------

function parseBatchWire(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== 0) return { ok: false, reason: 'not-version-0', version: version };

    let body, compressed = false, compressedBytes = null, ratio = null;
    if (parts[2] === drive.priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Rejoining is required rather than cosmetic: canonical base64 carries no
        // `|`, but a hostile wire may, and rejoining is what makes this reader see
        // the same single field the indexer's parser sees.
        const field    = parts.slice(3).join('|');
        const inflated = drive.priceBatch.inflatePriceBatchBody(field);
        if (!inflated.ok) return { ok: false, reason: inflated.reason, status: inflated.status, compressed: true };
        body            = inflated.body;
        compressed      = true;
        compressedBytes = inflated.compressedBytes;
        ratio           = inflated.ratio;
    } else {
        body = parts.slice(2).join('|');
    }

    const f = body.split('|');
    let i = 0;
    const firstRound = parseInt(f[i++], 10);
    const lastRound  = parseInt(f[i++], 10);
    const anchor     = parseInt(f[i++], 10);
    const roundCount = parseInt(f[i++], 10);
    const rounds = [];
    for (let r = 0; r < roundCount; r++) {
        const round     = parseInt(f[i++], 10);
        const timestamp = parseInt(f[i++], 10);
        const rAnchor   = parseInt(f[i++], 10);
        const pairCount = parseInt(f[i++], 10);
        const pairs = [];
        for (let p = 0; p < pairCount; p++) pairs.push({ pair: f[i++], price: f[i++] });
        rounds.push({ round: round, timestamp: timestamp, btcBlockHeight: rAnchor, pairs: pairs });
    }
    const sigCount = parseInt(f[i++], 10);
    const sigs = [];
    for (let s = 0; s < sigCount; s++) {
        sigs.push({ pubkey: String(f[i++]).toLowerCase(), sig: String(f[i++]).toLowerCase() });
    }

    return {
        ok: true, version: 0, compressed: compressed,
        body: body,
        bodyBytes:  Buffer.byteLength(body, 'utf8'),
        wireBytes:  Buffer.byteLength(String(wire), 'utf8'),
        compressedBytes: compressedBytes, ratio: ratio,
        firstRound: firstRound, lastRound: lastRound, anchor: anchor,
        roundCount: roundCount, rounds: rounds, sigs: sigs
    };
}

/**
 * Put a (tampered) body back on the wire in the SAME form the honest wire used.
 *
 * Same form on purpose: emitting the smaller of the two, as the publisher does,
 * would let a tamper change the wire FORM as well as the content, and then a
 * cross-node disagreement could be about the form. The only difference between
 * the honest wire and a tampered one here is the bytes the tamper touched.
 */
function encodeBatchWire(body, compressed) {
    return compressed
        ? WIRE_PREFIX + drive.priceBatch.PRICE_BATCH_COMPRESSION_MARKER + '|' +
          drive.priceBatch.compressPriceBatchBody(body)
        : WIRE_PREFIX + body;
}

// Field offsets inside the body (everything after `PRICE|0|`), in the parser's own
// order: FIRST_ROUND, LAST_ROUND, BTC_BLOCK_HEIGHT, ROUND_COUNT, then the round
// blocks. Named rather than inlined so the two tampers below say what they touch.
const BODY_ANCHOR_FIELD    = 2;
const BODY_FIRST_ROUND_AT  = 4;   // where round block 0 starts
const ROUND_HEADER_FIELDS  = 4;   // ROUND, TIMESTAMP, ANCHOR_HEIGHT, PAIR_COUNT

/**
 * THE TAMPER AT4 NAMES: flip one digit of one price, deep inside the signed body.
 *
 * Deliberately keeps the result a LEGAL price (`/^[0-9]+(\.[0-9]+)?$/`, the
 * parser's own pattern), because a tamper that broke the format would be rejected
 * by a format rule and would never reach the signatures. This one is structurally
 * perfect and cryptographically dead: the canonical every node rebuilds from the
 * body no longer matches the bytes the federation signed, so not one signature on
 * the wire verifies.
 */
function tamperPriceDigit(body) {
    const f = body.split('|');
    const priceIndex = BODY_FIRST_ROUND_AT + ROUND_HEADER_FIELDS + 1;   // round 0, pair 0, price
    const before = String(f[priceIndex]);
    const digit  = before.search(/[0-9]/);
    if (digit < 0) throw new Error('AT4: no digit found in the first price field: "' + before + '"');
    const after = before.slice(0, digit) +
                  String((Number(before[digit]) + 1) % 10) +
                  before.slice(digit + 1);
    if (after === before) throw new Error('AT4: the price digit flip changed nothing');
    if (!/^[0-9]+(\.[0-9]+)?$/.test(after))
        throw new Error('AT4: the tampered price is not a legal price: "' + after + '"');
    f[priceIndex] = after;
    return { body: f.join('|'), field: 'round 0 pair "' + f[BODY_FIRST_ROUND_AT + ROUND_HEADER_FIELDS] +
        '" price', before: before, after: after };
}

/**
 * THE TAMPER THAT CANNOT BE CONFUSED WITH ANYTHING ELSE: move the batch header's
 * anchor off the last included round's anchor.
 *
 * Section 4 pins the two to be numerically equal and `price/index.js` checks it
 * structurally, BEFORE the straddle rule and before either quorum gate resolves,
 * so the rejection is reached without resolving a capability, a stake weight or a
 * signature. Its status string is therefore attributable to this tamper and to
 * nothing else, which is what keeps the drill honest while the price-capability
 * verdict on DOGE is still settling.
 */
function tamperHeaderAnchor(body) {
    const f = body.split('|');
    const before = String(f[BODY_ANCHOR_FIELD]);
    const after  = String(parseInt(before, 10) + 1);
    f[BODY_ANCHOR_FIELD] = after;
    return { body: f.join('|'), field: 'header BTC_BLOCK_HEIGHT', before: before, after: after };
}

module.exports = { parseBatchWire, encodeBatchWire, tamperPriceDigit, tamperHeaderAnchor };
