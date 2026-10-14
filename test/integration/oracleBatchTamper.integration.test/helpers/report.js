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

const { equivPrefixOf } = require('./signers');
const { statusHistogram, describeHistogram } = require('./chain');
const s = require('./state');

function logLanded() {
    const { landed, liveStatus, replayStatus } = s;
    for (const name of Object.keys(landed)) {
        const l = landed[name];
        console.log('  ' + name.padEnd(13) + ': block ' + l.height + '  ' + l.bytes + 'B  tx ' +
            String(l.txid).slice(0, 16) + (l.tamper ? ('  [' + l.tamper.field + ': "' +
            l.tamper.before + '" -> "' + l.tamper.after + '"]') : '  [untouched]'));
        console.log('                   stored v' + l.liveRow.version + ' round_number ' +
            l.liveRow.round_number + ' batch [' + l.liveRow.batch_first_round + '..' +
            l.liveRow.batch_last_round + '] count ' + l.liveRow.round_count);
        console.log('                   live   -> "' + liveStatus[name] + '"');
        console.log('                   replay -> "' + replayStatus[name] + '"');
    }
}

function logRowDiff() {
    const { priceRowDiff } = s;
    if (!priceRowDiff) {
        console.log('  live vs replay     : live database not read (' + s.liveDbError + ')');
        return;
    }
    console.log('  live vs replay     : ' + priceRowDiff.compared + ' PRICE row(s) compared, agreed ' +
        priceRowDiff.agreed + ', disagreed ' + priceRowDiff.disagreed.length +
        ', missing ' + priceRowDiff.missing.length + ' (live db ' + s.liveDb.name + ')');
    for (const d of priceRowDiff.disagreed.slice(0, 10)) {
        console.log('    DISAGREE @' + d.at + '  live "' + d.live + '"  replay "' + d.replay + '"');
    }
}

// The run's evidence, printed once.
function logEvidence() {
    const { parsed, dual } = s;
    console.log('\n  --- AT4: what actually landed and what each node made of it ---');
    console.log('  rounds driven      : ' + s.rounds.map((r) => r.round).join(', '));
    console.log('  honest wire        : ' + parsed.roundCount + ' round(s) [' + parsed.firstRound + '..' +
        parsed.lastRound + '] anchor ' + parsed.anchor + '  sigs ' + parsed.sigs.length +
        '  body ' + parsed.bodyBytes + 'B  compressed=' + parsed.compressed +
        (parsed.compressed ? ('  (' + parsed.compressedBytes + 'B on the wire)') : ''));
    logLanded();
    console.log('  replay PRICE rows  : ' + s.replayPriceRows.length + ' -> ' +
        describeHistogram(statusHistogram(s.replayPriceRows)));
    logRowDiff();
    console.log('  dual signer        : ' + (dual ? (dual.pubkey.slice(0, 16) + '... (' + dual.source + ')')
        : 'NONE FOUND'));
    if (dual) {
        console.log('    round canonical  : ' + equivPrefixOf(dual.roundCanonical));
        console.log('    batch canonical  : ' + equivPrefixOf(dual.batchCanonical));
    }
    console.log('  ---------------------------------------------------------------\n');
}

function logSlashDecisions() {
    const { honestProof, swappedProof, sharedTagProof } = s;
    if (!s.dual) return;
    console.log('  --- AT4: the slash decisions on those artifacts ---');
    console.log('  honest pair (XORACLE + XORACLEB) : "' + honestProof.status + '"  burns ' +
        honestProof.calls.burns.length);
    console.log('  same pair, order swapped         : "' + swappedProof.status + '"  burns ' +
        swappedProof.calls.burns.length);
    console.log('  counterfactual (ONE shared tag)  : ' + (sharedTagProof
        ? ('"' + sharedTagProof.status + '"  burns ' + sharedTagProof.calls.burns.length)
        : 'not built (no venue identity)'));
    console.log('  --------------------------------------------------\n');
}

module.exports = { logEvidence, logSlashDecisions };
