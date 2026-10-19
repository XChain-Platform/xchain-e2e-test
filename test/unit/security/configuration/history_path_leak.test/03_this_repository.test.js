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

const { SCRUB_DIR, REPO_ROOT, KNOWN_BLOB_LEAKS, KNOWN_COMMIT_MESSAGE_LEAKS } = require('./helpers/history_leak_shared');
const { scanRepo } = require(path.join(SCRUB_DIR, 'scan-history'));

// This repo's history grows no NEW leak while the rewrite is pending.

function registerLeakCases(getResult) {
    it('has no leak outside the four documented sites', function () {
        const result = getResult();
        const newBlobs = result.blobs
            .filter((b) => !KNOWN_BLOB_LEAKS.has(b.sha))
            .map((b) => `${b.sha} (${b.paths.join(', ')})`);
        const newMsgs = result.commits
            .filter((c) => !KNOWN_COMMIT_MESSAGE_LEAKS.has(c.sha))
            .map((c) => c.sha);

        assert.deepStrictEqual(newBlobs, [],
            'a NEW developer path reached git history; it cannot be fixed by editing the file, ' +
            'because the blob stays reachable. See bin/history-scrub/.');
        assert.deepStrictEqual(newMsgs, [],
            'a NEW developer path reached a commit message');
    });

    it('has no leak in any tag annotation', function () {
        // Nothing here is grandfathered: no annotated tag has ever carried
        // one, so any hit is new.
        assert.deepStrictEqual(getResult().tags.map((t) => t.ref), []);
    });
}

function registerCoverageCases(getResult) {
    it('scanned the whole object graph, not just the working tree', function () {
        // Guards the scan going quietly vacuous. A detector that walks zero
        // blobs reports CLEAN, which is exactly the false negative this catches.
        const { counts } = getResult();
        assert.ok(counts.blobs > 100,
            `only ${counts.blobs} blobs scanned; the scan is not reaching history`);
    });

    it('names every ref it chose not to scan', function () {
        // The cost of scanning published refs instead of --all is
        // that something is being skipped. Skipping silently would be a way
        // to go green by looking away, so each skipped ref must arrive with
        // the rule that claimed it and that rule must be a known one.
        const known = new Set(['stash', 'original', 'prefetch', 'ci-venue', 'wip-rescue', 'scrub-backup']);
        for (const e of getResult().selection.excluded) {
            assert.ok(known.has(e.rule), `ref ${e.ref} skipped by unknown rule ${e.rule}`);
        }
    });
}

describe('Security: no developer-machine paths in git history: this repository @regression @tier4', function () {
    this.timeout(180000);

    describe('this repository', function () {
        let result;
        const getResult = () => result;

        before(async function () {
            if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) return this.skip();
            result = await scanRepo(REPO_ROOT);
        });

        registerLeakCases(getResult);
        registerCoverageCases(getResult);
    });
});
