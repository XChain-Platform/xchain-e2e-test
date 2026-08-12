#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

// Leak detector for developer-machine paths anywhere in a repository's history.
//
// The distinction this exists to enforce: `git grep` and a plain working-tree
// scan look at ONE tree, so they go green the moment a bad file is untracked,
// while the blob is still sitting in history and still served by every clone
// and by GitHub's raw-blob endpoint.  is exactly that failure: 379912d
// untracked two artifacts and the scrub was recorded as remediated.
//
// So this walks OBJECTS, not the tree, and it walks them across every ref that
// carries PUBLISHED history:
//   - every blob reachable from a branch, a real remote-tracking ref or a tag
//   - every commit message
//   - every annotated-tag message
//
// "Published", not "--all", and that distinction is . A scan whose ref
// set is `--all` reports whatever objects the clone it runs in happens to hold,
// and a reused CI clone holds far more than the project's history: the venue
// gate fetches `+refs/*:refs/remotes/origin/*` from a bare repo that gains a
// per-commit `ci-<short>` branch on every push and never loses one, so a commit
// that was rebuilt away locally stays reachable on that venue forever. Measured
// 2026-08-10 on test-host: 38 refs, all of them `ci-*`, one of them (ci-74665416)
// holding a blob that `git rev-list --objects origin/master` on the real repo
// does not contain. The gate failed the commit being pushed for a leak that
// belonged to an abandoned commit on a scratch ref, was not reproducible
// anywhere else, and could not be fixed by any edit to the pushed tree.
//
// Exit code is the point: 0 clean, 1 leaks found, 2 usage/environment error.
// That makes it usable as the verification half of rewrite-history.sh and as
// the assertion behind history-path-leak.test.js.

const { spawn, spawnSync } = require('child_process');
const path                 = require('path');
const { findMatches }      = require('./leak-patterns');

/**
 * Refs that are local scratch, never published, and therefore never this
 * repository's history. Each rule says who writes the ref, because the only
 * safe reason to skip a ref is knowing that something else creates it.
 *
 * Skipping is not free: a rule that swallowed a real branch would turn this
 * detector green while the repo leaked, which is the exact failure  is.
 * Two things keep that honest: the excluded refs are named in the report rather
 * than dropped silently, and scanRepo() refuses to run at all if the rules
 * leave it with nothing to scan.
 */
const SCRATCH_REF_RULES = [
    // `git stash`: a private working-tree snapshot, pushed nowhere.
    { id: 'stash',      test: (ref) => ref === 'refs/stash' },
    // git-filter-branch's backup of the pre-rewrite refs.
    { id: 'original',   test: (ref) => ref.startsWith('refs/original/') },
    // `git maintenance`'s background prefetch of the remote.
    { id: 'prefetch',   test: (ref) => ref.startsWith('refs/prefetch/') },
    // ci-dispatch.sh pushes the commit under test to refs/heads/ci-<short> on
    // the venue's bare repo, one ref per commit ever gated, never pruned. The
    // venue work clone mirrors them under refs/remotes/origin/ (and, from an
    // older refspec, refs/remotes/origin/heads/). ci-sibling is the same idea
    // for a declared sibling repo. The commit under test is HEAD in that
    // clone, so nothing is lost by skipping these.
    { id: 'ci-venue',   test: (ref) => /(^|\/)ci-[0-9a-f]{7,40}$/.test(ref) || /(^|\/)ci-sibling$/.test(ref) },
    // Local rescue tags written when recovering a clobbered shared worktree.
    { id: 'wip-rescue', test: (ref) => /(^|\/)wip-rescue\//.test(ref) }
];

/** The scratch rule that claims this ref, or null. */
function scratchRule(ref) {
    return SCRATCH_REF_RULES.find((r) => r.test(ref)) || null;
}

/** Run git and return stdout, or throw with git's stderr attached. */
function git(repo, args, { maxBuffer = 512 * 1024 * 1024, input = null } = {}) {
    const opts = { maxBuffer, encoding: 'buffer' };
    // A Buffer, always: with encoding 'buffer' node hands `input` straight to
    // Buffer.from(value, encoding) and rejects a string with "Unknown encoding".
    if (input !== null) opts.input = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    const r = spawnSync('git', ['-C', repo, ...args], opts);
    if (r.error) throw r.error;
    if (r.status !== 0) {
        const msg = (r.stderr || Buffer.alloc(0)).toString('utf8').trim();
        throw new Error(`git ${args.join(' ')} failed (${r.status}): ${msg}`);
    }
    return r.stdout;
}

/**
 * The revisions to walk: every published ref, plus HEAD.
 *
 * HEAD is listed explicitly and is not redundant. A CI venue checks the commit
 * under test out detached and its only branch refs are the scratch ones skipped
 * above, so HEAD is the entire published history there. Without it the scan
 * would have nothing to walk on exactly the machine the gate runs on.
 *
 * Returns { revs, refs, excluded } where `excluded` is [{ref, rule}] for the
 * report.
 */
function selectRevisions(repo, { allRefs = false } = {}) {
    const out  = git(repo, ['for-each-ref', '--format=%(refname)']).toString('utf8');
    const all  = out.split('\n').map((s) => s.trim()).filter(Boolean);

    const refs     = [];
    const excluded = [];
    for (const ref of all) {
        const rule = allRefs ? null : scratchRule(ref);
        if (rule) excluded.push({ ref, rule: rule.id });
        else refs.push(ref);
    }

    const revs = refs.slice();
    // An unborn HEAD (a repo with no commit yet) resolves to nothing; asking
    // rev-list to walk it would be a hard error rather than an empty result.
    const head = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'], { encoding: 'utf8' });
    if (head.status === 0 && head.stdout.trim()) revs.push(head.stdout.trim());

    return { revs, refs, excluded };
}

/**
 * sha -> Set(paths) for every object reachable from the selected revisions.
 *
 * `rev-list --objects` prints "<sha> <path>" for blobs and trees and a bare
 * "<sha>" for commits. One blob can sit at several paths across history, hence
 * the set: reporting only the last-seen path sends the operator to the wrong
 * file.
 *
 * The revisions go in on stdin, not argv: a venue clone can carry hundreds of
 * refs and an argv-built command would eventually hit the exec limit, which
 * would surface as a spawn failure rather than as a scan result.
 */
function reachableObjects(repo, revs, { includeReflog = false } = {}) {
    const args = ['rev-list', '--objects', '--stdin'];
    if (includeReflog) args.push('--reflog');
    const out   = git(repo, args, { input: revs.join('\n') + '\n' }).toString('latin1');
    const paths = new Map();
    const order = [];
    for (const line of out.split('\n')) {
        if (!line) continue;
        const sp   = line.indexOf(' ');
        const sha  = sp === -1 ? line : line.slice(0, sp);
        const name = sp === -1 ? null : line.slice(sp + 1);
        if (!paths.has(sha)) { paths.set(sha, new Set()); order.push(sha); }
        if (name) paths.get(sha).add(name);
    }
    return { paths, order };
}

/** Narrow a sha list to the blobs, in one batch-check pass. */
function blobShas(repo, shas) {
    if (shas.length === 0) return [];
    const r = spawnSync('git', ['-C', repo, 'cat-file', '--batch-check'], {
        input: shas.join('\n') + '\n',
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8'
    });
    if (r.error) throw r.error;
    const out = [];
    for (const line of (r.stdout || '').split('\n')) {
        const [sha, type] = line.split(' ');
        if (type === 'blob') out.push(sha);
    }
    return out;
}

/**
 * Stream every blob's bytes through `onBlob(sha, buffer)`.
 *
 * One long-lived `cat-file --batch` rather than a process per object: this repo
 * already carries ~2k blobs and the per-process cost is what makes the naive
 * shell version of this scan take minutes instead of a second.
 *
 * The record framing is "<sha> blob <size>\n" then exactly <size> bytes then
 * "\n", so the parser is length-driven and binary blobs pass through intact.
 */
function streamBlobs(repo, shas, onBlob) {
    return new Promise((resolve, reject) => {
        if (shas.length === 0) return resolve();
        const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let buf     = Buffer.alloc(0);
        let want    = -1;   // bytes of body still expected, -1 while reading a header
        let sha     = null;
        let stderr  = '';

        child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        child.on('error', reject);

        child.stdout.on('data', (chunk) => {
            buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
            for (;;) {
                if (want === -1) {
                    const nl = buf.indexOf(0x0a);
                    if (nl === -1) return;
                    const header = buf.slice(0, nl).toString('utf8');
                    buf = buf.slice(nl + 1);
                    const parts = header.split(' ');
                    if (parts.length < 3) {
                        // "<sha> missing" and friends: nothing to scan, keep going.
                        continue;
                    }
                    sha  = parts[0];
                    want = parseInt(parts[2], 10);
                    if (!Number.isFinite(want)) return reject(new Error(`bad cat-file header: ${header}`));
                }
                // body plus the trailing newline git appends after it
                if (buf.length < want + 1) return;
                onBlob(sha, buf.slice(0, want));
                buf  = buf.slice(want + 1);
                want = -1;
                sha  = null;
            }
        });

        child.on('close', (code) => {
            if (code !== 0) return reject(new Error(`git cat-file --batch exited ${code}: ${stderr.trim()}`));
            resolve();
        });

        child.stdin.on('error', reject);
        child.stdin.end(shas.join('\n') + '\n');
    });
}

/** Commit messages across the selected revisions, as [{sha, message}]. */
function commitMessages(repo, revs) {
    if (revs.length === 0) return [];
    // \x1f between sha and body, \x1e between records: both are illegal in a
    // sha and vanishingly unlikely in a message, unlike a newline.
    const out = git(repo, ['log', '--stdin', '--format=%H%x1f%B%x1e'], {
        input: revs.join('\n') + '\n'
    }).toString('latin1');
    return out
        .split('\x1e')
        .map((rec) => rec.replace(/^\n/, ''))
        .filter((rec) => rec.trim())
        .map((rec) => {
            const i = rec.indexOf('\x1f');
            return { sha: rec.slice(0, i), message: rec.slice(i + 1) };
        });
}

/**
 * Annotated-tag messages, as [{ref, sha, message}].
 * `git log --all` walks commits, so a leak living only in a tag annotation is
 * invisible to commitMessages().
 */
function tagMessages(repo, keep) {
    const out = git(repo, [
        'for-each-ref', '--format=%(objectname) %(objecttype) %(refname)', 'refs/tags'
    ]).toString('utf8');
    const tags = [];
    for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [sha, type, ref] = line.split(' ');
        if (type !== 'tag') continue;      // lightweight tags carry no message
        if (!keep.has(ref)) continue;      // a local rescue tag is not history
        const body = git(repo, ['cat-file', 'tag', sha]).toString('latin1');
        tags.push({ ref, sha, message: body });
    }
    return tags;
}

/**
 * Scan a repository. Resolves to
 *   { repo, counts, selection, blobs: [{sha, paths, matches}], commits, tags }
 * where every `matches` entry is {id, text, index} from leak-patterns.
 *
 * Options: { allRefs } to walk every ref including local scratch (an audit
 * mode, not the gate's mode), { includeReflog } to add the reflogs.
 */
async function scanRepo(repo, opts = {}) {
    const abs = path.resolve(repo);
    git(abs, ['rev-parse', '--git-dir']);   // throws a clear error if not a repo

    const selection = selectRevisions(abs, opts);
    if (selection.revs.length === 0) {
        // Nothing to walk is not "clean". A detector that reports CLEAN having
        // read zero objects is the false negative this whole script exists to
        // remove, so it is an environment error instead.
        const skipped = selection.excluded.map((e) => e.ref).join(', ');
        throw new Error(
            `no published refs and no HEAD to scan in ${abs}` +
            (skipped ? `; only local scratch refs are present (${skipped})` : '')
        );
    }

    const { paths, order } = reachableObjects(abs, selection.revs, opts);
    const blobs            = blobShas(abs, order);

    const blobFindings = [];
    await streamBlobs(abs, blobs, (sha, body) => {
        // latin1 keeps one byte per code unit, so match offsets are byte
        // offsets and no blob can throw on invalid UTF-8.
        const matches = findMatches(body.toString('latin1'));
        if (matches.length) {
            blobFindings.push({ sha, paths: [...(paths.get(sha) || [])].sort(), matches });
        }
    });

    const commitFindings = [];
    for (const c of commitMessages(abs, selection.revs)) {
        const matches = findMatches(c.message);
        if (matches.length) commitFindings.push({ sha: c.sha, matches });
    }

    const keptTags   = new Set(selection.refs);
    const tagFindings = [];
    for (const t of tagMessages(abs, keptTags)) {
        const matches = findMatches(t.message);
        if (matches.length) tagFindings.push({ ref: t.ref, sha: t.sha, matches });
    }

    return {
        repo: abs,
        counts: { objects: order.length, blobs: blobs.length, refs: selection.refs.length },
        selection,
        blobs: blobFindings,
        commits: commitFindings,
        tags: tagFindings
    };
}

/** Total number of leaking sites (not matches) in a scan result. */
function leakCount(result) {
    return result.blobs.length + result.commits.length + result.tags.length;
}

function formatReport(result) {
    const lines = [];
    lines.push(`repo:    ${result.repo}`);
    lines.push(`scanned: ${result.counts.blobs} blobs / ${result.counts.objects} reachable objects`);
    lines.push(`refs:    ${result.counts.refs} published (plus HEAD)`);
    // Named, never silent: a skipped ref is the one thing that could make this
    // report wrong, so the operator gets to see the list and disagree.
    if (result.selection && result.selection.excluded.length) {
        lines.push(`skipped: ${result.selection.excluded.length} local scratch ref(s), not this repo's history:`);
        for (const e of result.selection.excluded) lines.push(`  ${e.ref}  [${e.rule}]`);
    }
    lines.push('');

    const uniq = (m) => [...new Set(m.map((x) => x.text))].sort();

    if (result.blobs.length) {
        lines.push(`BLOBS WITH LEAKED PATHS (${result.blobs.length}):`);
        for (const b of result.blobs) {
            lines.push(`  ${b.sha}`);
            lines.push(`    paths:   ${b.paths.join(', ') || '(unreferenced)'}`);
            lines.push(`    matches: ${uniq(b.matches).join(', ')}`);
        }
        lines.push('');
    }
    if (result.commits.length) {
        lines.push(`COMMIT MESSAGES WITH LEAKED PATHS (${result.commits.length}):`);
        for (const c of result.commits) {
            lines.push(`  ${c.sha}  ${uniq(c.matches).join(', ')}`);
        }
        lines.push('');
    }
    if (result.tags.length) {
        lines.push(`TAG MESSAGES WITH LEAKED PATHS (${result.tags.length}):`);
        for (const t of result.tags) {
            lines.push(`  ${t.ref}  ${uniq(t.matches).join(', ')}`);
        }
        lines.push('');
    }

    const n = leakCount(result);
    lines.push(n === 0 ? 'CLEAN: no developer-machine paths in history.' : `LEAKS: ${n} site(s).`);
    return lines.join('\n');
}

module.exports = { scanRepo, leakCount, formatReport, selectRevisions, SCRATCH_REF_RULES };

if (require.main === module) {
    (async () => {
        const FLAGS   = ['--reflog', '--json', '--all-refs'];
        const args    = process.argv.slice(2).filter((a) => !FLAGS.includes(a));
        const repo    = args[0] || process.cwd();
        const reflog  = process.argv.includes('--reflog');
        const asJson  = process.argv.includes('--json');
        const allRefs = process.argv.includes('--all-refs');
        const result  = await scanRepo(repo, { includeReflog: reflog, allRefs });
        process.stdout.write(asJson ? JSON.stringify(result, null, 2) + '\n' : formatReport(result) + '\n');
        process.exit(leakCount(result) === 0 ? 0 : 1);
    })().catch((err) => {
        process.stderr.write(`scan-history: ${err.message}\n`);
        process.exit(2);
    });
}
