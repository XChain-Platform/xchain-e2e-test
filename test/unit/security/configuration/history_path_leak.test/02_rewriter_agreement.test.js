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
const { spawnSync } = require('child_process');

const { SCRUB_DIR, REPO_ROOT } = require('./helpers/history_leak_shared');
const patterns = require(path.join(SCRUB_DIR, 'leak-patterns'));

// A leak shape one of the detector and the rewriter knows and the other does
// not is how a scrub verifies itself green while leaking.

function registerSpecCases() {
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
}

function registerPurgeSpecCase() {
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
}

/**
 * The script's lines that can execute. Comments and heredoc bodies are
 * stripped, not just comments: the script deliberately PRINTS the force-push
 * command for the operator to read, and that line lives in a heredoc.
 */
function executableLines(body) {
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
    return executable;
}

function registerNoPushCase() {
    it('never contains a push', function () {
        // The script's whole safety property. A `git push` reaching it by a
        // later edit would turn a rehearsal into an irreversible act.
        const body = fs.readFileSync(path.join(SCRUB_DIR, 'rewrite-history.sh'), 'utf8');
        const executable = executableLines(body);

        assert.ok(executable.length > 20, 'heredoc stripping ate the whole script');
        assert.ok(!/\bgit\s+(-C\s+\S+\s+)?push\b/.test(executable.join('\n')),
            'rewrite-history.sh contains an executable git push');
    });
}

describe('Security: no developer-machine paths in git history: rewriter agreement @regression @tier4', function () {
    this.timeout(180000);

    describe('rewriter and detector agree', function () {
        registerSpecCases();
        registerPurgeSpecCase();
        registerNoPushCase();
    });
});
