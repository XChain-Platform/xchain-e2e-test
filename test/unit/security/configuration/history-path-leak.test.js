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

const assert            = require('assert');
const fs                = require('fs');
const os                = require('os');
const path              = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRUB_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'history-scrub');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const patterns              = require(path.join(SCRUB_DIR, 'leak-patterns'));
const { scanRepo, leakCount, selectRevisions } = require(path.join(SCRUB_DIR, 'scan-history'));

// . The scrub of 2026-06-20 untracked two generated artifacts and was
// recorded as remediated, but untracking removes a file from the TREE and
// leaves the blob in HISTORY, where every clone and every raw-blob URL still
// serves it. These tests cover the tooling that closes that gap:
//
//   1. the detector agrees with the rewriter (a leak shape one knows and the
//      other does not is how a scrub verifies itself green while leaking),
//   2. this repo's history grows no NEW leak while the rewrite is pending,
//   3. the rewrite actually removes leaks without damaging live files.
//
// (3) is the one worth having. Purging a path is the obvious way to remove a
// leaked blob and it is wrong for any file that is still alive: it would delete
// the whole file's history, good versions included. The fixture below is built
// specifically so a path-purge would pass a naive leak check and still be a bug.

// ---------------------------------------------------------------------------
// Leaked paths are assembled from parts, never written as literals.
//
// Not style. A literal like the one this builds, sitting in a committed test
// file, is itself a blob in history matching the detector's own patterns: the
// fixtures would trip the scan they exist to test, and this repo is public at
// flip. Anything that must LOOK like a developer path gets built at runtime.
const seg = (...parts) => '/' + parts.join('/');

const FIXTURE_PSF  = seg('media', 'psf', 'Sites', 'Fixture');
const FIXTURE_HOME = seg('home', 'fixtureuser', '.fixture-data');
const FIXTURE_MAC  = seg('Users', 'fixtureuser', 'Sites', 'Fixture');

// The leak sites in this repo's history as of , by object id. Object ids
// are safe to write down; they are not paths.
//
// The assertion built on this list is deliberately "found is a SUBSET of
// known", not "found equals known". Equality would make the test fail the
// moment the rewrite succeeds, which is backwards: the standing job here is to
// catch a NEW leak landing, and it has to keep doing that both before the
// rewrite (when these four are present) and after it (when none are).
const KNOWN_BLOB_LEAKS = new Set([
    '4397c8b2aa8e16080037831c2d3d7d0592346e87', // reports/mutation/phase1.html
    'f3b392eaa46d8f32b88403a1d03504069557594f', // reports/mutation/phase1.json
    'e7739115af6c40a0ba3edbf13cd9ef8f3389aef2'  // test/parity/run-multichain-parity.sh, pre-4f1c28f
]);
const KNOWN_COMMIT_MESSAGE_LEAKS = new Set([
    '379912de6ae4f33f7bf0d59097f36fd99e46cb41'  // the untracking commit, which names the path it removed
]);

/**
 * git with the ambient environment neutralised.
 *
 * A global `commit.gpgsign` or `tag.gpgsign` turns fixture creation into a
 * signing prompt or a hard failure on a machine with no key loaded, which reads
 * as a broken test rather than a broken config. Identity is forced for the same
 * reason: a machine without user.email cannot commit at all.
 */
function git(cwd, args) {
    return execFileSync('git', [
        '-c', 'user.name=XC287 Fixture',
        '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false',
        '-c', 'tag.gpgsign=false',
        '-c', 'gc.auto=0',
        '-C', cwd,
        ...args
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Where git-filter-repo lives, or null. */
function findFilterRepo() {
    const env = process.env.GIT_FILTER_REPO;
    if (env && fs.existsSync(env)) return env;
    const which = spawnSync('command', ['-v', 'git-filter-repo'], { shell: true, encoding: 'utf8' });
    if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
    const sub = spawnSync('git', ['filter-repo', '--version'], { encoding: 'utf8' });
    if (sub.status === 0) return 'git-subcommand';
    return null;
}

describe('Security: no developer-machine paths in git history  @regression @tier4', function () {
    this.timeout(180000);

    describe('leak patterns', function () {
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

        it('does not trip its own detector', function () {
            // The self-poisoning trap, and the reason leak-patterns.js spells
            // the mount point with a one-character class. Two distinct failures
            // hide behind a green scan here:
            //
            //   - once committed, a spec file that matches its own patterns is
            //     a blob the scanner reports, so the standing gate below can
            //     never be satisfied, and
            //   - --replace-text edits blobs by content with no notion of which
            //     file they came from, so a self-matching spec gets redacted by
            //     the run that is reading it.
            //
            // The test file is included because it is committed alongside, and
            // is why its fixtures are assembled from parts at runtime.
            const files = fs.readdirSync(SCRUB_DIR).map((f) => path.join(SCRUB_DIR, f));
            files.push(__filename);

            for (const f of files) {
                const found = patterns.findMatches(fs.readFileSync(f, 'utf8'));
                assert.deepStrictEqual(found.map((m) => m.text), [],
                    `${path.basename(f)} contains a string matching the leak patterns`);
            }
        });
    });

    describe('rewriter and detector agree', function () {
        it('the emitted filter-repo specs are byte-identical to the committed ones', function () {
            for (const [name, header] of Object.entries(patterns.SPEC_FILES)) {
                const onDisk   = fs.readFileSync(path.join(SCRUB_DIR, name), 'utf8');
                const expected = patterns.emitFilterRepoSpec(header);
                assert.strictEqual(onDisk, expected,
                    `${name} is stale; run: node scripts/history-scrub/leak-patterns.js --emit`);
            }
        });

        it('every detector pattern has a matching rewrite expression', function () {
            const spec = patterns.parseFilterRepoSpec(
                fs.readFileSync(path.join(SCRUB_DIR, 'filter-repo-replace-text.txt'), 'utf8')
            );
            assert.strictEqual(spec.length, patterns.PATTERNS.length);
            for (const p of patterns.PATTERNS) {
                const line = `regex:${p.source}==>${patterns.REPLACEMENT}`;
                assert.ok(spec.includes(line), `no rewrite expression for pattern ${p.id}`);
            }
        });

        it('the path-purge spec lists only ignored, generated artifacts', function () {
            const body  = fs.readFileSync(path.join(SCRUB_DIR, 'filter-repo-paths.txt'), 'utf8');
            const purge = patterns.parseFilterRepoSpec(body);
            assert.ok(purge.length > 0, 'nothing listed to purge');

            for (const p of purge) {
                // check-ignore is the real question: purging a path that is not
                // ignored means the file comes straight back on the next commit
                // and the rewrite has to be done again.
                const r = spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', p]);
                assert.strictEqual(r.status, 0, `${p} is queued for purge but is not gitignored`);
            }

            // The curated report is the artifact the 2026-06-20 scrub explicitly
            // kept. Purging reports/mutation wholesale would take it with them.
            assert.ok(!purge.some((p) => p.endsWith('.md')),
                'a curated markdown report is queued for purge');
        });

        it('never contains a push', function () {
            // The script's whole safety property. A `git push` reaching it by a
            // later edit would turn a rehearsal into an irreversible act.
            const body = fs.readFileSync(path.join(SCRUB_DIR, 'rewrite-history.sh'), 'utf8');

            // Comments and heredoc bodies are stripped, not just comments: the
            // script deliberately PRINTS the force-push command for the operator
            // to read, and that line lives in a heredoc. Leaving it in would
            // make this assertion permanently red for the wrong reason.
            const executable = [];
            let heredoc = null;
            for (const line of body.split('\n')) {
                if (heredoc !== null) {
                    if (line.trim() === heredoc) heredoc = null;
                    continue;
                }
                const open = line.match(/<<-?\s*'?([A-Za-z_][A-Za-z0-9_]*)'?/);
                if (open) { heredoc = open[1]; continue; }
                if (line.trim().startsWith('#')) continue;
                executable.push(line);
            }

            assert.ok(executable.length > 20, 'heredoc stripping ate the whole script');
            assert.ok(!/\bgit\s+(-C\s+\S+\s+)?push\b/.test(executable.join('\n')),
                'rewrite-history.sh contains an executable git push');
        });
    });

    describe('this repository', function () {
        let result;

        before(async function () {
            if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) return this.skip();
            result = await scanRepo(REPO_ROOT);
        });

        it('has no leak outside the four sites  documents', function () {
            const newBlobs = result.blobs
                .filter((b) => !KNOWN_BLOB_LEAKS.has(b.sha))
                .map((b) => `${b.sha} (${b.paths.join(', ')})`);
            const newMsgs = result.commits
                .filter((c) => !KNOWN_COMMIT_MESSAGE_LEAKS.has(c.sha))
                .map((c) => c.sha);

            assert.deepStrictEqual(newBlobs, [],
                'a NEW developer path reached git history; it cannot be fixed by editing the file, ' +
                'because the blob stays reachable. See scripts/history-scrub/.');
            assert.deepStrictEqual(newMsgs, [],
                'a NEW developer path reached a commit message');
        });

        it('has no leak in any tag annotation', function () {
            // Nothing here is grandfathered: no annotated tag has ever carried
            // one, so any hit is new.
            assert.deepStrictEqual(result.tags.map((t) => t.ref), []);
        });

        it('scanned the whole object graph, not just the working tree', function () {
            // Guards the scan going quietly vacuous. A detector that walks zero
            // blobs reports CLEAN, which is exactly the false negative  is.
            assert.ok(result.counts.blobs > 100,
                `only ${result.counts.blobs} blobs scanned; the scan is not reaching history`);
        });

        it('names every ref it chose not to scan', function () {
            // The cost of scanning published refs instead of --all  is
            // that something is being skipped. Skipping silently would be a way
            // to go green by looking away, so each skipped ref must arrive with
            // the rule that claimed it and that rule must be a known one.
            const known = new Set(['stash', 'original', 'prefetch', 'ci-venue', 'wip-rescue']);
            for (const e of result.selection.excluded) {
                assert.ok(known.has(e.rule), `ref ${e.ref} skipped by unknown rule ${e.rule}`);
            }
        });
    });

    // . The gate failed on a CI venue and nowhere else, naming a blob
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
    describe('scans published history, not a clone leftovers ', function () {
        let work;

        before(function () {
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'xc1350-'));
        });

        after(function () {
            if (work) fs.rmSync(work, { recursive: true, force: true });
        });

        let seq = 0;
        /** A repo with one clean commit, ready to have leaks added to it. */
        function newRepo() {
            const src = path.join(work, `repo-${++seq}`);
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

        it('ignores a loose object left behind by a rebuilt commit', async function () {
            // The exact shape of the false red: a leak is committed, noticed,
            // and the commit is rebuilt before it is pushed anywhere. The blob
            // survives in the object store, reachable from nothing.
            const src  = newRepo();
            commitLeak(src);
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

        it('ignores a leak reachable only from a CI venue scratch ref', async function () {
            const src  = newRepo();
            git(src, ['checkout', '--quiet', '-b', 'abandoned']);
            const sha  = commitLeak(src);
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

        it('still reports a leak that a branch, a remote branch or a tag carries', async function () {
            const src = newRepo();
            const onMaster = commitLeak(src, 'a.md');

            git(src, ['checkout', '--quiet', '-b', 'side']);
            const onSide = commitLeak(src, 'b.md');
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

        it('scans the detached commit under test when no branch ref names it', async function () {
            // The venue's own shape: the work clone checks the pushed commit out
            // detached, and every ref it holds is a ci-* scratch ref. If the
            // filter left the scan with nothing to walk, the gate would go green
            // on a genuinely leaking commit, which is worse than the false red
            // it replaced.
            const src = newRepo();
            const sha = commitLeak(src);
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
            const src = path.join(work, 'empty');
            fs.mkdirSync(src, { recursive: true });
            git(src, ['init', '--quiet', '--initial-branch=master', '.']);

            await assert.rejects(() => scanRepo(src), /no published refs and no HEAD/,
                'an empty ref selection must be an error, never a clean verdict');
        });
    });

    describe('rewrite rehearsal against a fixture repository', function () {
        let work, filterRepo;

        before(function () {
            filterRepo = findFilterRepo();
            if (!filterRepo) {
                // Not a silent pass: the assertions above still run, and the
                // rehearsal is an operator step gated on a tool the CI image is
                // not required to carry.
                this.skip();
            }
            work = fs.mkdtempSync(path.join(os.tmpdir(), 'xc287-fixture-'));
        });

        after(function () {
            if (work) fs.rmSync(work, { recursive: true, force: true });
        });

        /**
         * A repo reproducing all four leak surfaces:
         *   1. a generated artifact tracked then untracked (leak survives in history)
         *   2. a commit message naming the path it removed
         *   3. a LIVE file that leaked in an early version and was fixed later
         *   4. an annotated tag pointing into the leaky history
         * Returns the source path and the tip content of the live file.
         */
        let fixtureSeq = 0;
        function buildFixture() {
            // A fresh directory per call. Reusing one made the second build
            // re-tag an existing tag and fail on that rather than on anything
            // the test was actually checking.
            const src = path.join(work, `source-${++fixtureSeq}`);
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

            return { src, live: 'test/parity/run.sh', cleanContent: clean };
        }

        it('finds leaks a working-tree grep cannot see, then removes all of them', async function () {
            const fx = buildFixture();

            const before = await scanRepo(fx.src);
            assert.ok(leakCount(before) >= 4,
                `fixture should leak in at least 4 places, found ${leakCount(before)}`);
            assert.ok(before.tags.length >= 1, 'annotated tag leak not detected');
            assert.ok(before.commits.length >= 1, 'commit message leak not detected');

            // The false negative  is made of: the live file's tip is clean
            // and the artifact is untracked, so the tree looks scrubbed.
            const tip = git(fx.src, ['show', `master:${fx.live}`]);
            assert.ok(!patterns.hasLeak(tip), 'fixture tip should already look clean');

            const out = path.join(work, 'run');
            const r = spawnSync('bash', [path.join(SCRUB_DIR, 'rewrite-history.sh'),
                '--source', fx.src, '--out', out], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    ...(filterRepo === 'git-subcommand' ? {} : { GIT_FILTER_REPO: filterRepo })
                }
            });
            assert.strictEqual(r.status, 0,
                `rewrite-history.sh failed:\n${r.stdout}\n${r.stderr}`);
            assert.match(r.stdout, /VERIFIED CLEAN/);

            const mirror = path.join(out, 'scrubbed.git');
            const after  = await scanRepo(mirror);
            assert.strictEqual(leakCount(after), 0, 'leaks survived the rewrite');
        });

        it('leaves live files byte-identical and keeps curated artifacts', async function () {
            const fx = buildFixture();
            const out = path.join(work, 'run2');
            const r = spawnSync('bash', [path.join(SCRUB_DIR, 'rewrite-history.sh'),
                '--source', fx.src, '--out', out], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    ...(filterRepo === 'git-subcommand' ? {} : { GIT_FILTER_REPO: filterRepo })
                }
            });
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

        it('reports success without rewriting an already-clean source', async function () {
            const src = path.join(work, 'clean');
            fs.mkdirSync(src, { recursive: true });
            git(src, ['init', '--quiet', '--initial-branch=master', '.']);
            fs.writeFileSync(path.join(src, 'a.txt'), 'nothing to see\n');
            git(src, ['add', '-A']);
            git(src, ['commit', '--quiet', '-m', 'init']);

            const r = spawnSync('bash', [path.join(SCRUB_DIR, 'rewrite-history.sh'),
                '--source', src, '--out', path.join(work, 'run3')], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    ...(filterRepo === 'git-subcommand' ? {} : { GIT_FILTER_REPO: filterRepo })
                }
            });
            assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
            assert.match(r.stdout, /ALREADY CLEAN/);
        });

    });
});
