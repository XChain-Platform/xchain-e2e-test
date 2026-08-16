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
//
// What this file stops: a suite that needs the contract VM turning itself into
// `pending` because xchain-vm could not be loaded, and the run still exiting 0.
//
// Measured 2026-08-15 across the platform: with the isolated-vm binding
// unloadable, xchain-contracts reported 52 passing / 243 pending / exit 0 while
// DankServer ran the same tree at 284 passing / 11 pending, and this repo's
// spvSeed suite reported 0 passing / 8 pending / exit 0. Every one of those runs
// is honest and meaningless, and no test SELECTION can defend against it,
// because the venue is what decided which tests exist.
//
// The distinction this repo draws, and the one this file enforces:
//
//   - an ABSENT xchain-vm checkout may skip. A single-repo clone cannot run
//     these at all, test/unit/sibling-coverage.test.js already reports which
//     siblings were resolvable, and XCHAIN_REQUIRE_SIBLINGS=1 turns absence
//     into a failure;
//   - a checkout that is PRESENT and will not load must FAIL. The venue was
//     asked to run the suite and did not, which is the false green.
//
// The shape that produces the false green is a require of xchain-vm inside a
// try/catch whose failure path yields a null used to pick describe.skip. This
// file needs no VM, so it runs and reports on every platform, including the
// ones where the VM-dependent suites are red.
//
//   npx mocha --no-config test/unit/vmFalseGreen.test.js

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TEST_ROOT = path.join(REPO_ROOT, 'test');
const SELF      = path.relative(REPO_ROOT, __filename);

function discoverTestFiles(dir, out) {
    out = out || [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) discoverTestFiles(full, out);
        else if (entry.name.endsWith('.js')) out.push(path.relative(REPO_ROOT, full));
    }
    return out;
}

// Comments describe this failure mode at length in several files, including
// this one; only code counts.
function codeOf(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
        .split('\n')
        .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
}

const VM_REQUIRE = /require\s*\(\s*[^)]*xchain-vm/;

describe('VM false-green guard', function() {

    const files = discoverTestFiles(TEST_ROOT).filter(f => f !== SELF);

    it('found the repo test tree to scan', function() {
        assert.ok(files.length > 50,
            'expected to scan the whole test tree, found only ' + files.length +
            ' files; a broken walk here silently passes every check below');
    });

    it('no suite swallows an xchain-vm load failure in a try/catch', function() {
        const offenders = [];
        for (const file of files) {
            const code = codeOf(file);
            if (!VM_REQUIRE.test(code)) continue;
            // A require of xchain-vm inside a try block, where the catch does
            // not rethrow, is the exact shape that turns a dead binding into a
            // pending suite.
            const swallowed = /try\s*{[^}]*xchain-vm[\s\S]{0,400}?catch\s*\([^)]*\)\s*{(?![^}]*throw)[^}]*}/
                .test(code);
            if (swallowed) offenders.push(file);
        }
        assert.deepStrictEqual(offenders, [],
            'these files load xchain-vm inside a try/catch that does not rethrow, so a ' +
            'binding that cannot load makes the suite report pending and exit 0 rather ' +
            'than failing: ' + offenders.join(', ') + '. Resolve the checkout with ' +
            'require.resolve (absence may skip) and require it unguarded (a present ' +
            'checkout that will not load must be red).');
    });

    it('no suite picks describe.skip off an xchain-vm load result', function() {
        const offenders = [];
        for (const file of files) {
            const code = codeOf(file);
            // Deliberately looser than the check above: a load can be reached
            // through a resolved path or a candidate list, and any file that
            // names the VM in code and can turn a describe into pending is the
            // false-green shape whatever route it took to get there.
            if (!/xchain-vm/.test(code)) continue;
            if (/describe\.skip/.test(code)) offenders.push(file);
        }
        assert.deepStrictEqual(offenders, [],
            'these files load xchain-vm and can degrade to describe.skip, which is how a ' +
            'venue with a dead isolate binding reports a green run over tests it never ' +
            'executed: ' + offenders.join(', '));
    });

    it('is itself wired into `npm run ci`', function() {
        // A guard nothing runs is a guard nothing has. `ci` names its unit
        // specs one by one rather than globbing, so this file is one careless
        // edit away from never executing again, and that loss looks like green.
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        assert.ok(String(pkg.scripts.ci || '').includes(SELF),
            'package.json scripts.ci no longer lists ' + SELF + ', so nothing in CI ' +
            'checks that the VM-dependent suites still fail rather than skip');
    });

    it('the spvSeed suite fails, rather than skips, on a checkout that will not load', function() {
        // Named explicitly because it is the one suite in this repo that drives
        // a real contract through the real VM, and it is the suite that was
        // measured reporting 0 passing / 8 pending / exit 0 on macOS.
        const spec = path.join('test', 'unit', 'spvSeedContract.test.js');
        const code = codeOf(spec);
        assert.ok(/require\.resolve/.test(code),
            spec + ' must resolve the xchain-vm checkout separately from loading it, so ' +
            'an absent sibling and a dead binding can have different outcomes');
        assert.ok(!/describe\.skip/.test(code),
            spec + ' must not be able to turn its whole suite pending');
        // The load itself lives in loadVM(); read that function's body alone,
        // because resolveVM() legitimately catches (an unresolvable candidate
        // is just the next candidate).
        const body = code.match(/function loadVM\s*\([^)]*\)\s*{([\s\S]*?)\n}/);
        assert.ok(body, spec + ' no longer defines loadVM(); this guard reads its body');
        assert.ok(/require\s*\(\s*VM_PATH\s*\)/.test(body[1]),
            'loadVM() should require the resolved checkout path');
        assert.ok(!/\btry\b|\bcatch\b/.test(body[1]),
            spec + ' must require the resolved checkout unguarded: a catch there restores ' +
            'the false green this guard exists to prevent');
    });
});
