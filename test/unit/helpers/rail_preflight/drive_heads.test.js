'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    HEAD_NAMES, driveRoots, gitHead, captureDriveHeads, isLedgerPath, changedPaths, rootDiff, judgeDriveHeads
} = require('../../../helpers/rail_preflight/drive_heads');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

describe('rail_preflight drive_heads', function(){
    it('derives the indexer root under the platform root', function(){
        const roots = driveRoots('/w/e2e', '/w');
        assert.deepStrictEqual(roots, { platform: '/w', e2e: '/w/e2e', indexer: path.join('/w', 'xchain-indexer') });
    });

    it('reads each head exactly once', function(){
        const calls = [];
        const heads = captureDriveHeads({ platform: 'p', e2e: 'e', indexer: 'i' },
            dir => { calls.push(dir); return dir === 'p' ? A : dir === 'e' ? B : null; });
        assert.deepStrictEqual(calls, ['p', 'e', 'i']);
        assert.deepStrictEqual(heads, { platform: A, e2e: B, indexer: null });
    });

    it('gitHead returns a 40 hex head and null otherwise', function(){
        assert.strictEqual(gitHead('x', () => ({ status: 0, stdout: A + '\n' })), A);
        assert.strictEqual(gitHead('x', () => ({ status: 128, stdout: '' })), null);
        assert.strictEqual(gitHead('x', () => ({ status: 0, stdout: 'garbage' })), null);
        assert.strictEqual(gitHead('x', () => null), null);
    });

    it('passes when no head moved', function(){
        const pinned = { platform: A, e2e: B, indexer: C };
        const res = judgeDriveHeads(pinned, Object.assign({}, pinned));
        assert.deepStrictEqual(res, { ok: true, moved: [], missing: [], problems: [], ledgerOnly: [] });
    });

    it('fails naming both commits when a live head moved', function(){
        const res = judgeDriveHeads({ platform: A, e2e: B, indexer: C }, { platform: A, e2e: D, indexer: C });
        assert.strictEqual(res.ok, false);
        assert.deepStrictEqual(res.moved, [{ name: 'e2e', pinned: B, live: D }]);
        assert.ok(res.problems[0].includes(B) && res.problems[0].includes(D));
        assert.ok(res.problems[0].includes('e2e'));
    });

    it('counts a pinned tree that no longer reads as moved', function(){
        const res = judgeDriveHeads({ platform: A, e2e: B, indexer: C }, { platform: A, e2e: B, indexer: null });
        assert.strictEqual(res.ok, false);
        assert.deepStrictEqual(res.moved, [{ name: 'indexer', pinned: C, live: null }]);
        assert.ok(res.problems[0].includes('unreadable'));
    });

    it('fails when a tree was never pinned', function(){
        const res = judgeDriveHeads({ platform: null, e2e: B, indexer: C }, { platform: D, e2e: B, indexer: C });
        assert.strictEqual(res.ok, false);
        assert.deepStrictEqual(res.missing, ['platform']);
        assert.ok(/platform head was never captured/.test(res.problems.join('\n')));
    });

    it('fails when nothing was pinned at all', function(){
        for(const pinned of [null, undefined, {}]){
            const res = judgeDriveHeads(pinned, { platform: A, e2e: B, indexer: C });
            assert.strictEqual(res.ok, false);
            assert.deepStrictEqual(res.missing, ['platform', 'e2e', 'indexer']);
        }
    });

    it('reports every moved tree', function(){
        const res = judgeDriveHeads({ platform: A, e2e: B, indexer: C }, { platform: D, e2e: D, indexer: D });
        assert.deepStrictEqual(res.moved.map(m => m.name), HEAD_NAMES);
    });
    describe('ledger-only platform moves', function(){
        // Platform paths are built from parts so the test text names no internal path.
        const P = rest => ['claude', rest].join('/');
        const pinned = { platform: A, e2e: B, indexer: C };
        const live = { platform: D, e2e: B, indexer: C };

        it('classifies the platform record paths', function(){
            for(const p of [P('LEDGER.md'), P('BOARD-2.md'), P('specs/a.md'), P('specs/x/y.md'),
                P('reports/r.md'), 'tmp/run/o.txt']) assert.strictEqual(isLedgerPath(p), true, p);
            for(const p of [P('scripts/a.js'), P('bin/x.js'), P('notes.md'), P('deploy/k.json'),
                'xchain-hub/src/a.js', P('specs'), 'src/' + P('specs/a.md'), '', null])
                assert.strictEqual(isLedgerPath(p), false, String(p));
        });

        it('accepts a platform move touching only record paths', function(){
            const res = judgeDriveHeads(pinned, live, () => [P('LEDGER.md'), P('specs/a.md'), 'tmp/o.txt']);
            assert.strictEqual(res.ok, true);
            assert.deepStrictEqual(res.moved, []);
            assert.deepStrictEqual(res.ledgerOnly, [{ name: 'platform', pinned: A, live: D, files: 3 }]);
        });

        it('still fails when any changed path is code', function(){
            const res = judgeDriveHeads(pinned, live, () => [P('specs/a.md'), P('scripts/run.sh')]);
            assert.strictEqual(res.ok, false);
            assert.deepStrictEqual(res.moved.map(m => m.name), ['platform']);
        });

        it('fails when the diff is empty, unreadable or not supplied', function(){
            assert.strictEqual(judgeDriveHeads(pinned, live, () => []).ok, false);
            assert.strictEqual(judgeDriveHeads(pinned, live, () => null).ok, false);
            assert.strictEqual(judgeDriveHeads(pinned, live).ok, false);
            assert.strictEqual(judgeDriveHeads(pinned, { platform: null, e2e: B, indexer: C }, () => ['tmp/a']).ok, false);
        });

        it('never excuses an e2e or indexer move', function(){
            const res = judgeDriveHeads(pinned, { platform: A, e2e: D, indexer: D }, () => ['tmp/a']);
            assert.deepStrictEqual(res.moved.map(m => m.name), ['e2e', 'indexer']);
        });

        it('changedPaths lists git diff output and null on failure', function(){
            assert.deepStrictEqual(changedPaths('x', A, D, () => ({ status: 0, stdout: 'a\nb\n' })), ['a', 'b']);
            assert.strictEqual(changedPaths('x', A, D, () => ({ status: 1, stdout: '' })), null);
            assert.strictEqual(rootDiff({ e2e: 'e' })('platform', A, D), null);
        });

        it('judges a real repository through rootDiff', function(){
            this.timeout(60000);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-heads-'));
            const git = (...args) => {
                const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t',
                    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
                assert.strictEqual(r.status, 0, r.stderr);
                return r.stdout.trim();
            };
            const commit = (file, msg) => {
                fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
                fs.writeFileSync(path.join(dir, file), msg + '\n');
                git('add', file);
                git('commit', '-q', '-m', msg);
                return git('rev-parse', 'HEAD');
            };
            try {
                git('init', '-q');
                const base = commit(P('scripts/run.sh'), 'base');
                const record = commit(P('specs/board.md'), 'record');
                const code = commit(P('scripts/run.sh'), 'code');
                const roots = { platform: dir, e2e: 'e', indexer: 'i' };
                const at = p => ({ platform: p, e2e: B, indexer: C });
                assert.strictEqual(judgeDriveHeads(at(base), at(record), rootDiff(roots)).ok, true);
                assert.strictEqual(judgeDriveHeads(at(base), at(code), rootDiff(roots)).ok, false);
                assert.strictEqual(judgeDriveHeads(at(record), at(code), rootDiff(roots)).ok, false);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });
});
