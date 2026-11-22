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

const { SCRUB_DIR, FIXTURE_PSF, FIXTURE_HOME, git } = require('./helpers/history_leak_shared');
const { scanRepo, leakCount, selectRevisions } = require(path.join(SCRUB_DIR, 'scan-history'));

// The gate once failed on a CI venue and nowhere else, naming a blob
// that `git rev-list --objects` over the published refs of the real
// repository does not contain. Cause, measured on the venue: ci-dispatch.sh
// ships each pushed commit to the venue's bare repo as refs/heads/ci-<short>
// and never prunes it, and the venue's work clone is REUSED and refreshed
// with `+refs/*:refs/remotes/origin/*`. So it accumulates one ref per commit
// ever gated there, including commits that were rebuilt away before any
// push. `rev-list --all` in that clone walks all of them, so the gate
// reported a leak that belonged to an abandoned commit and that no edit to
// the pushed tree could clear.
//
// These tests pin the two halves of the fix: what is skipped, and, more
// importantly, that skipping it did not blind the detector.

/** Fixture builders over a work directory that is created per suite run. */
function repoKit(getWork) {
    let seq = 0;

    /** A repo with one clean commit, ready to have leaks added to it. */
    function newRepo() {
        const src = path.join(getWork(), `repo-${++seq}`);
        fs.mkdirSync(src, { recursive: true });
        git(src, ['init', '--quiet', '--initial-branch=master', '.']);
        fs.writeFileSync(path.join(src, 'ok.txt'), 'nothing to see\n');
        git(src, ['add', '-A']);
        git(src, ['commit', '--quiet', '-m', 'init']);
        return src;
    }

    /** Commit a file whose content carries a developer path. Returns its sha. */
    function commitLeak(src, rel = 'notes.md') {
        fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
        // The file name is part of the content: two leaky files with
        // identical bytes are ONE blob, and a test expecting two findings
        // would fail on git's deduplication rather than on the detector.
        fs.writeFileSync(path.join(src, rel), `# ${rel}\nrun it from ${FIXTURE_HOME}\n`);
        git(src, ['add', '-A']);
        git(src, ['commit', '--quiet', '-m', 'docs: notes']);
        return git(src, ['rev-parse', 'HEAD']).trim();
    }

    return { newRepo, commitLeak };
}

function registerSkippedRefCases(kit) {
    it('ignores a loose object left behind by a rebuilt commit', async function () {
        // The exact shape of the false red: a leak is committed, noticed,
        // and the commit is rebuilt before it is pushed anywhere. The blob
        // survives in the object store, reachable from nothing.
        const src  = kit.newRepo();
        kit.commitLeak(src);
        const blob = git(src, ['rev-parse', 'HEAD:notes.md']).trim();

        git(src, ['reset', '--quiet', '--hard', 'HEAD~1']);
        git(src, ['reflog', 'expire', '--expire=now', '--all']);

        assert.strictEqual(git(src, ['cat-file', '-t', blob]).trim(), 'blob',
            'fixture is wrong: the object should still be in the store');
        assert.ok(!git(src, ['rev-list', '--objects', '--all']).includes(blob),
            'fixture is wrong: the object should be unreachable');

        const result = await scanRepo(src);
        assert.strictEqual(leakCount(result), 0,
            'an object reachable from no ref was reported as a leak in this repository');
    });

}

function registerScratchRefCase(kit) {
    it('ignores a leak reachable only from a CI venue scratch ref', async function () {
        const src  = kit.newRepo();
        git(src, ['checkout', '--quiet', '-b', 'abandoned']);
        const sha  = kit.commitLeak(src);
        git(src, ['checkout', '--quiet', 'master']);
        git(src, ['branch', '--quiet', '-D', 'abandoned']);

        // What ci-dispatch.sh leaves on a venue, and what the venue's work
        // clone mirrors it to. Both spellings appear in the wild: the
        // current refspec writes the first, an older one wrote the second.
        const short = sha.slice(0, 8);
        git(src, ['update-ref', `refs/remotes/origin/ci-${short}`, sha]);
        git(src, ['update-ref', `refs/remotes/origin/heads/ci-${short}`, sha]);

        const result = await scanRepo(src);
        assert.strictEqual(leakCount(result), 0,
            'a leak carried only by a CI scratch ref was blamed on this repository');
        assert.deepStrictEqual(
            result.selection.excluded.map((e) => e.rule).sort(),
            ['ci-venue', 'ci-venue']);

        // The other half: prove the fixture really does leak, so the test
        // above is measuring the ref filter and not an inert fixture.
        const audit = await scanRepo(src, { allRefs: true });
        assert.strictEqual(leakCount(audit), 1,
            'the audit mode should still see the leak on the scratch ref');
    });
}

function registerPublishedRefCase(kit) {
    it('still reports a leak that a branch, a remote branch or a tag carries', async function () {
        const src = kit.newRepo();
        const onMaster = kit.commitLeak(src, 'a.md');

        git(src, ['checkout', '--quiet', '-b', 'side']);
        const onSide = kit.commitLeak(src, 'b.md');
        git(src, ['checkout', '--quiet', 'master']);
        git(src, ['branch', '--quiet', '-D', 'side']);
        git(src, ['update-ref', 'refs/remotes/origin/side', onSide]);
        git(src, ['tag', '-a', 'v1-leaky', '-m', `cut from ${FIXTURE_PSF}`, onMaster]);

        const result = await scanRepo(src);
        assert.strictEqual(result.blobs.length, 2,
            'a leak on a published branch or remote-tracking ref went unreported');
        assert.strictEqual(result.tags.length, 1,
            'a leak in a published tag annotation went unreported');
    });

}

function registerDetachedHeadCases(kit, getWork) {
    it('scans the detached commit under test when no branch ref names it', async function () {
        // The venue's own shape: the work clone checks the pushed commit out
        // detached, and every ref it holds is a ci-* scratch ref. If the
        // filter left the scan with nothing to walk, the gate would go green
        // on a genuinely leaking commit, which is worse than the false red
        // it replaced.
        const src = kit.newRepo();
        const sha = kit.commitLeak(src);
        git(src, ['checkout', '--quiet', '--detach', sha]);
        git(src, ['update-ref', '-d', 'refs/heads/master']);
        git(src, ['update-ref', `refs/remotes/origin/ci-${sha.slice(0, 8)}`, sha]);

        const selection = selectRevisions(src);
        assert.deepStrictEqual(selection.refs, [], 'fixture should have no published ref left');
        assert.deepStrictEqual(selection.revs, [sha], 'HEAD must still be scanned');

        const result = await scanRepo(src);
        assert.strictEqual(result.blobs.length, 1,
            'the commit under test was not scanned once its scratch ref was skipped');
    });

    it('refuses to call a repository clean when it has nothing to scan', async function () {
        const src = path.join(getWork(), 'empty');
        fs.mkdirSync(src, { recursive: true });
        git(src, ['init', '--quiet', '--initial-branch=master', '.']);

        await assert.rejects(() => scanRepo(src), /no published refs and no HEAD/,
            'an empty ref selection must be an error, never a clean verdict');
    });
}

describe('Security: no developer-machine paths in git history: published history @regression @tier4', function () {
    this.timeout(180000);

    describe('scans published history, not a clone leftovers', function () {
        let work;
        const getWork = () => work;
        const kit = repoKit(getWork);

        before(function () {
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'xc1350-'));
        });

        after(function () {
            if (work) fs.rmSync(work, { recursive: true, force: true });
        });

        registerSkippedRefCases(kit);
        registerScratchRefCase(kit);
        registerPublishedRefCase(kit);
        registerDetachedHeadCases(kit, getWork);
    });
});
