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

// Every precondition guard in the token bridge rail suite says "must have"
// to mean "an upstream case did not run". The journal triage only counts a
// failed case as a cascade when its error contains "must have run", so a
// guard worded any other way reads as a root failure and sends a fix at a
// case that never executed. This reads the suite files directly and feeds
// each guard message through the triage.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { triageJournal } = require('../../../scripts/rail_journal_triage.js');

const SUITE_DIR = path.resolve(__dirname, '..', '..', 'integration', 'bridge_rail_token.test');
const MIN_GUARDS = 16;

function collectGuards(dir) {
    const guards = [];
    for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.test.js')).sort()) {
        const source = fs.readFileSync(path.join(dir, file), 'utf8');
        for (const m of source.matchAll(/'([^'\n]*must have[^'\n]*)'/g)) {
            guards.push({ file, msg: m[1] });
        }
    }
    return guards;
}

function journalOf(guards) {
    return guards.map((g, i) => JSON.stringify({
        suite: 's', title: 'guard ' + i, state: 'failed', durationMs: 1, error: g.msg,
    })).join('\n');
}

describe('token bridge rail cascade guards', function () {
    const guards = collectGuards(SUITE_DIR);

    it('finds the precondition guards the suite carries', function () {
        assert.ok(guards.length >= MIN_GUARDS, guards.length + ' guards found, expected at least ' + MIN_GUARDS);
    });

    it('reads every guard message as a cascade and never as a root failure', function () {
        const r = triageJournal(journalOf(guards), { minPassed: 0 });
        const roots = r.rootFailures.map(e => {
            const g = guards[Number(e.title.slice('guard '.length))];
            return g.file + ': ' + g.msg;
        });
        assert.deepStrictEqual(roots, []);
        assert.strictEqual(r.cascade, guards.length);
    });
});
