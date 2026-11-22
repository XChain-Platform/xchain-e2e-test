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

const crypto = require('crypto');
const { priceBatch, BATCH_WIRE_VERSION, BREACH_FILLER_CHAR, B64_ALPHABET } = require('./constants');

// ---------------------------------------------------------------------------
// Reading a PRICE v0 wire
//
// HELPER GAP, worked around here rather than fixed in the helper (this drill keeps
// it local to its own part directory): `oracleBatchDrive.parsePriceBatchWire` still refuses any
// wire whose version field is not `2`, and the v0 collapse (spec preamble,
// 2026-08-26) made the publisher emit `PRICE|0|`. Every wire this drill touches
// would come back `{ok:false, reason:'not-version-2'}`. The splitter below is
// the same reader with the version pinned at 0; it deliberately inflates through
// the CONSENSUS module, not through zlib, so a wire this drill can read is a
// wire the chain can read.
// ---------------------------------------------------------------------------


function splitWire(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== BATCH_WIRE_VERSION) return { ok: false, reason: 'not-a-batch-version', version: version };

    if (parts[2] === priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Rejoining fields 3+ is required, not cosmetic: canonical base64 carries
        // no `|`, but a hostile wire may, and rejoining is what makes this reader
        // see the field the indexer's `params[2]` sees for every honest wire.
        const field    = parts.slice(3).join('|');
        const inflated = priceBatch.inflatePriceBatchBody(field);
        if (!inflated.ok) {
            return { ok: false, compressed: true, field: field,
                     reason: inflated.reason, status: inflated.status };
        }
        return {
            ok: true, compressed: true, field: field, body: inflated.body,
            bodyBytes:       inflated.inflatedBytes,
            compressedBytes: inflated.compressedBytes,
            ratio:           inflated.ratio,
            wireBytes:       Buffer.byteLength(String(wire), 'utf8')
        };
    }
    const body = parts.slice(2).join('|');
    return {
        ok: true, compressed: false, field: null, body: body,
        bodyBytes:       Buffer.byteLength(body, 'utf8'),
        compressedBytes: null, ratio: null,
        wireBytes:       Buffer.byteLength(String(wire), 'utf8')
    };
}

// Field order is `actions/price/index.js:parseV0`'s, read out of the same body the
// parser reads: FIRST_ROUND, LAST_ROUND, BTC_BLOCK_HEIGHT, ROUND_COUNT, then
// ROUND/TIMESTAMP/ANCHOR_HEIGHT/PAIR_COUNT + pairs per round, then the sig set.
function splitBody(body) {
    const f = String(body).split('|');
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
    return { firstRound, lastRound, anchor, roundCount, rounds, sigs };
}

// ---------------------------------------------------------------------------
// Crafting the hostile payloads
// ---------------------------------------------------------------------------

// A high-entropy string over printable ASCII with `|` removed, for the
// incompressible body of clause 4. 93 symbols is 6.54 bits per character, which
// deflate cannot shrink below about 0.82 of the input; base64's 4/3 expansion
// then puts the packed form comfortably above the plain one. Drawn from
// crypto.randomBytes so the incompressibility is a property of the data and not
// of a seed this file chose.
function entropyString(n) {
    const alphabet = [];
    for (let c = 33; c < 127; c++) if (c !== 0x7C) alphabet.push(String.fromCharCode(c));
    const raw = crypto.randomBytes(n);
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[raw[i] % alphabet.length];
    return out;
}

/**
 * Grow a compressible filler onto `body` until the consensus module rejects the
 * compressed field for the intended reason.
 *
 * SEARCHED, NOT ASSUMED. Which of the two caps binds is a function of the
 * deflated length alone (`outputCap = min(PRICE_WIRE_MAX_BYTES, compressed*150)`),
 * so a hard-coded filler length would silently stop breaching the day zlib's
 * output moved by a few bytes and the drill would go green on a payload that is
 * merely legal. The module itself is the oracle here.
 */
function craftBreach(body, wantReason) {
    const tried = [];
    for (const fill of [7_000, 12_000, 20_000, 35_000, 60_000, 120_000, 240_000]) {
        const padded = body + BREACH_FILLER_CHAR.repeat(fill);
        const field  = priceBatch.compressPriceBatchBody(padded);
        if (field.length > priceBatch.PRICE_WIRE_MAX_BYTES) continue;
        const verdict = priceBatch.inflatePriceBatchBody(field);
        tried.push(fill + ':' + (verdict.ok ? 'accepted' : verdict.reason));
        if (!verdict.ok && verdict.reason === wantReason) {
            return { field: field, status: verdict.status, reason: verdict.reason,
                     fill: fill, inflatedBody: padded };
        }
    }
    throw new Error('AT9 could not craft a "' + wantReason + '" breach from this body; ' +
        'filler lengths tried were [' + tried.join(', ') + ']. The caps in ' +
        'price_batch_compression.js moved, or zlib\'s output did.');
}

// The three non-canonical spellings section 4a names, each produced from the
// SAME canonical field so all three decode (under a lenient reader) to exactly
// the same bytes. That identity is the point: it is what makes "silently
// normalized" a thing that could happen rather than a thing that could not.
function spellWithWhitespace(field) {
    const at = Math.floor(field.length / 2);
    return field.slice(0, at) + ' ' + field.slice(at);
}

function spellUrlSafe(field) {
    if (!/[+/]/.test(field)) return null;
    return field.replace(/\+/g, '-').replace(/\//g, '_');
}

// The padding game that a length check and an alphabet check both MISS: the
// final quantum's unused low bits. With one `=` the last data character carries
// four significant bits and two unused; with two, two significant and four
// unused. Either way bit 0 is unused, so flipping it leaves the decoded bytes
// identical and only the re-encode round trip in `decodeCanonicalBase64` can
// tell the two spellings apart. `QR==` and `QQ==` are the textbook pair.
function spellUnusedBits(field) {
    const pads = (field.match(/=+$/) || [''])[0].length;
    if (pads === 0) return null;
    const at = field.length - pads - 1;
    const v  = B64_ALPHABET.indexOf(field[at]);
    if (v < 0) return null;
    return field.slice(0, at) + B64_ALPHABET[v ^ 1] + field.slice(at + 1);
}

/**
 * A canonical compressed field whose spelling can carry all three mutations.
 *
 * The URL-safe mutation needs a `+` or a `/` to replace and the padding
 * mutation needs a pad character, neither of which deflate is obliged to
 * produce. A trailing field is appended to the body until both appear; the
 * parser reads its fields positionally and stops after the signature set, so a
 * trailing field leaves the batch body it is appended to well-formed.
 */
function craftMutableField(body) {
    for (let k = 0; k <= 400; k++) {
        const padded = k === 0 ? body : (body + '|' + 'X'.repeat(k));
        const field  = priceBatch.compressPriceBatchBody(padded);
        if (/[+/]/.test(field) && /=$/.test(field)) return { field: field, body: padded, filler: k };
    }
    throw new Error('AT9 could not produce a compressed field carrying both a non-standard ' +
        'alphabet character and a pad character in 400 attempts');
}

module.exports = {
    splitWire, splitBody, entropyString, craftBreach, craftMutableField,
    spellWithWhitespace, spellUrlSafe, spellUnusedBits,
};
