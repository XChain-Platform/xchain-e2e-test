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

// Stops a suite file that no runner ever loads.
//
// Several npm scripts name their spec files literally rather than globbing a
// directory, and the tier globs are suffix-specific, so a filename that is
// neither enumerated nor matched is loaded by nothing.
//
// That miss is invisible: an unloaded file contributes no passing, no failing
// and no pending count, so the run looks the size it always did (the sibling
// cases are sibling-coverage.test.js and suiteParses.test.js).
//
// Runs in the hermetic unit tier so a suite nobody wired is caught on the
// machine that added it:
//   npx mocha --no-config test/unit/testFileReachability.test.js

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Suite files that NO npm script runs, deliberately. Each entry states why in
// prose an operator can act on; a stale entry (the file is wired now, or gone)
// is itself a failure, so this list cannot quietly outlive its reasons.
const INTENTIONALLY_UNRUN = [
    {
        file: 'test/drills/physicalByzantine.drill.js',
        why: 'Hand-driven Byzantine drill against a live multi-host stack; test/drills/README.md carries the invocation and the operator preconditions it needs.'
    },
    {
        file: 'test/drills/unit/drillPlan.test.js',
        why: 'Hermetic cover for the drill library, run by the npx line in test/drills/README.md. Folding the drill lane into test:unit would change what the CI unit job runs, which is a decision to take deliberately rather than a side effect of this guard.'
    },
    {
        file: 'test/drills/unit/drillRunner.test.js',
        why: 'Hermetic cover for the drill library, run by the npx line in test/drills/README.md. Folding the drill lane into test:unit would change what the CI unit job runs, which is a decision to take deliberately rather than a side effect of this guard.'
    },
    {
        file: 'test/drills/unit/drillVerdict.test.js',
        why: 'Hermetic cover for the drill library, run by the npx line in test/drills/README.md. Folding the drill lane into test:unit would change what the CI unit job runs, which is a decision to take deliberately rather than a side effect of this guard.'
    },
    {
        file: 'test/drills/unit/liveByzantineFaults.test.js',
        why: 'Hermetic cover for the drill library, run by the npx line in test/drills/README.md. Folding the drill lane into test:unit would change what the CI unit job runs, which is a decision to take deliberately rather than a side effect of this guard.'
    },
    {
        file: 'test/sdk/xcallStakeValidators.js',
        why: 'A one-shot federation staking driver rather than a regression suite: its header carries the XCALL_STAKE_PUBKEYS invocation, and the XCALL expiry suite names it as a step to run by hand first.'
    }
];

// A file declares a suite when a describe/suite call opens a line. A match
// inside a string or a comment would over-report, which fails loud and is the
// safe direction for this guard.
const DECLARES_SUITE = /^[ \t]*(?:describe|suite)(?:\.(?:only|skip))?\s*\(/m;

// Flags whose argument is a module to load, never a spec to run.
const NON_SPEC_FLAGS = new Set(['--reporter', '-R', '--config', '--spec-reporter']);

// Split a shell-ish script into tokens, honouring the quoting the glob
// arguments need (an unquoted glob would be expanded by the shell instead).
function tokenize(script){
    const tokens = [];
    let current = '', quote = null;
    for(const ch of script){
        if(quote){
            if(ch === quote) quote = null; else current += ch;
            continue;
        }
        if(ch === "'" || ch === '"'){ quote = ch; continue; }
        if(/\s/.test(ch)){ if(current) tokens.push(current); current = ''; continue; }
        current += ch;
    }
    if(current) tokens.push(current);
    return tokens;
}

// Every path-shaped argument a script hands mocha, including --require hooks:
// a required file IS loaded, which is what reachability asks about.
function scriptSpecs(scripts){
    const specs = [];
    for(const [name, body] of Object.entries(scripts)){
        const tokens = tokenize(body);
        for(let i = 0; i < tokens.length; i++){
            if(NON_SPEC_FLAGS.has(tokens[i])){ i++; continue; }
            const spec = tokens[i].replace(/^\.\//, '');
            if(spec.startsWith('test/') && spec.endsWith('.js')) specs.push({ script: name, spec });
        }
    }
    return specs;
}

// Translate a mocha spec glob to an anchored RegExp. `**/` spans directories,
// `*` and `?` stop at a separator, so 'a/**/*.regression.js' does not match
// 'a/x.regression.test.js' - the mismatch this guard exists to surface.
function globToRegExp(spec){
    let source = '';
    for(let i = 0; i < spec.length; i++){
        const ch = spec[i];
        if(ch === '*'){
            if(spec[i + 1] === '*'){
                if(spec[i + 2] === '/'){ source += '(?:[^/]+/)*'; i += 2; }
                else { source += '.*'; i += 1; }
            } else source += '[^/]*';
        } else if(ch === '?'){
            source += '[^/]';
        } else {
            source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + source + '$');
}

function discoverSuiteFiles(root){
    const found = [];
    (function walk(dir){
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e){ return; }
        for(const entry of entries){
            const full = path.join(dir, entry.name);
            if(entry.isDirectory()){
                if(entry.name !== 'node_modules') walk(full);
            } else if(entry.isFile() && entry.name.endsWith('.js')){
                if(DECLARES_SUITE.test(fs.readFileSync(full, 'utf8'))){
                    found.push(path.relative(root, full).split(path.sep).join('/'));
                }
            }
        }
    })(path.join(root, 'test'));
    return found.sort();
}

// Returns one line per problem, empty when every suite file is either run by a
// script or listed with a live reason. Reported both ways round on purpose: an
// unreachable suite is a coverage hole, and a stale exemption is how the hole
// comes back.
function auditReachability(suiteFiles, specs, allowlist){
    const matchers = specs.map(s => ({ script: s.script, spec: s.spec, re: globToRegExp(s.spec) }));
    const runnerFor = file => matchers.find(m => m.re.test(file));
    const exempt = new Map(allowlist.map(e => [e.file, e]));
    const problems = [];

    for(const file of suiteFiles){
        if(runnerFor(file) || exempt.has(file)) continue;
        problems.push(file + ' declares a suite that NO npm script loads, so it runs nowhere and reports nothing');
    }
    for(const entry of allowlist){
        const runner = runnerFor(entry.file);
        if(runner){
            problems.push(entry.file + ' is listed as intentionally unrun but script "' + runner.script
                + '" now runs it - drop the exemption');
        } else if(!suiteFiles.includes(entry.file)){
            problems.push(entry.file + ' is listed as intentionally unrun but declares no suite on disk - drop the exemption');
        }
    }
    return problems;
}

describe('every suite file is reachable from some npm script', function(){

    const pkg        = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const suiteFiles = discoverSuiteFiles(REPO_ROOT);
    const specs      = scriptSpecs(pkg.scripts);

    it('walks the tree it is supposed to guard', function(){
        // A walk that finds nothing passes the audit vacuously, which is the
        // failure shape this whole file exists to catch.
        assert.ok(suiteFiles.length > 100,
            'expected >100 suite files under test/, found ' + suiteFiles.length
            + ' - the walk is broken, so its green means nothing');
        assert.ok(specs.length > 50,
            'expected >50 mocha spec arguments across package.json scripts, found ' + specs.length);
    });

    it('leaves no suite unrun and no exemption stale', function(){
        const problems = auditReachability(suiteFiles, specs, INTENTIONALLY_UNRUN);
        assert.deepStrictEqual(problems, [],
            'suite files are unreachable from every npm script:\n  ' + problems.join('\n  '));
    });

    it('states a reason an operator can act on for every exemption', function(){
        for(const entry of INTENTIONALLY_UNRUN){
            assert.strictEqual(typeof entry.why, 'string', entry.file + ' needs a why');
            assert.ok(entry.why.trim().length >= 40,
                entry.file + ': "' + entry.why + '" is too terse to be a reason');
        }
    });
});

describe('the reachability audit reports the misses it is built for', function(){

    const spec = (script, s) => ({ script, spec: s });

    it('names a suite no spec matches', function(){
        const problems = auditReachability(
            ['test/a/one.test.js', 'test/a/two.test.js'],
            [spec('test:a', 'test/a/one.test.js')],
            []);
        assert.strictEqual(problems.length, 1);
        assert.match(problems[0], /two\.test\.js declares a suite that NO npm script loads/);
    });

    it('catches the suffix slip a *.regression.js glob makes invisible', function(){
        const specs = [spec('test:regression', 'test/regression/**/*.regression.js')];
        assert.deepStrictEqual(
            auditReachability(['test/regression/x.regression.js'], specs, []), []);
        const problems = auditReachability(['test/regression/x.regression.test.js'], specs, []);
        assert.strictEqual(problems.length, 1);
        assert.match(problems[0], /x\.regression\.test\.js declares a suite/);
    });

    it('catches the sibling an enumerate-by-name script leaves behind', function(){
        const problems = auditReachability(
            ['test/federation/named.test.js', 'test/federation/orphan.test.js'],
            [spec('test:federation', 'test/federation/named.test.js')],
            []);
        assert.deepStrictEqual(problems.map(p => p.split(' ')[0]), ['test/federation/orphan.test.js']);
    });

    it('accepts a directory glob that covers both', function(){
        assert.deepStrictEqual(
            auditReachability(
                ['test/federation/named.test.js', 'test/federation/orphan.test.js'],
                [spec('test:federation:all', 'test/federation/**/*.test.js')],
                []),
            []);
    });

    it('reports an exemption a script has started running', function(){
        const problems = auditReachability(
            ['test/a/one.test.js'],
            [spec('test:a', 'test/a/**/*.test.js')],
            [{ file: 'test/a/one.test.js', why: 'stale' }]);
        assert.strictEqual(problems.length, 1);
        assert.match(problems[0], /script "test:a" now runs it/);
    });

    it('reports an exemption whose file is gone', function(){
        const problems = auditReachability([], [], [{ file: 'test/a/gone.test.js', why: 'stale' }]);
        assert.strictEqual(problems.length, 1);
        assert.match(problems[0], /declares no suite on disk/);
    });

    it('does not mistake a --reporter module for a spec', function(){
        const specs = scriptSpecs({ 'test:perf': 'mocha --reporter ./test/reporters/r.js test/perf/a.perf.test.js' });
        assert.deepStrictEqual(specs.map(s => s.spec), ['test/perf/a.perf.test.js']);
    });

    it('reads a --require hook as loaded, because it is', function(){
        const specs = scriptSpecs({ test: 'mocha --require ./test/initialCheck.test.js test/actions/a.test.js' });
        assert.deepStrictEqual(specs.map(s => s.spec).sort(),
            ['test/actions/a.test.js', 'test/initialCheck.test.js']);
    });
});
