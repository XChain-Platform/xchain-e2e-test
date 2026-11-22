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

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

// Companion to dependency-advisories.test.js, and deliberately NOT part of it:
// that file is byte-identical across every sibling repo that carries it, while
// this hazard is specific to xchain-e2e-test.
//
// This repo declares two dependencies as local paths. npm packs them before
// installation so their source checkouts and dev trees cannot enter this repo's
// dependency graph. These guards cover both the installed packages and the
// lockfile snapshots produced by that layout.
const root = path.resolve(__dirname, '..', '..', '..', '..');
const pkg  = require(path.join(root, 'package.json'));

// Same floors as the companion file. Duplicated rather than imported
// because that file is a mocha spec shared verbatim across repos and
// exports nothing; keeping this list next to its own assertions is the
// cheaper coupling. A floor that drifts fails here as a stale-pin report
// rather than passing silently, because ADV-6 also asserts the two lists
// agree.
const floors = {
    'fast-uri':             [3, 1, 5],
    'brace-expansion':      [5, 0, 9],
    'minimatch':            [11, 0, 9],
    'axios':                [1, 18, 0],
    'js-yaml':              [4, 3, 1],
    'serialize-javascript': [7, 0, 5],
    'shell-quote':          [1, 9, 0],
    'form-data':            [4, 0, 6],
    'tmp':                  [0, 2, 6],
    'ip-address':           [10, 3, 1],
    'mariadb':              [3, 5, 3]
};

function cmp(a, b) {
    for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
    }
    return 0;
}

function parse(version) {
    return String(version).split('-')[0].split('.').map(Number);
}

// Every dependency declared as a local path. Read from package.json rather
// than hardcoded so a third bundled sibling is covered the day it is added.
function stagedSiblings() {
    return Object.entries(pkg.dependencies || {})
        .filter(([, range]) => /^file:/.test(String(range)))
        .map(([name, range]) => ({
            name,
            dir: path.resolve(root, String(range).replace(/^file:/, ''))
        }));
}

// Walks a node_modules tree and yields { name, version, path } for every
// package in it, descending into scopes and into nested node_modules. Depth
// is bounded so a symlink cycle in a staged bundle cannot hang the suite.
function* walkTree(dir, depth) {
    if (depth > 8 || !fs.existsSync(dir)) return;

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === '.bin') continue;
        const full = path.join(dir, entry.name);

        // A scope directory holds packages, not a package.
        if (entry.name.startsWith('@')) {
            yield* walkTree(full, depth + 1);
            continue;
        }

        const manifest = path.join(full, 'package.json');
        if (fs.existsSync(manifest)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
                if (parsed.name && parsed.version) {
                    yield { name: parsed.name, version: parsed.version, path: full };
                }
            } catch {
                // An unreadable manifest is not this suite's problem.
            }
        }

        yield* walkTree(path.join(full, 'node_modules'), depth + 1);
    }
}

describe('Security: staged sibling trees carry no vulnerable copies @regression @tier4', function () {
    it('ADV-6: the floors here match the ones the lockfile guard enforces', function () {
        const companion = fs.readFileSync(
            path.join(__dirname, 'dependency_advisories.test.js'), 'utf8');

        // Pulls `{ name: 'x', minSafe: [a, b, c], ... }` out of the shared file
        // so a floor raised there and not here is a failure rather than a
        // quietly weaker check on the staged trees.
        const found = {};
        const re = /\{\s*name:\s*'([^']+)',\s*minSafe:\s*\[\s*(\d+),\s*(\d+),\s*(\d+)\s*\]/g;
        let match;
        while ((match = re.exec(companion)) !== null) {
            found[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
        }

        assert.ok(Object.keys(found).length > 0,
            'parsed no advisories out of dependency-advisories.test.js; the regex needs updating');
        assert.deepStrictEqual(found, floors,
            'the advisory floors drifted apart; copy the companion file\'s list into this one');
    });

    it('ADV-7: package.json still declares the staged siblings as local paths', function () {
        // Guards the premise rather than the hazard: if these stop being file:
        // dependencies the walk below silently covers nothing, and this suite
        // would pass while proving less than it did yesterday.
        const siblings = stagedSiblings();
        assert.ok(siblings.length > 0,
            'expected at least one file: dependency (xchain-hub, xchain-sdk)');
    });
});

describe('Security: staged sibling trees carry no vulnerable copies @regression @tier4', function () {
    stagedSiblings().forEach(function (sibling) {
        it(`ADV-8: ${sibling.name}'s staged node_modules carries no package below its advisory floor`, function () {
            this.timeout(30000);

            const nested = path.join(root, 'node_modules', sibling.name, 'node_modules');
            if (!fs.existsSync(nested)) return;

            const offenders = [];
            for (const found of walkTree(nested, 0)) {
                const floor = floors[found.name];
                if (!floor) continue;
                if (cmp(parse(found.version), floor) < 0) {
                    offenders.push(
                        `${path.relative(root, found.path)} is ${found.name}@${found.version}, below ${floor.join('.')}`);
                }
            }

            assert.deepStrictEqual(offenders, [],
                `installed package tree under ${sibling.name} contains dependencies below the advisory floor.\n  `
                + offenders.join('\n  '));
        });
    });
});

// The same silent-persistence hazard one level up, on the SNAPSHOT rather than
    // the tree. package-lock.json records a frozen copy of each staged sibling's
    // manifest under its file: path key, and once the staged directory has lost its
    // package.json npm has nothing to reconcile that copy against, so it simply
    // persists. The SDK snapshot sat at 2.0.3 (the unpublished pre-renumber cut)
    // long after the repo renumbered to 0.10.0, describing a package that no longer
    // exists. Nothing resolves differently while the pinned ranges still agree,
    // which is exactly why it can rot unnoticed until a pin change lands on one
    // side only. The floor checks above cannot see it: they read node_modules, not
    // the lockfile's own path entries (uuid 7d50ae1b).
describe('Security: staged sibling trees carry no vulnerable copies @regression @tier4', function () {
    stagedSiblings().forEach(function (sibling) {
        it(`ADV-9: the lockfile snapshot of ${sibling.name} records the sibling repo's own version`, function () {
            const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
            const linkedKey = path.relative(root, sibling.dir).split(path.sep).join('/');
            const packedKey = `node_modules/${sibling.name}`;
            const key = (lock.packages || {})[linkedKey] ? linkedKey : packedKey;
            const snap = (lock.packages || {})[key];
            assert.ok(snap, `package-lock.json has no packages["${key}"] entry for the staged ${sibling.name}; `
                + 'the file: dependency layout changed and this guard needs re-pointing');
            assert.ok(typeof snap.version === 'string',
                `package-lock.json packages["${key}"] records no version for ${sibling.name}`);

            // Source of truth, in the two places the sibling can actually be: staged
            // inside this repo at build time, or checked out beside it (the CI venue
            // layout .ci-siblings describes, which is also the normal local layout).
            // A checkout with neither has nothing to compare against.
            const candidates = [
                path.join(sibling.dir, 'package.json'),
                path.join(root, '..', path.basename(sibling.dir), 'package.json'),
            ];
            const manifestPath = candidates.find(p => fs.existsSync(p));
            if (!manifestPath) return this.skip();

            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            assert.strictEqual(snap.version, manifest.version,
                `package-lock.json packages["${key}"] records ${sibling.name}@${snap.version}, but `
                + `${path.relative(root, manifestPath)} declares ${manifest.version}. The staged snapshot is `
                + 'frozen at a version the sibling no longer carries; re-stage the sibling and regenerate '
                + 'the lockfile, or correct the version field when the tree cannot be re-staged here.');
        });
    });
});
