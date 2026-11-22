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
const fs = require('fs');
const path = require('path');

const { SCRUB_DIR, seg, FIXTURE_PSF, FIXTURE_HOME, FIXTURE_MAC, jsFilesUnder } = require('./helpers/history_leak_shared');
const patterns = require(path.join(SCRUB_DIR, 'leak-patterns'));

// The scrub of 2026-06-20 untracked two generated artifacts and was
// recorded as remediated, but untracking removes a file from the TREE and
// leaves the blob in HISTORY. These tests cover the detector half of the
// tooling that closes that gap: the patterns themselves.

function registerMatchCases() {
    it('matches every shape this repo actually leaked', function () {
        const cases = [
            FIXTURE_PSF,
            seg('media', 'psf'),                    // bare mount point, no sub-path
            FIXTURE_HOME,
            FIXTURE_MAC
        ];
        for (const c of cases) {
            assert.ok(patterns.hasLeak(c), `expected a leak match for ${JSON.stringify(c)}`);
        }
    });

    it('matches a path embedded in surrounding text, and stops at the path boundary', function () {
        const line = `# see ${FIXTURE_HOME} for details`;
        const found = patterns.findMatches(line);
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].text, FIXTURE_HOME, 'must not swallow the trailing words');
    });

    it('matches inside quotes and JSON without eating the delimiter', function () {
        const json  = JSON.stringify({ cwd: FIXTURE_MAC });
        const found = patterns.findMatches(json);
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].text, FIXTURE_MAC);
    });
}

function registerSafePathCases() {
    it('does not fire on system paths that are not developer paths', function () {
        const safe = [
            '/usr/local/bin/node',
            '/etc/hosts',
            '/var/lib/docker',
            '/opt/homebrew/bin/git',
            'https://example.com/home/page',        // a URL path segment, not a filesystem path
            seg('media', 'psfoo', 'x')              // prefix of the mount point, different mount
        ];
        for (const s of safe) {
            assert.ok(!patterns.hasLeak(s), `false positive on ${JSON.stringify(s)}`);
        }
    });

    it('carries no username of its own', function () {
        // The spec ships in a public repo. A pattern written against one
        // literal home directory would re-leak it in the scrub itself, and
        // would stop matching the moment the machine changed.
        //
        // "No username", not "no literal at all": the Parallels share is a
        // mount point identical on every such machine, so it is matched
        // literally on purpose. A home directory is the part that
        // identifies a person, and after /home/ or /Users/ a pattern must
        // continue into a character class, never into a name.
        for (const p of patterns.PATTERNS) {
            assert.ok(!/\/(home|Users)\/[A-Za-z0-9_]/.test(p.source),
                `pattern ${p.id} hard-codes a home directory name`);
        }
    });
}

function registerSelfScanCase() {
    it('does not trip its own detector', function () {
        // The self-poisoning trap, and the reason leak-patterns.js spells
        // the mount point with a one-character class. Two distinct failures
        // hide behind a green scan here:
        //
        //   - once committed, a spec file that matches its own patterns is
        //     a blob the scanner reports, so the standing gate can never be
        //     satisfied, and
        //   - --replace-text edits blobs by content with no notion of which
        //     file they came from, so a self-matching spec gets redacted by
        //     the run that is reading it.
        //
        // The suite files are included because they are committed alongside,
        // and is why their fixtures are assembled from parts at runtime.
        const files = jsFilesUnder(__dirname, path.join(__dirname, 'helpers'))
            .concat(fs.readdirSync(SCRUB_DIR).map((f) => path.join(SCRUB_DIR, f)));

        for (const f of files) {
            const found = patterns.findMatches(fs.readFileSync(f, 'utf8'));
            assert.deepStrictEqual(found.map((m) => m.text), [],
                `${path.basename(f)} contains a string matching the leak patterns`);
        }
    });
}

describe('Security: no developer-machine paths in git history: leak patterns @regression @tier4', function () {
    this.timeout(180000);

    describe('leak patterns', function () {
        registerMatchCases();
        registerSafePathCases();
        registerSelfScanCase();
    });
});
