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
// What this file stops: a test file that no longer PARSES, and therefore
// silently stops existing.
//
// Measured 2026-08-19: test/federation/llmAttestation.test.js had lost its last
// 28 lines (two unclosed braces) in commit 40248e1 and could not be loaded by
// node at all. Three later commits edited the file without noticing, and its
// own npm script (`test:attestation:llm`) had been failing at load ever since.
// Nothing reported it, because a file that cannot be parsed contributes zero
// tests: mocha's glob simply matches one fewer suite, and the counts a reader
// scans (passing / pending / failing) all stay plausible. This is the quietest
// member of the family this repo already guards against elsewhere - a suite
// that reports green by not running (see vmFalseGreen.test.js). A skipped test
// at least prints as pending; an unparseable file prints as nothing.
//
// Judge a run by what it did not run. This file makes "did not run" loud.
//
//   npx mocha --no-config test/unit/suiteParses.test.js

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Every tree that holds executable JS this repo owns. node_modules and the
// sibling checkouts are somebody else's problem.
const SCANNED_DIRS = ['test', 'src', 'scripts', 'bin'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'reports']);

function collectJsFiles(dir, out){
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch(e){ return out; } // an absent optional tree is not a parse failure
    for(const entry of entries){
        const full = path.join(dir, entry.name);
        if(entry.isDirectory()){
            if(!SKIP_DIRS.has(entry.name)) collectJsFiles(full, out);
        } else if(entry.isFile() && entry.name.endsWith('.js')){
            out.push(full);
        }
    }
    return out;
}

// Compile in CommonJS function scope rather than as a bare script: these files
// are CJS modules, so a top-level `return` is legal in them and would be a
// spurious SyntaxError under vm.Script. Compiling never EXECUTES the file, so a
// suite with live side effects at require time stays inert here.
function parseError(file){
    let source = fs.readFileSync(file, 'utf8');
    // A leading shebang is valid in a CJS module but not inside a function body.
    if(source.startsWith('#!')) source = source.replace(/^#![^\n]*/, '');
    try {
        vm.compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], {
            filename: file
        });
        return null;
    } catch(e){
        return e.message;
    }
}

describe('every owned .js file parses', function () {

    it('finds no file that node could not load', function () {
        const files = [];
        for(const dir of SCANNED_DIRS) collectJsFiles(path.join(REPO_ROOT, dir), files);

        // A scan that finds nothing is a broken scan, not a clean tree. Without
        // this the guard passes hardest exactly when it has stopped working.
        assert(files.length > 100,
            'expected to scan >100 .js files, found ' + files.length +
            ' - the scan itself is broken, so its green means nothing');

        const broken = [];
        for(const file of files){
            const err = parseError(file);
            if(err) broken.push(path.relative(REPO_ROOT, file) + ': ' + err);
        }

        assert.strictEqual(broken.length, 0,
            broken.length + ' file(s) do not parse, so their tests do not exist:\n  ' +
            broken.join('\n  '));
    });
});
