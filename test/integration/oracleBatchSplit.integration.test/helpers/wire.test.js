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

// Helper gap 1 (see the header): `drive.parsePriceBatchWire` still gates on
// version 2. Same field walk, same consensus inflate, version 0.
function readBatchWire(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== 0) return { ok: false, reason: 'not-version-0', version: version };

    let body, compressed = false, compressedBytes = null, ratio = null;
    if (parts[2] === drive.priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Rejoining is required, not cosmetic: base64 carries no `|`, but a
        // malformed wire may, and rejoining is what makes this reader see the same
        // field the indexer sees.
        const field    = parts.slice(3).join('|');
        const inflated = drive.priceBatch.inflatePriceBatchBody(field);
        if (!inflated.ok) {
            return { ok: false, reason: inflated.reason, status: inflated.status, compressed: true };
        }
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
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        wireBytes: Buffer.byteLength(String(wire), 'utf8'),
        compressedBytes: compressedBytes, ratio: ratio,
        firstRound: firstRound, lastRound: lastRound, anchor: anchor,
        roundCount: roundCount, rounds: rounds, sigs: sigs
    };
}

// Sum a batch counter across every publisher in the federation. Window A and
// window B elect DIFFERENT leaders (leaderRank = windowIndex % publisherCount),
// so no single hub holds both halves of AT3.
function sumStat(stats, key) {
    return stats.reduce((acc, s) => acc + (Number(s[key]) || 0), 0);
}

function roundsOn(parsedWires) {
    const out = [];
    for (const p of parsedWires) if (p && p.ok) for (const r of p.rounds) out.push(r.round);
    return out.sort((a, b) => a - b);
}

module.exports = { readBatchWire, sumStat, roundsOn };
