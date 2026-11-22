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

const fs = require('fs');
const drive = require('../../../helpers/oracleBatchDrive');
const { WINDOW_ROUNDS, names, submissionSet } = require('./pairs.test');
const { readBatchWire, sumStat } = require('./wire.test');

// Index 6 is the third round of window B, so the packer meets it AFTER it has
// already packed and published rounds 4-5, and it still has round 7 to pack
// afterwards. That ordering is what makes "isolated, not poisoning" testable.
const BIG_INDEX = WINDOW_ROUNDS + 2;

// Real pairs first (every canonical pair the federation prices), then synthetic
// overflow; the co-sign whitelist is widened on every hub to cover exactly the
// names this run prices, because a follower otherwise withholds the whole round.
function widenWhitelist(venue, widenTo) {
    const NAMES = names();
    for (const o of venue['_oracles']) {
        for (let i = 0; i < widenTo; i++) o.round.canonicalPairs.add(NAMES[i]);
    }
    console.log('  co-sign whitelist widened to ' + widenTo + ' pair(s) on ' +
        venue['_oracles'].length + ' hub(s)\n');
}

// Window A: an overflowing window that splits. Window B: the same shape with
// ONE unfittable round.
async function driveWindows(ctx) {
    const { venue, calib } = ctx;
    const driveRound = (index, pairCount) => drive.finalizeRoundNoWait(
        venue, index, { prices: submissionSet(pairCount), timeoutMs: 300_000 });

    for (let i = 0; i < WINDOW_ROUNDS; i++) ctx.roundsA.push(await driveRound(i, calib.pairsMid));
    ctx.settleA = await drive.waitForPublications(
        venue, { min: 2, quietMs: 30_000, timeoutMs: 45 * 60 * 1000 });
    ctx.pubsA = venue.publications.slice(0);
    ctx.statsAfterA = venue.publisherStats();
    console.log('  AT3 window A settled: reached=' + ctx.settleA.reached + ' settled=' + ctx.settleA.settled +
        ' publications=' + ctx.pubsA.length);

    for (let i = WINDOW_ROUNDS; i < WINDOW_ROUNDS * 2; i++) {
        ctx.roundsB.push(await driveRound(i, i === BIG_INDEX ? calib.pairsBig : calib.pairsMid));
    }
    ctx.settleB = await drive.waitForPublications(
        venue, { min: ctx.pubsA.length + 2, quietMs: 30_000, timeoutMs: 45 * 60 * 1000 });
    ctx.pubsB = venue.publications.slice(ctx.pubsA.length);
    ctx.statsAfterB = venue.publisherStats();
    console.log('  AT3 window B settled: reached=' + ctx.settleB.reached + ' settled=' + ctx.settleB.settled +
        ' publications=' + venue.publications.length + ' (window B: ' + ctx.pubsB.length + ')');
}

// Reads each publication back off the chain: parsed wire, indexed row, block.
async function readBack(ctx, list, into, parsedInto) {
    const { venue, notes } = ctx;
    for (const p of list) {
        const parsed = readBatchWire(p.wire);
        parsedInto.push(parsed);
        let indexed = null, block = null;
        try { indexed = await venue.readIndexedPrice(p.txid); }
        catch (e) { notes.push('readIndexedPrice(' + p.txid + ') failed: ' + (e && e.message)); }
        try { block = await venue.blockOf(p.txid); }
        catch (e) { notes.push('blockOf(' + p.txid + ') failed: ' + (e && e.message)); }
        into.push({ pub: p, parsed: parsed, indexed: indexed, block: block });
    }
}

// The dead-letter files, across every hub.
function collectDeadLetters(ctx) {
    for (const s of ctx.statsAfterB) {
        let raw = '';
        try { raw = fs.readFileSync(s.deadLetterPath, 'utf8'); }
        catch (e) { continue; }   // no file means this hub abandoned nothing
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try { ctx.deadLetters.push(Object.assign(JSON.parse(line), { ['_file']: s.deadLetterPath })); }
            catch (e) { ctx.notes.push('unparseable dead-letter line in ' + s.deadLetterPath); }
        }
    }
}

function describeLanded(l) {
    return '    hub ' + l.pub.hubIndex + '  v' + l.pub.wireVersion + '  wire ' +
        l.pub.wireBytes + 'B  ' + l.pub.encoding + '  tx ' + l.pub.txid +
        '  block ' + (l.block ? l.block.height : '?') +
        (l.parsed.ok
            ? ('  rounds [' + l.parsed.firstRound + '..' + l.parsed.lastRound + '] count ' +
               l.parsed.roundCount + ' body ' + l.parsed.bodyBytes + 'B compressed=' +
               l.parsed.compressed + ' sigs ' + l.parsed.sigs.length)
            : ('  UNPARSEABLE: ' + l.parsed.reason)) +
        (l.indexed ? ('  -> ' + l.indexed.status) : '  -> NO PRICES ROW');
}

function logLanded(ctx) {
    const { venue, calib, roundsA, roundsB, landedA, landedB, statsAfterA, statsAfterB } = ctx;
    console.log('\n  --- AT3: what actually landed ---');
    console.log('  window A rounds: ' + roundsA.map((r) => r.round).join(', ') +
        '   (' + calib.pairsMid + ' pairs each)');
    console.log('  window B rounds: ' + roundsB.map((r) => r.round).join(', ') +
        '   (' + calib.pairsMid + ' pairs each, except round ' + (venue.roundBase + BIG_INDEX) +
        ' at ' + calib.pairsBig + ')');
    for (const l of landedA.concat(landedB)) console.log(describeLanded(l));
    console.log('  batchSplitCount total:         ' + sumStat(statsAfterB, 'batchSplitCount'));
    console.log('  batchUnpublishableCount total: ' + sumStat(statsAfterB, 'batchUnpublishableCount') +
        '  (after window A: ' + sumStat(statsAfterA, 'batchUnpublishableCount') + ')');
    console.log('  dead-letter records: ' + ctx.deadLetters.length);
    for (const d of ctx.deadLetters) {
        console.log('    round ' + d.round + ' [' + d.batchFirstRound + '..' + d.batchLastRound +
            ']  reason: ' + d.reason);
    }
    const criticals = ctx.errorLines.filter((l) => l.indexOf('CRITICAL') !== -1);
    console.log('  CRITICAL lines: ' + criticals.length);
    for (const l of criticals) console.log('    ' + l.split('\n')[0]);
    if (ctx.notes.length > 0) console.log('  notes: ' + ctx.notes.join(' | '));
    console.log(drive.railDiagnosis(venue, ctx.signerSet));
    console.log('  ---------------------------------\n');
}

module.exports = {
    BIG_INDEX, widenWhitelist, driveWindows, readBack, collectDeadLetters, logLanded,
};
