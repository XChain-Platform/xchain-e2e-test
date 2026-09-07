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

// Fourth file in this directory, and separate from its three neighbours for the
// same reason sdk-transitive-advisories.test.js is: dependency-advisories.test.js
// is shared verbatim across the sibling repos that carry it, so a floor raised
// for this tree alone may not be written there, and sibling-tree-advisories.test.js
// asserts its own floor table matches that shared file exactly (ADV-6), so it may
// not be written there either.
//
// Both advisories below reopened a package the shared guard ALREADY lists at a
// floor that has since gone stale. That is the dangerous shape: the shared guard
// is green, the pin looks deliberate, and `npm audit --omit=dev` fails anyway,
// because the advisory range grew past the floor someone recorded months ago.
// The floors here sit above the shared ones and are what the production audit
// gate actually needs.
//
// fast-uri <=3.1.5 (HIGH), four advisories landing together and all reachable
// from the same parser: GHSA-5jgf-p345-68v8 skips IDN canonicalisation on
// scheme-relative references, so two spellings of one host compare unequal;
// GHSA-f65p-4m7j-42xc mis-normalises malformed IPv6 literals; GHSA-fph4-wmhf-6fwf
// percent-decodes the hostname more than once, so an encoded delimiter survives
// validation and re-appears in the dialled host; and GHSA-jqff-g426-hqxp
// normalises a percent-encoded scheme into a different scheme. Together they are
// host confusion and SSRF in anything that validates a URL with this library and
// then fetches it. It reaches the production tree through ajv's format
// validation under the staged xchain-hub. 3.1.6 is the patch; the tree resolves
// 3.1.7, the newest 3.x.
//
// qs <=6.15.3 (MODERATE), two: GHSA-x5fp-wj9c-mxmx parses comma-separated values
// inside a bracket key without counting them against arrayLimit, so a short query
// string still inflates into a large array, and GHSA-4mjr-xmp4-gh2g takes an
// attacker-controlled isBuffer off a polluted prototype and turns parsing into a
// denial of service. It reaches the production tree through express and
// body-parser under the staged xchain-hub, which is request-path code, so both
// are reachable by an unauthenticated caller. 6.16.0 is the patch.
//
// Not covered here, deliberately: the elliptic / secp256k1 / bitcoinjs-message
// chain. It has no patched release to move to, so it is an accepted residual
// rather than a floor, and sdk-transitive-advisories.test.js guards its SHAPE
// (ADV-14, ADV-15) instead of its version.
describe('Security: advisories above the shared guard\'s floors @regression @tier4', function () {
    const root = path.resolve(__dirname, '..', '..', '..', '..');
    const pkg  = require(path.join(root, 'package.json'));
    const lock = require(path.join(root, 'package-lock.json'));

    const advisories = [
        { name: 'fast-uri', minSafe: [3, 1, 6], majorSeries: 3 },
        { name: 'qs',       minSafe: [6, 16, 0], majorSeries: 6 }
    ];

    // Compares dotted numeric version triples without pulling in semver.
    function cmp(a, b) {
        for (let i = 0; i < 3; i++) {
            if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
        }
        return 0;
    }

    function parse(version) {
        return String(version).split('-')[0].split('.').map(Number);
    }

    // Non-dev lockfile entries only: `npm audit --omit=dev` is the gate this
    // file documents, and a dev-only copy of either package does not fail it.
    function runtimeLockEntries(name) {
        return Object.entries(lock.packages)
            .filter(([key, entry]) => key.split('node_modules/').pop() === name && !entry.dev);
    }

    function pinnedRange(name) {
        return (pkg.overrides || {})[name]
            || (pkg.dependencies || {})[name]
            || (pkg.devDependencies || {})[name];
    }

    advisories.forEach(function (adv) {
        const floor = adv.minSafe.join('.');

        it(`ADV-16: package.json pins ${adv.name} at or above ${floor}`, function () {
            if (!runtimeLockEntries(adv.name).length) return this.skip();
            const range = pinnedRange(adv.name);
            assert.ok(range,
                `expected ${adv.name} in overrides, dependencies or devDependencies`);
            const pinned = parse(range.replace(/^[^0-9]*/, ''));
            assert.ok(cmp(pinned, adv.minSafe) >= 0,
                `${adv.name} pin ${range} is below the patched version ${floor}`);
        });

        // An override alone does not move an entry npm has already locked: npm
        // re-resolves a lock entry only when the locked version falls outside
        // the range. Assert the resolved version rather than trusting the pin.
        it(`ADV-17: every runtime ${adv.name} entry in package-lock.json is at or above ${floor}`, function () {
            const entries = runtimeLockEntries(adv.name);
            if (!entries.length) return this.skip();

            entries.forEach(([key, entry]) => {
                const found = parse(entry.version);
                assert.strictEqual(found[0], adv.majorSeries,
                    `${key} left the ${adv.majorSeries}.x series at ${entry.version}; re-check the advisory range`);
                assert.ok(cmp(found, adv.minSafe) >= 0,
                    `${key} is ${entry.version}, inside the vulnerable range (fixed in ${floor})`);
            });
        });

        it(`ADV-18: the installed ${adv.name} on disk reports a patched version`, function () {
            if (!runtimeLockEntries(adv.name).length) return this.skip();
            const manifest = path.join(root, 'node_modules', adv.name, 'package.json');
            // A checkout that has not installed yet proves nothing here; ADV-17
            // already covers what a fresh install would produce.
            if (!fs.existsSync(manifest)) return this.skip();

            const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
            assert.ok(cmp(parse(installed), adv.minSafe) >= 0,
                `installed ${adv.name} is ${installed}, inside the vulnerable range (fixed in ${floor})`);
        });

        // The point of the whole file: the shared guard lists fast-uri too, at a
        // floor the advisory range has since swallowed. If a twin-file sync ever
        // raises the shared floor past this one, this row is what stops the
        // weaker number from quietly becoming the operative one.
        it(`ADV-19: the shared guard's ${adv.name} floor is not above the one enforced here`, function () {
            const companion = fs.readFileSync(
                path.join(__dirname, 'dependency-advisories.test.js'), 'utf8');
            const re = new RegExp(
                `\\{\\s*name:\\s*'${adv.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',`
                + '\\s*minSafe:\\s*\\[\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\s*\\]');
            const match = re.exec(companion);
            // Not every package guarded here is listed there; qs is not today.
            if (!match) return this.skip();

            const shared = [Number(match[1]), Number(match[2]), Number(match[3])];
            assert.ok(cmp(adv.minSafe, shared) >= 0,
                `dependency-advisories.test.js now pins ${adv.name} at ${shared.join('.')}, above the `
                + `${floor} enforced here. Raise this file's floor to match, or drop the row if the `
                + 'shared guard has fully absorbed it.');
        });
    });

    // The same staged-tree hazard sibling-tree-advisories.test.js describes, for
    // the two floors that file cannot carry: xchain-hub and xchain-sdk are
    // gitignored file: dependencies staged at build time, and once a staged
    // directory has lost its package.json npm stops reconciling the node_modules
    // inside it. A vulnerable copy there survives every later `npm ci` and is
    // invisible to the lockfile assertions above, which describe what a fresh
    // install WOULD produce rather than what is on disk.
    function stagedSiblings() {
        return Object.entries(pkg.dependencies || {})
            .filter(([, range]) => /^file:/.test(String(range)))
            .map(([name, range]) => ({
                name,
                dir: path.resolve(root, String(range).replace(/^file:/, ''))
            }));
    }

    // Yields { name, version, path } for every package under a node_modules
    // tree, descending into scopes and nested node_modules. Depth is bounded so
    // a symlink cycle in a staged bundle cannot hang the suite.
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

    stagedSiblings().forEach(function (sibling) {
        it(`ADV-20: ${sibling.name}'s staged node_modules carries no copy below these floors`, function () {
            this.timeout(30000);

            const nested = path.join(sibling.dir, 'node_modules');
            // A checkout that has not staged this sibling yet has nothing to
            // check. That is the normal state in CI, where the sibling is
            // checked out beside the repo instead of inside it.
            if (!fs.existsSync(nested)) return this.skip();

            const floors = {};
            advisories.forEach(adv => { floors[adv.name] = adv.minSafe; });

            const offenders = [];
            for (const found of walkTree(nested, 0)) {
                const floor = floors[found.name];
                if (!floor) continue;
                if (cmp(parse(found.version), floor) < 0) {
                    offenders.push(`${path.relative(root, found.path)} is ${found.name}@${found.version}, `
                        + `below ${floor.join('.')}`);
                }
            }

            assert.deepStrictEqual(offenders, [],
                `stale staged tree under ${sibling.name}: npm no longer manages it, so reinstalling will not `
                + 'clear these. Delete the nested node_modules and re-run npm ci.\n  '
                + offenders.join('\n  '));
        });
    });
});
