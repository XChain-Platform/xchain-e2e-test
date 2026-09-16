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
const oracle = require('./helpers/oracle_batch');
const oracleParts = require('./helpers/fixture');
const {
    drive, ValidatorIdentity, WINDOW_ROUNDS, VALIDATORS, MIN_SIGNATURES,
    KNOWN_CAPABILITY_GAP_STATUS, sha256,
} = oracle;

const SUITE_TITLE = 'AT6 oracle batch signing round: quorum withheld, then the SAME window republished (L3)';

let venue = null, signerSet = null;
let windowIndex = null, windowFirst = null, windowLast = null;
let rounds = [], phase1 = null, leaderIndex = -1;
let nextWindowRound = null, restarted = false;
let settle = null, attempts = [], parsed = null;
let indexed = null, indexError = null, block = null;

function bindOracleState(state) {
    ({ venue, signerSet, windowIndex, windowFirst, windowLast, rounds, phase1, leaderIndex,
        nextWindowRound, restarted, settle, attempts, parsed, indexed, indexError, block } = state);
}

function registerOracleTest(title, callback) {
    describe(SUITE_TITLE, function () {
        this.timeout(60 * 60 * 1000);
        oracleParts.install(bindOracleState);
        it(title, callback);
    });
}

registerOracleTest('with quorum restored, the SAME window published, and exactly one wire', function () {
    assert.ok(restarted,
        'the drill never reached the re-proposal: no leader hub was identified for window ' + windowIndex);
    assert.ok(settle.reached,
        'RECOVERY rung: the window stayed unpublished after quorum was restored and the leader was ' +
        'restarted. A window that fails closed and cannot be recovered loses an hour of price history ' +
        'to one missed signing round, which is the failure AT6 exists to catch.' +
        drive.railDiagnosis(venue, signerSet));
    assert.strictEqual(venue.publications.length, 1,
        'the recovered window emitted ' + venue.publications.length + ' transaction(s); it must emit ' +
        'exactly one, or the retry paid a second DOGE fee for content already on chain.' +
        drive.railDiagnosis(venue, signerSet));
    assert.ok(settle.settled,
        'a second wire was still arriving when the quiet window expired, so "exactly one" is a race ' +
        'this run happened to win rather than a property.');

    const p = venue.publications[0];
    assert.strictEqual(p.wireVersion, 0,
        'the recovered window published PRICE v' + p.wireVersion + ', not the batch version 0');
    assert.ok(/^[0-9a-f]{64}$/.test(String(p.txid)),
        'PUSH rung: the publish returned ' + p.txid + ' rather than a transaction id');

    assert.ok(parsed.ok, 'the landed wire does not parse as a PRICE batch: ' + parsed.reason);
    assert.strictEqual(parsed.firstRound, windowFirst,
        'the recovered wire covers [' + parsed.firstRound + '..' + parsed.lastRound + '], not the ' +
        'withheld window [' + windowFirst + '..' + windowLast + ']. AT6 is the claim that the SAME ' +
        'window publishes, not that some later window does.');
    assert.strictEqual(parsed.lastRound, windowLast);
    assert.strictEqual(parsed.roundCount, WINDOW_ROUNDS);
    assert.deepStrictEqual(parsed.rounds.map((r) => r.round), rounds.map((r) => r.round),
        'the recovered wire carries rounds [' + parsed.rounds.map((r) => r.round).join(', ') +
        '] but the withheld window was [' + rounds.map((r) => r.round).join(', ') + ']');
    assert.ok(!parsed.rounds.some((r) => r.round === nextWindowRound.round),
        'the recovered wire swept in round ' + nextWindowRound.round + ', which belongs to window ' +
        (windowIndex + 1) + ' and would put a round outside the window on the window\'s own wire');
    const distinct = new Set(parsed.sigs.map((s) => s.pubkey));
    assert.ok(distinct.size >= MIN_SIGNATURES,
        'the recovered batch carries only ' + distinct.size + ' signature(s); a weighted quorum over ' +
        VALIDATORS + ' equal sources needs ' + MIN_SIGNATURES + '.' + drive.railDiagnosis(venue, signerSet));
});

registerOracleTest('the re-proposal\'s canonical is BYTE-IDENTICAL to the withheld attempt\'s (D17)', function () {
    assert.strictEqual(attempts.length, 2,
        'AT6 compares TWO proposals over window [' + windowFirst + '..' + windowLast + ']; the signers ' +
        'recorded ' + attempts.length + '. Fewer means the window was proposed only once (so there is ' +
        'no byte-identity to check); more means it was re-proposed repeatedly and the comparison ' +
        'below would be picking two runs arbitrarily.' + drive.railDiagnosis(venue, signerSet));

    const withheld = attempts[0];
    const recovery = attempts[1];
    assert.strictEqual(withheld.met, false, 'the FIRST proposal reached quorum; AT6 needs it to fail');
    assert.strictEqual(recovery.met, true, 'the SECOND proposal did not reach quorum');
    assert.strictEqual(withheld.hubIndex, leaderIndex);
    assert.strictEqual(recovery.hubIndex, leaderIndex,
        'the re-proposal came from hub ' + recovery.hubIndex + ' rather than the window\'s elected ' +
        'leader (hub ' + leaderIndex + '), which would mean leader election is not a pure function of ' +
        'the window index after all');

    assert.ok(withheld.canonical && recovery.canonical,
        'a proposal recorded no canonical bytes, so there is nothing to compare');
    assert.strictEqual(withheld.anchor, recovery.anchor,
        'the two proposals resolved different batch anchors (' + withheld.anchor + ' vs ' +
        recovery.anchor + '), so they would be judged by different capability sets');
    assert.deepStrictEqual(withheld.rounds, recovery.rounds,
        'the two proposals covered different round sets');

    // Compared by digest and by length FIRST so a mismatch reports a readable
    // difference instead of dumping two multi-kilobyte canonicals, then by the raw
    // strings, which is the claim itself.
    const a = withheld.canonical, b = recovery.canonical;
    assert.strictEqual(sha256(a), sha256(b),
        'D17: a re-proposal of the SAME window must produce byte-identical canonical content. The ' +
        'withheld attempt signed ' + Buffer.byteLength(a, 'utf8') + ' bytes (sha256 ' + sha256(a) +
        ') and the recovery signed ' + Buffer.byteLength(b, 'utf8') + ' bytes (sha256 ' + sha256(b) +
        '). Non-determinism here means a validator that co-signed the first attempt could be shown ' +
        'signing two different batches over one window at one anchor, which is the equivocation shape ' +
        'the XORACLEB round id exists to keep honest.');
    assert.strictEqual(Buffer.byteLength(a, 'utf8'), Buffer.byteLength(b, 'utf8'));
    assert.ok(a === b, 'the two canonicals share a sha256 but differ as strings');

    // And the bytes that were compared are the bytes the CHAIN now carries a quorum
    // over: without this the byte-identity claim could be about two proposals that
    // neither of them published.
    let verified = 0;
    for (const s of parsed.sigs) if (ValidatorIdentity.verify(recovery.canonical, s.sig, s.pubkey)) verified++;
    assert.strictEqual(verified, parsed.sigs.length,
        'only ' + verified + ' of ' + parsed.sigs.length + ' signatures on the landed wire verify ' +
        'against the canonical the recovery round produced, so the compared bytes are not the ' +
        'published bytes');
});

registerOracleTest('the recovered wire was mined and the landing chain stored the window it carried', function () {
    assert.ok(venue.publications.length > 0,
        'RECOVERY rung: nothing was broadcast for window ' + windowIndex + ', so there is no ' +
        'transaction to look for on chain.' + drive.railDiagnosis(venue, signerSet));
    assert.ok(block && Number.isFinite(Number(block.height)),
        'PUSH rung: transaction ' + venue.publications[0].txid + ' is not in a block on the ' +
        venue.rail.code + ' node');
    assert.ok(indexed, 'the landing chain\'s indexer recorded no prices row: ' + indexError);
    assert.strictEqual(Number(indexed.version), 0,
        'PARSE rung: the indexer recorded PRICE version ' + indexed.version + ' for a batch wire');
    assert.strictEqual(Number(indexed.batch_first_round), windowFirst,
        'PARSE rung: the indexer stored batch_first_round ' + indexed.batch_first_round +
        ' for the window [' + windowFirst + '..' + windowLast + ']');
    assert.strictEqual(Number(indexed.batch_last_round), windowLast);
    assert.strictEqual(Number(indexed.round_count), WINDOW_ROUNDS);
    const storedRounds = JSON.parse(indexed.rounds_json || '[]');
    assert.strictEqual(storedRounds.length, WINDOW_ROUNDS,
        'PARSE rung: rounds_json holds ' + storedRounds.length + ' round(s), not ' + WINDOW_ROUNDS);
});

registerOracleTest('the landing chain accepted the recovered batch [WAITING on a venue indexer at develop]', function () {
    assert.ok(indexed, 'no prices row to read a verdict from: ' + indexError);
    const status = String(indexed.status);
    if (status === KNOWN_CAPABILITY_GAP_STATUS) {
        console.log('  AT6\'s verdict assertion is WAITING, not failing. The recovered batch parsed, ' +
            'stored all ' + WINDOW_ROUNDS + ' rounds and carried ' + parsed.sigs.length + ' verifying ' +
            'signatures, and the ' + venue.rail.code + ' indexer still recorded "' + status + '". The ' +
            'off-BTC `price` capability fix has landed on develop, so this now means the VENUE ' +
            'indexer is behind the checkout rather than that the gap is open. AT6\'s own claim is ' +
            'about the signing round and is unaffected either way.');
        this.skip();
        return;
    }
    assert.strictEqual(status, 'valid',
        'SIGNER RESOLUTION rung: the recovered batch indexed as "' + status + '". Expected either ' +
        '"valid" or the known "' + KNOWN_CAPABILITY_GAP_STATUS + '". Anything else is a parse, fee or ' +
        'wire regression, not a stale venue.' + drive.railDiagnosis(venue, signerSet));
});
