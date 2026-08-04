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
// So this walks OBJECTS, not the tree, and it walks them across ALL refs:
//   - every blob reachable from any branch, remote-tracking ref or tag
//   - every commit message
//   - every annotated-tag message
//
// Exit code is the point: 0 clean, 1 leaks found, 2 usage/environment error.
// That makes it usable as the verification half of rewrite-history.sh and as
// the assertion behind history-path-leak.test.js.

const { spawn, spawnSync } = require('child_process');
const path                 = require('path');
const { findMatches }      = require('./leak-patterns');

/** Run git and return stdout, or throw with git's stderr attached. */
function git(repo, args, { maxBuffer = 512 * 1024 * 1024 } = {}) {
    const r = spawnSync('git', ['-C', repo, ...args], { maxBuffer, encoding: 'buffer' });
    if (r.error) throw r.error;
    if (r.status !== 0) {
        const msg = (r.stderr || Buffer.alloc(0)).toString('utf8').trim();
        throw new Error(`git ${args.join(' ')} failed (${r.status}): ${msg}`);
    }
    return r.stdout;
}

/**
 * sha -> Set(paths) for every object reachable from any ref.
 *
 * `rev-list --objects --all` prints "<sha> <path>" for blobs and trees and a
 * bare "<sha>" for commits. One blob can sit at several paths across history,
 * hence the set: reporting only the last-seen path sends the operator to the
 * wrong file.
 */
function reachableObjects(repo, { includeReflog = false } = {}) {
    const args = ['rev-list', '--objects', '--all'];
    if (includeReflog) args.push('--reflog');
    const out   = git(repo, args).toString('latin1');
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

/** Commit messages across all refs, as [{sha, message}]. */
function commitMessages(repo) {
    // \x1f between sha and body, \x1e between records: both are illegal in a
    // sha and vanishingly unlikely in a message, unlike a newline.
    const out = git(repo, ['log', '--all', '--format=%H%x1f%B%x1e']).toString('latin1');
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
function tagMessages(repo) {
    const out = git(repo, [
        'for-each-ref', '--format=%(objectname) %(objecttype) %(refname)', 'refs/tags'
    ]).toString('utf8');
    const tags = [];
    for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const [sha, type, ref] = line.split(' ');
        if (type !== 'tag') continue;      // lightweight tags carry no message
        const body = git(repo, ['cat-file', 'tag', sha]).toString('latin1');
        tags.push({ ref, sha, message: body });
    }
    return tags;
}

/**
 * Scan a repository. Resolves to
 *   { repo, counts, blobs: [{sha, paths, matches}], commits: [...], tags: [...] }
 * where every `matches` entry is {id, text, index} from leak-patterns.
 */
async function scanRepo(repo, opts = {}) {
    const abs = path.resolve(repo);
    git(abs, ['rev-parse', '--git-dir']);   // throws a clear error if not a repo

    const { paths, order } = reachableObjects(abs, opts);
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
    for (const c of commitMessages(abs)) {
        const matches = findMatches(c.message);
        if (matches.length) commitFindings.push({ sha: c.sha, matches });
    }

    const tagFindings = [];
    for (const t of tagMessages(abs)) {
        const matches = findMatches(t.message);
        if (matches.length) tagFindings.push({ ref: t.ref, sha: t.sha, matches });
    }

    return {
        repo: abs,
        counts: { objects: order.length, blobs: blobs.length },
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

module.exports = { scanRepo, leakCount, formatReport };

if (require.main === module) {
    (async () => {
        const args    = process.argv.slice(2).filter((a) => a !== '--reflog' && a !== '--json');
        const repo    = args[0] || process.cwd();
        const reflog  = process.argv.includes('--reflog');
        const asJson  = process.argv.includes('--json');
        const result  = await scanRepo(repo, { includeReflog: reflog });
        process.stdout.write(asJson ? JSON.stringify(result, null, 2) + '\n' : formatReport(result) + '\n');
        process.exit(leakCount(result) === 0 ? 0 : 1);
    })().catch((err) => {
        process.stderr.write(`scan-history: ${err.message}\n`);
        process.exit(2);
    });
}
