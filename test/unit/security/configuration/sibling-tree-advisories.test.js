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
// This repo declares two of its dependencies as local paths (xchain-hub,
// xchain-sdk). Those directories are gitignored and staged at build time, so
// npm links rather than fetches them, and it installs their dependencies into a
// node_modules INSIDE each staged directory. The trap : once a staged
// directory loses its package.json, npm stops treating that nested tree as
// something it owns, so the tree stops being reconciled and simply persists.
// A tree installed before this repo's brace-expansion/minimatch overrides landed
// therefore survived every later `npm ci` carrying brace-expansion 2.1.3 and
// minimatch 9.0.9, and any lockfile regeneration that expanded it wrote those
// versions back into package-lock.json, which is what held the Stryker bump at
// ^8.7.1 for as long as it was held.
//
// The lockfile assertions in the companion file cannot see this: they describe
// what a fresh install WOULD produce, and these trees are precisely the part of
// the checkout a fresh install does not touch.
describe('Security: staged sibling trees carry no vulnerable copies @regression @tier4', function () {
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
        'brace-expansion':      [5, 0, 8],
        'minimatch':            [10, 2, 5],
        'axios':                [1, 18, 0],
        'js-yaml':              [4, 3, 0],
        'serialize-javascript': [7, 0, 5],
        'shell-quote':          [1, 9, 0],
        'form-data':            [4, 0, 6],
        'tmp':                  [0, 2, 6],
        'ip-address':           [10, 3, 1]
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

    it('ADV-6: the floors here match the ones the lockfile guard enforces', function () {
        const companion = fs.readFileSync(
            path.join(__dirname, 'dependency-advisories.test.js'), 'utf8');

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

    stagedSiblings().forEach(function (sibling) {
        it(`ADV-8: ${sibling.name}'s staged node_modules carries no package below its advisory floor`, function () {
            this.timeout(30000);

            const nested = path.join(sibling.dir, 'node_modules');
            // A checkout that has not staged this sibling yet has nothing to
            // check. That is the normal state in CI, where the sibling is
            // checked out beside the repo instead of inside it.
            if (!fs.existsSync(nested)) return this.skip();

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
                `stale staged tree under ${sibling.name}: npm no longer manages it, so reinstalling will not `
                + 'clear these. Delete the nested node_modules and re-run npm ci.\n  '
                + offenders.join('\n  '));
        });
    });
});
