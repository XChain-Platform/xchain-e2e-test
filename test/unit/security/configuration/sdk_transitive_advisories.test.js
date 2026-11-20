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

// Third file in this directory, and deliberately separate from both of its
// neighbours. dependency-advisories.test.js is byte-identical across every
// sibling repo that carries it, so nothing repo-specific may be added there,
// and sibling_tree_advisories.test.js asserts that its own floor list matches
// that shared file exactly. The advisories guarded here arrive through the
// staged xchain-sdk rather than through anything this repo declares, so they
// belong in neither list.
//
// All three are closed. The first two remain pinned, while the third is guarded
// as an empty runtime residual so a future dependency cannot reintroduce it.
const root = path.resolve(__dirname, '..', '..', '..', '..');
const pkg  = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));

// Both of these reach the runtime tree only as transitive dependencies of
// @modelcontextprotocol/sdk, which xchain-sdk declares. Neither is a
// dependency of this repo, so both are held down by overrides.
//
// @hono/node-server <2.1.8 has multiple serve-static path handling flaws.
// @modelcontextprotocol/sdk already allows the patched 2.x series.
//
// hono <4.12.34 carries four at once: ReDoS in the CORS middleware via
// Access-Control-Request-Headers (GHSA-8j4g-w8fx-2239), memo() retaining
// SSR output across requests and disclosing one user's render to the next
// (GHSA-f23p-vx2j-j53r), the proxy helper forwarding response headers the
// Connection header named for removal (GHSA-79qm-7rj5-m7r9), and
// algorithmic-complexity DoS in the language middleware
// (GHSA-54fx-42gc-7vw4). Also inside the declared range (^4.11.4).
//
// Both were invisible to the shared guard because an override alone does
// not move an entry npm has already locked: npm re-resolves a lock entry
// only when it is absent. The versions below were spliced into
// package-lock.json and installed, so assert the resolved version rather
// than trusting the pin.
const advisories = [
    { name: '@hono/node-server', minSafe: [2, 1, 8], majorSeries: 2 },
    { name: 'hono',              minSafe: [4, 12, 34], majorSeries: 4 }
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

function lockEntries(name) {
    return Object.entries(lock.packages)
        .filter(([key]) => key.split('node_modules/').pop() === name);
}

function pinnedRange(name) {
    return (pkg.overrides || {})[name]
        || (pkg.dependencies || {})[name]
        || (pkg.devDependencies || {})[name];
}

function advisoryChecks() {
    advisories.forEach(function (adv) {
        const floor = adv.minSafe.join('.');

        it(`ADV-11: package.json pins ${adv.name} at or above ${floor}`, function () {
            if (!lockEntries(adv.name).length) return this.skip();
            const range = pinnedRange(adv.name);
            assert.ok(range,
                `expected ${adv.name} in overrides, dependencies or devDependencies`);
            const pinned = parse(range.replace(/^[^0-9]*/, ''));
            assert.ok(cmp(pinned, adv.minSafe) >= 0,
                `${adv.name} pin ${range} is below the patched version ${floor}`);
        });

        it(`ADV-12: every ${adv.name} entry in package-lock.json is at or above ${floor}`, function () {
            const entries = lockEntries(adv.name);
            if (!entries.length) return this.skip();

            entries.forEach(([key, entry]) => {
                const found = parse(entry.version);
                assert.strictEqual(found[0], adv.majorSeries,
                    `${key} left the ${adv.majorSeries}.x series at ${entry.version}; re-check the advisory range`);
                assert.ok(cmp(found, adv.minSafe) >= 0,
                    `${key} is ${entry.version}, inside the vulnerable range (fixed in ${floor})`);
            });
        });

        it(`ADV-13: the installed ${adv.name} on disk reports a patched version`, function () {
            if (!lockEntries(adv.name).length) return this.skip();
            const manifest = path.join(root, 'node_modules', adv.name, 'package.json');
            // A checkout that has not installed yet proves nothing here; ADV-12
            // above already covers what a fresh install would produce.
            if (!fs.existsSync(manifest)) return this.skip();

            const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
            assert.ok(cmp(parse(installed), adv.minSafe) >= 0,
                `installed ${adv.name} is ${installed}, inside the vulnerable range (fixed in ${floor})`);
        });
    });
}

// GHSA-848j-6mx2-7j84 (elliptic, low) has no patched release, but the staged
// SDK no longer depends on bitcoinjs-message or secp256k1. Nothing reaches
// elliptic at runtime now, so the accepted production residual is empty.
// Keep that exact shape recorded rather than dropping the check: a future
// runtime dependency on elliptic must fail this gate and be reviewed.
const ACCEPTED_RUNTIME_RESIDUAL = [];

// Every non-dev lockfile entry declaring `child`, named the way npm audit
// names it: the package name for a node_modules entry, the lockfile key for
// a staged file: sibling, which has no node_modules segment to strip.
function runtimeParentsOf(child) {
    const parents = new Set();
    for (const [key, entry] of Object.entries(lock.packages)) {
        if (!key || entry.dev) continue;
        const declared = Object.assign({}, entry.dependencies, entry.optionalDependencies);
        if (!Object.prototype.hasOwnProperty.call(declared, child)) continue;
        parents.add(key.includes('node_modules/') ? key.split('node_modules/').pop() : key);
    }
    return [...parents].sort();
}

function residualChecks() {
    it('ADV-14: elliptic has no accepted runtime reachers', function () {
        assert.deepStrictEqual(runtimeParentsOf('elliptic'), ACCEPTED_RUNTIME_RESIDUAL,
            'the accepted elliptic residual changed from empty. Re-read GHSA-848j-6mx2-7j84 and '
            + 'decide the acceptance again rather than widening it by default.');
    });
}

describe('Security: advisories reaching this tree through the staged SDK @regression @tier4', advisoryChecks);
describe('Security: advisories reaching this tree through the staged SDK @regression @tier4', residualChecks);
