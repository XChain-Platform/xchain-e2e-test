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

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const SCRUB_DIR = path.join(REPO_ROOT, 'scripts', 'history-scrub');

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

// The known leak sites in this repo's history, by object id. Object ids
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

/** Run rewrite-history.sh against a source repo, writing under out. */
function runRewrite(filterRepo, src, out) {
    return spawnSync('bash', [path.join(SCRUB_DIR, 'rewrite-history.sh'),
        '--source', src, '--out', out], {
        encoding: 'utf8',
        env: {
            ...process.env,
            ...(filterRepo === 'git-subcommand' ? {} : { GIT_FILTER_REPO: filterRepo })
        }
    });
}

/** Every .js file under the dirs, so the self-scan covers the split suite. */
function jsFilesUnder(...dirs) {
    return dirs.flatMap((dir) => fs.readdirSync(dir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => path.join(dir, f)));
}

module.exports = {
    REPO_ROOT, SCRUB_DIR, seg, FIXTURE_PSF, FIXTURE_HOME, FIXTURE_MAC,
    KNOWN_BLOB_LEAKS, KNOWN_COMMIT_MESSAGE_LEAKS, git, findFilterRepo, runRewrite, jsFilesUnder
};
