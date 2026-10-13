'use strict';

const assert = require('assert');
const path = require('path');
const {
    HEAD_NAMES, driveRoots, gitHead, captureDriveHeads, judgeDriveHeads
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
        assert.deepStrictEqual(res, { ok: true, moved: [], problems: [] });
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

    it('does not judge a tree that was never pinned', function(){
        const res = judgeDriveHeads({ platform: null, e2e: B, indexer: C }, { platform: D, e2e: B, indexer: C });
        assert.strictEqual(res.ok, true);
    });

    it('reports every moved tree', function(){
        const res = judgeDriveHeads({ platform: A, e2e: B, indexer: C }, { platform: D, e2e: D, indexer: D });
        assert.deepStrictEqual(res.moved.map(m => m.name), HEAD_NAMES);
    });
});
