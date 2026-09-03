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
// and sibling-tree-advisories.test.js asserts that its own floor list matches
// that shared file exactly. The advisories guarded here arrive through the
// staged xchain-sdk rather than through anything this repo declares, so they
// belong in neither list.
//
// Two of the three are closed; the third cannot be, and saying so precisely is
// most of the point of this file.
describe('Security: advisories reaching this tree through the staged SDK @regression @tier4', function () {
    const root = path.resolve(__dirname, '..', '..', '..', '..');
    const pkg  = require(path.join(root, 'package.json'));
    const lock = require(path.join(root, 'package-lock.json'));

    // Both of these reach the runtime tree only as transitive dependencies of
    // @modelcontextprotocol/sdk, which xchain-sdk declares. Neither is a
    // dependency of this repo, so both are held down by overrides.
    //
    // @hono/node-server <1.19.15 (GHSA-frvp-7c67-39w9): serve-static resolves
    // an encoded backslash (%5C) as a path separator on Windows, so a request
    // escapes the served root. The platform serves nothing from Windows, which
    // is why this sat as a residual rather than a hotfix, but the fix is a
    // patch release inside the range @modelcontextprotocol/sdk already asks
    // for (^1.19.9), so there is no reason to keep carrying it.
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
        { name: '@hono/node-server', minSafe: [1, 19, 15], majorSeries: 1 },
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

    // The residual, and the reason this file exists rather than another line in
    // the shared list.
    //
    // GHSA-848j-6mx2-7j84 (elliptic, low): the vulnerable range is every
    // published version up to and including 6.6.1, which is also the newest
    // release upstream has ever cut. There is no patched elliptic to move to,
    // so no pin, override or lockfile splice can clear it. The only remediation
    // npm offers is bitcoinjs-message@1.0.0, a downgrade across a major that
    // rewrites the message-signing API xchain-sdk's auth path calls, so taking
    // it would break signing to silence a low-severity finding on a dependency
    // the platform does not use for consensus signatures.
    //
    // What can be guarded is the shape of the residual: exactly one runtime
    // path, and no second one appearing later. If a new runtime dependency ever
    // pulls elliptic in by another route, this fails and the acceptance above
    // has to be re-argued rather than silently extended. Dev-only reachers
    // (browserify's crypto-browserify, via browserify-sign and create-ecdh) are
    // excluded because `npm audit --omit=dev` is the gate this documents.
    const RESIDUAL_CHAIN = [
        { child: 'elliptic',          expectedParents: ['secp256k1'] },
        { child: 'secp256k1',         expectedParents: ['bitcoinjs-message'] },
        { child: 'bitcoinjs-message', expectedParents: ['xchain-sdk'] }
    ];

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

    RESIDUAL_CHAIN.forEach(function (link) {
        it(`ADV-14: ${link.child} is reached at runtime only through ${link.expectedParents.join(', ')}`, function () {
            if (!lockEntries(link.child).length && !lock.packages[link.child]) return this.skip();

            assert.deepStrictEqual(runtimeParentsOf(link.child), link.expectedParents.slice().sort(),
                `the accepted elliptic residual changed shape: ${link.child} is now pulled in by a different `
                + 'set of runtime packages than the one this file documents. Re-read GHSA-848j-6mx2-7j84 and '
                + 'decide the acceptance again rather than widening it by default.');
        });
    });

    // The acceptance rests on elliptic having no patched release. That is a
    // fact about upstream, not about this tree, and it will stop being true one
    // day. Pinning the tree at the top of the vulnerable range means the day a
    // 6.6.2 (or a 7.x) ships carrying the fix, an ordinary bump clears the
    // finding with no further argument, and a tree that drifted BELOW 6.6.1 in
    // the meantime is a regression this catches now rather than at the bump.
    it('ADV-15: elliptic sits at the top of the vulnerable range, not somewhere inside it', function () {
        const entries = lockEntries('elliptic');
        if (!entries.length) return this.skip();

        entries.forEach(([key, entry]) => {
            assert.ok(cmp(parse(entry.version), [6, 6, 1]) >= 0,
                `${key} is elliptic@${entry.version}; 6.6.1 is the newest published release and the `
                + 'floor this tree holds while GHSA-848j-6mx2-7j84 has no fix');
        });
    });
});
