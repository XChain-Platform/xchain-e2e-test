'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A token case that reads the DOGE copy T.bridged without first asserting
// that AT1 produced it fails on a missing-copy message when AT1 did not run,
// and the journal triage reads that as a root failure. Every such case must
// open with the AT1 guard, whose "must have run" wording the triage counts
// as a cascade.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const SUITE_DIR = path.resolve(__dirname, '..', '..', 'integration', 'bridge_rail_token.test');
const MIN_CASES = 5;
const GUARD = /assert\.ok\(\s*state\.evidence\.at1_dogeChild[^;]*must have run/;

function casesReadingBridgedCopy(dir) {
    const cases = [];
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.test.js') && !n.startsWith('01_')).sort();
    for (const file of files) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const body of source.split(/\n\s*it\(/).slice(1)) {
            if (/\bT\.bridged\b/.test(body)) cases.push({ file, title: body.slice(0, 60), body });
        }
    }
    return cases;
}

describe('token bridge rail AT1 guards', function () {
    const cases = casesReadingBridgedCopy(SUITE_DIR);

    it('finds the cases that read the bridged copy', function () {
        assert.ok(cases.length >= MIN_CASES, cases.length + ' cases found, expected at least ' + MIN_CASES);
    });

    it('opens every such case with the AT1 must-have-run guard', function () {
        const unguarded = cases.filter(c => !GUARD.test(c.body)).map(c => c.file + ': ' + c.title);
        assert.deepStrictEqual(unguarded, []);
    });
});
