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
const os = require('os');
const path = require('path');

const {
    SCRUB_DIR, FIXTURE_PSF, FIXTURE_HOME, FIXTURE_MAC, git, findFilterRepo, runRewrite
} = require('./helpers/history_leak_shared');
const patterns = require(path.join(SCRUB_DIR, 'leak-patterns'));
const { scanRepo, leakCount } = require(path.join(SCRUB_DIR, 'scan-history'));

// The rewrite actually removes leaks without damaging live files. Purging a
// path is the obvious way to remove a leaked blob and it is wrong for any file
// that is still alive: it would delete the whole file's history, good versions
// included. The fixture below is built specifically so a path-purge would pass
// a naive leak check and still be a bug.

/** First half of the fixture: the live file and curated report, with a leaky tag. */
function commitHarness(src) {
    fs.mkdirSync(path.join(src, 'reports', 'mutation'), { recursive: true });
    fs.mkdirSync(path.join(src, 'test', 'parity'), { recursive: true });
    git(src, ['init', '--quiet', '--initial-branch=master', '.']);

    const live = path.join(src, 'test', 'parity', 'run.sh');
    fs.writeFileSync(live, `#!/bin/sh\n# data dir: ${FIXTURE_HOME}\n# share: ${FIXTURE_PSF}\necho run\n`);
    fs.writeFileSync(path.join(src, 'reports', 'mutation', 'report.md'), '# curated, keep me\n');
    git(src, ['add', '-A']);
    git(src, ['commit', '--quiet', '-m', 'feat: harness']);
    // 4: the leak is in the ANNOTATION, which `git log --all` never
    // walks, so only a scan that reads tag objects finds it.
    git(src, ['tag', '-a', 'v0-leaky', '-m', `cut from ${FIXTURE_PSF}`]);
    return live;
}

/** Second half: track a generated artifact, genericise the live file, untrack. */
function commitCleanup(src, live) {
    const gen = path.join(src, 'reports', 'mutation', 'phase1.json');
    fs.writeFileSync(gen, JSON.stringify({ cwd: FIXTURE_MAC, mutants: [] }));
    git(src, ['add', '-A']);
    git(src, ['commit', '--quiet', '-m', 'chore: mutation output']);

    // 3: the live file is genericised. Its CURRENT content is clean, so
    // a working-tree grep goes green here while history still leaks.
    const clean = '#!/bin/sh\n# data dir: $XCHAIN_NODE_DATA_DIR\n# share: staged tree\necho run\n';
    fs.writeFileSync(live, clean);
    git(src, ['add', '-A']);
    git(src, ['commit', '--quiet', '-m', 'chore: genericise dev paths']);

    // 1 + 2: untrack the artifact, and name the path in the message.
    fs.writeFileSync(path.join(src, '.gitignore'), 'reports/mutation/*.json\n');
    git(src, ['rm', '--quiet', '--cached', 'reports/mutation/phase1.json']);
    git(src, ['add', '.gitignore']);
    git(src, ['commit', '--quiet', '-m', `chore: untrack output that embeds ${FIXTURE_MAC}`]);
    return clean;
}

/**
 * A repo reproducing all four leak surfaces:
 *   1. a generated artifact tracked then untracked (leak survives in history)
 *   2. a commit message naming the path it removed
 *   3. a LIVE file that leaked in an early version and was fixed later
 *   4. an annotated tag pointing into the leaky history
 * Returns the source path and the tip content of the live file.
 */
function repoFixtureBuilder(getWork) {
    let fixtureSeq = 0;
    return function buildFixture() {
        // A fresh directory per call. Reusing one made the second build
        // re-tag an existing tag and fail on that rather than on anything
        // the test was actually checking.
        const src = path.join(getWork(), `source-${++fixtureSeq}`);
        const live = commitHarness(src);
        const cleanContent = commitCleanup(src, live);
        return { src, live: 'test/parity/run.sh', cleanContent };
    };
}

function registerRemovalCase(ctx) {
    it('finds leaks a working-tree grep cannot see, then removes all of them', async function () {
        const fx = ctx.buildFixture();

        const before = await scanRepo(fx.src);
        assert.ok(leakCount(before) >= 4,
            `fixture should leak in at least 4 places, found ${leakCount(before)}`);
        assert.ok(before.tags.length >= 1, 'annotated tag leak not detected');
        assert.ok(before.commits.length >= 1, 'commit message leak not detected');

        // The false negative this guards against: the live file's tip is clean
        // and the artifact is untracked, so the tree looks scrubbed.
        const tip = git(fx.src, ['show', `master:${fx.live}`]);
        assert.ok(!patterns.hasLeak(tip), 'fixture tip should already look clean');

        const out = path.join(ctx.work(), 'run');
        const r = runRewrite(ctx.filterRepo(), fx.src, out);
        assert.strictEqual(r.status, 0,
            `rewrite-history.sh failed:\n${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /VERIFIED CLEAN/);

        const after = await scanRepo(path.join(out, 'scrubbed.git'));
        assert.strictEqual(leakCount(after), 0, 'leaks survived the rewrite');
    });
}

function registerLiveFileCase(ctx) {
    it('leaves live files byte-identical and keeps curated artifacts', async function () {
        const fx = ctx.buildFixture();
        const out = path.join(ctx.work(), 'run2');
        const r = runRewrite(ctx.filterRepo(), fx.src, out);
        assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);

        const mirror = path.join(out, 'scrubbed.git');

        // The regression a path-purge would cause: the live file's current
        // content must survive untouched, because only its old versions leaked.
        const tip = git(mirror, ['show', `master:${fx.live}`]);
        assert.strictEqual(tip, fx.cleanContent, 'the rewrite altered a live file');

        // The curated report was never a leak and must not be collateral.
        const kept = git(mirror, ['show', 'master:reports/mutation/report.md']);
        assert.strictEqual(kept, '# curated, keep me\n');

        // The generated artifact must be gone from every tree, not just the tip.
        const objects = git(mirror, ['rev-list', '--objects', '--all']);
        assert.ok(!objects.includes('reports/mutation/phase1.json'),
            'the purged artifact is still reachable in history');
    });
}

function registerCleanSourceCase(ctx) {
    it('reports success without rewriting an already-clean source', async function () {
        const src = path.join(ctx.work(), 'clean');
        fs.mkdirSync(src, { recursive: true });
        git(src, ['init', '--quiet', '--initial-branch=master', '.']);
        fs.writeFileSync(path.join(src, 'a.txt'), 'nothing to see\n');
        git(src, ['add', '-A']);
        git(src, ['commit', '--quiet', '-m', 'init']);

        const r = runRewrite(ctx.filterRepo(), src, path.join(ctx.work(), 'run3'));
        assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /ALREADY CLEAN/);
    });
}

describe('Security: no developer-machine paths in git history: rewrite rehearsal @regression @tier4', function () {
    this.timeout(180000);

    describe('rewrite rehearsal against a fixture repository', function () {
        let work, filterRepo;
        const ctx = {
            work: () => work,
            filterRepo: () => filterRepo,
            buildFixture: repoFixtureBuilder(() => work)
        };

        before(function () {
            filterRepo = findFilterRepo();
            if (!filterRepo) {
                // Not a silent pass: the assertions in the sibling files
                // still run, and the rehearsal is an operator step gated on
                // a tool the CI image is not required to carry.
                this.skip();
            }
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'xc287-fixture-'));
        });

        after(function () {
            if (work) fs.rmSync(work, { recursive: true, force: true });
        });

        registerRemovalCase(ctx);
        registerLiveFileCase(ctx);
        registerCleanSourceCase(ctx);
    });
});
