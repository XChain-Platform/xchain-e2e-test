'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { digestTokenLog } = require('../../../helpers/rail_preflight/token_log_digest');

const SCRIPT = path.resolve(__dirname, '../../../helpers/rail_preflight/token_log_digest.js');

describe('digestTokenLog', function () {
    it('reports all finalized transfers and only those after the last spawn', function () {
        const text = [
            '=== 2026-09-27T10:00:00.000Z spawn destination pid 101 ===',
            'CrossChainBridge: finalized transfer 0123456789abcdef... BTC:41 -> XCP 12.500 ALPHA (3 sigs)',
            '=== 2026-09-27T10:01:00.000Z spawn destination pid 102 ===',
            'CrossChainBridge: finalized transfer fedcba9876543210... XCP:42 -> BTC 7 BETA (2 sigs)'
        ].join('\n');
        const first = { src: 'BTC', index: 41, dest: 'XCP', amount: '12.500', tick: 'ALPHA', sigs: 3 };
        const second = { src: 'XCP', index: 42, dest: 'BTC', amount: '7', tick: 'BETA', sigs: 2 };

        const digest = digestTokenLog(text);

        assert.strictEqual(digest.spawns, 2);
        assert.deepStrictEqual(digest.finalized, [first, second]);
        assert.deepStrictEqual(digest.finalizedSinceLastSpawn, [second]);
    });

    it('treats the start of a log without a spawn line as the current run', function () {
        const text = '\x1b[32mCrossChainBridge: finalized transfer aabbccddeeff0011... BTC:9 -> XCP 0.25 COLOR (4 sigs)\x1b[0m';
        const transfer = { src: 'BTC', index: 9, dest: 'XCP', amount: '0.25', tick: 'COLOR', sigs: 4 };

        const digest = digestTokenLog(text);

        assert.strictEqual(digest.spawns, 0);
        assert.deepStrictEqual(digest.finalized, [transfer]);
        assert.deepStrictEqual(digest.finalizedSinceLastSpawn, [transfer]);
    });
});

describe('digestTokenLog failures and filters', function () {
    it('counts each failure form and groups held reasons by source leg', function () {
        const text = [
            'CrossChainBridge: finalized transfer write FAILED (fail-closed; deferring 0123): disk unavailable',
            'CrossChainBridge: write finalized transfer error: callback rejected',
            'CrossChainBridge: transfer round failed for BTC:17: peer timeout',
            'CrossChainBridge: not proposing BTC:17 (below depth 6)',
            'CrossChainBridge: not proposing BTC:17 (source leg guarded by an open round)',
            'CrossChainBridge: retraction submit error: quorum unavailable'
        ].join('\n');

        const digest = digestTokenLog(text);

        assert.strictEqual(digest.writeFailed, 2);
        assert.deepStrictEqual(digest.roundFailed, { 'BTC:17': 1 });
        assert.deepStrictEqual(digest.held, {
            'BTC:17': {
                'below depth 6': 1,
                'source leg guarded by an open round': 1
            }
        });
        assert.strictEqual(digest.retractionErrors, 1);
    });

    it('filters both finalized lists to the requested tick', function () {
        const text = [
            'CrossChainBridge: finalized transfer 1111111111111111... BTC:1 -> XCP 1 KEEP (1 sigs)',
            'CrossChainBridge: finalized transfer 2222222222222222... BTC:2 -> XCP 2 DROP (2 sigs)'
        ].join('\n');

        const digest = digestTokenLog(text, { tick: 'KEEP' });

        assert.deepStrictEqual(digest.finalized.map(item => item.tick), ['KEEP']);
        assert.deepStrictEqual(digest.finalizedSinceLastSpawn.map(item => item.tick), ['KEEP']);
    });
});

describe('token log digest CLI', function () {
    let directory;

    beforeEach(function () {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-log-digest-'));
    });

    afterEach(function () {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('prints safe summaries for direct log files in name order', function () {
        const fullId = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        const secret = 'pass' + 'word=not-a-real-secret';
        fs.writeFileSync(path.join(directory, 'b.log'), [
            '=== 2026-09-27T10:00:00.000Z spawn source pid 202 ===',
            'CrossChainBridge: finalized transfer fedcba9876543210... XCP:2 -> BTC 8 DROP (2 sigs)'
        ].join('\n'));
        fs.writeFileSync(path.join(directory, 'a.log'), [
            'CrossChainBridge: finalized transfer 0123456789abcdef... BTC:1 -> XCP 5 KEEP (3 sigs)',
            'CrossChainBridge: transfer round failed for BTC:1: ' + secret + ' transfer=' + fullId
        ].join('\n'));
        fs.mkdirSync(path.join(directory, 'ignored.log'));

        const child = spawnSync(process.execPath, [SCRIPT, directory, '--tick', 'KEEP'], { encoding: 'utf8' });

        assert.strictEqual(child.status, 0, child.stderr);
        assert.strictEqual(child.stderr, '');
        assert.deepStrictEqual(child.stdout.trim().split('\n'), [
            'LOG a.log spawns=0 finalized=BTC:1/XCP:KEEP since_spawn=BTC:1/XCP:KEEP write_failed=0 round_failed=1 held=none retraction_errors=0 adopted=0 stale_rounds=0',
            'LOG b.log spawns=1 finalized=none since_spawn=none write_failed=0 round_failed=0 held=none retraction_errors=0 adopted=0 stale_rounds=0'
        ]);
        assert.ok(!child.stdout.includes(secret));
        assert.ok(!child.stdout.includes(fullId));
        assert.ok(!child.stderr.includes(secret));
        assert.ok(!child.stderr.includes(fullId));
    });

    it('reports an abandoned stale round after adopted leader lines', function () {
        const round = '0123456789abcdef';
        const text = [
            'CrossChainDexConsensus: adopted leader canonical for ' + round + '... from peer-a',
            'CrossChainDexConsensus: adopted leader canonical for ' + round + '... from peer-b',
            'CrossChainDexConsensus: abandoned stale round ' + round + '... after 480s unfinalized; engine will re-propose',
            '\x1b[33mCrossChainDexConsensus: abandoned stale round ' + round +
                '... after 481s unfinalized; engine will re-propose\x1b[0m'
        ].join('\n');
        fs.writeFileSync(path.join(directory, 'round.log'), text);

        const digest = digestTokenLog(text);
        const child = spawnSync(process.execPath, [SCRIPT, directory], { encoding: 'utf8' });

        assert.deepStrictEqual(digest.adopted, { [round]: 2 });
        assert.deepStrictEqual(digest.staleRounds, { [round]: { count: 2, maxAgeS: 481 } });
        assert.strictEqual(child.status, 0, child.stderr);
        assert.ok(child.stdout.trim().endsWith('adopted=2 stale_rounds=2'));
    });

    it('exits 2 for a missing directory and an unknown flag', function () {
        const missing = spawnSync(process.execPath, [SCRIPT, path.join(directory, 'missing')], { encoding: 'utf8' });
        const unknown = spawnSync(process.execPath, [SCRIPT, directory, '--unknown'], { encoding: 'utf8' });

        assert.strictEqual(missing.status, 2);
        assert.strictEqual(unknown.status, 2);
    });
});
