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

const { priceBatch, BATCH_WIRE_VERSION } = require('./constants');
const chain = require('./chain');

// The run's evidence, printed once.
function printEvidence(S) {
    // --- 8. the run's evidence, printed once ------------------------------
    // A green tick with no numbers proves nothing to an operator reading CI,
    // and a red one with no numbers proves less. THE RATIO LINE IS PART OF
    // AT9's wording, not decoration.
    const uncompressedWireBytes = Buffer.byteLength('PRICE|' + BATCH_WIRE_VERSION + '|' + S.parsedWire.body, 'utf8');
    console.log('\n  --- AT9: what actually landed ---');
    console.log('  rounds driven         : ' + S.rounds.map((r) => r.round).join(', '));
    console.log('  publications          : ' + S.publicationCount + '  tx ' + S.landedTxid);
    console.log('  batch on the wire     : rounds [' + S.parsedBody.firstRound + '..' + S.parsedBody.lastRound +
        '] count ' + S.parsedBody.roundCount + '  pairs/round ' +
        S.parsedBody.rounds.map((r) => r.pairs.length).join('/') + '  sigs ' + S.parsedBody.sigs.length);
    console.log('  wire form             : ' + (S.parsedWire.compressed ? 'COMPRESSED' : 'uncompressed'));
    console.log('  COMPRESSION RATIO     : ' +
        (S.parsedWire.ratio === null ? 'n/a (uncompressed)' : S.parsedWire.ratio.toFixed(2) + ':1') +
        '   (body ' + S.parsedWire.bodyBytes + ' B -> deflate ' + S.parsedWire.compressedBytes +
        ' B -> base64 ' + (S.parsedWire.field ? S.parsedWire.field.length : 0) + ' B)');
    console.log('  wire bytes            : ' + S.parsedWire.wireBytes + ' compressed vs ' +
        uncompressedWireBytes + ' uncompressed, saving ' +
        (uncompressedWireBytes - S.parsedWire.wireBytes) + ' B against the ' +
        priceBatch.PRICE_WIRE_MAX_BYTES + ' B ceiling');
    console.log('  round trip            : rebuilt body ' +
        (S.rebuiltBody === S.parsedWire.body ? 'IDENTICAL' : 'DIVERGED') + ', re-inflated body ' +
        ((S.reInflated.ok && S.reInflated.body === S.parsedWire.body) ? 'IDENTICAL' : 'DIVERGED'));
    console.log('  emit-smaller (real)   : compressed=' + S.emitReal.compressed + '  ' + S.emitReal.bytes + ' B');
    console.log('  emit-smaller (entropy): compressed=' + S.emitEntropy.compressed + '  plain ' +
        S.entropyPlainBytes + ' B vs packed ' + S.entropyPackedBytes + ' B  -> emitted ' +
        S.emitEntropy.bytes + ' B');
    console.log('  ghost rounds          : ' + S.ghost.first + '..' + S.ghost.last +
        '  (never finalized; must never appear in price_snapshots)');
    console.log('  size-cap breach       : field ' + S.breachSize.field.length + ' B, body would be ' +
        S.breachSize.inflatedBody.length + ' B, expects "' + S.breachSize.status + '"');
    console.log('  ratio-cap breach      : field ' + S.breachRatio.field.length + ' B, body would be ' +
        S.breachRatio.inflatedBody.length + ' B, expects "' + S.breachRatio.status + '"');
    for (const s of S.spellings) {
        console.log('  base64 spelling       : ' + s.name + ' -> lenient decode same=' +
            s.lenientDecodesSame + ' strict rejects=' + s.strictRejects +
            '  live "' + chain.statusOf(S.liveRows, s.landed.txid) + '"  replay "' +
            chain.statusOf(S.replayRows, s.landed.txid) + '"');
    }
    console.log('  breach verdicts       : size  live "' + chain.statusOf(S.liveRows, S.breachSize.landed.txid) +
        '"  replay "' + chain.statusOf(S.replayRows, S.breachSize.landed.txid) + '"');
    console.log('                          ratio live "' + chain.statusOf(S.liveRows, S.breachRatio.landed.txid) +
        '"  replay "' + chain.statusOf(S.replayRows, S.breachRatio.landed.txid) + '"');
    console.log('  ghost snapshots       : live ' + S.liveGhostSnaps.length + ', replay ' +
        S.replayGhostSnaps.length + ', replay mirror ' + S.replayGhostMirror.length + ' (all must be 0)');
    console.log('  compressed batch      : live "' + chain.statusOf(S.liveRows, S.landedTxid) +
        '"  replay "' + chain.statusOf(S.replayRows, S.landedTxid) + '"');
    console.log('  uncompressed twin     : live "' + chain.statusOf(S.liveRows, S.plainTwin.txid) +
        '"  replay "' + chain.statusOf(S.replayRows, S.plainTwin.txid) + '"');
    console.log('  replay target block   : ' + S.targetHeight);
    console.log(S.railState);
    console.log('  ---------------------------------\n');
}

module.exports = { printEvidence };
