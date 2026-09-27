'use strict'

const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { digestPolicyLog } = require('../../../scripts/rail_policy_log_digest')
const script = path.join(__dirname, '..', '..', '..', 'scripts', 'rail_policy_log_digest.js')

describe('rail policy log digest', function () {
    it('tracks finalizations after the latest follower spawn', function () {
        const digest = digestPolicyLog([
            '=== 2026-09-27T01:00:00.000Z spawn follower pid 10 ===',
            'CrossChainBridge: finalized policy snapshot abc for ETH:USDC seq 1 (2 sigs)',
            '=== 2026-09-27T01:01:00.000Z spawn follower pid 11 ===',
            'CrossChainBridge: finalized policy snapshot def for ETH:USDC seq 2 (3 sigs)',
        ].join('\n'))

        assert.strictEqual(digest.spawns, 2)
        assert.deepStrictEqual(digest.finalized.map((entry) => entry.seq), [1, 2])
        assert.deepStrictEqual(digest.finalizedSinceLastSpawn.map((entry) => entry.seq), [2])
    })

    it('does not invent a spawn boundary', function () {
        const digest = digestPolicyLog('CrossChainBridge: finalized policy snapshot abc for ETH:USDC seq 1 (2 sigs)')
        assert.strictEqual(digest.spawns, 0)
        assert.deepStrictEqual(digest.finalizedSinceLastSpawn, [])
    })

    it('counts each failure form by pair without retaining messages', function () {
        const secret = 'pass' + 'word=not-a-real-secret'
        const digest = digestPolicyLog([
            'CrossChainBridge: policy round failed for ETH:USDC: ' + secret,
            'CrossChainBridge: finalized policy snapshot write FAILED',
            'CrossChainBridge: declining to sign a policy snapshot for ETH:USDC',
            'CrossChainBridge: gettokenpolicy for SOL:USDT returned a policy_hash that does not match',
        ].join('\n'))
        assert.deepStrictEqual(digest.roundFailed, { 'ETH:USDC': 1 })
        assert.strictEqual(digest.writeFailed, 1)
        assert.deepStrictEqual(digest.declined, { 'ETH:USDC': 1 })
        assert.deepStrictEqual(digest.hashMismatch, { 'SOL:USDT': 1 })
    })

    it('parses ANSI-coloured lines and filters pair-bearing results by tick', function () {
        const text = [
            '\u001b[32mCrossChainBridge: finalized policy snapshot abc for ETH:USDC seq 4 (2 sigs)\u001b[0m',
            'CrossChainBridge: policy round failed for ETH:DAI: ignored',
            'CrossChainBridge: declining to sign a policy snapshot for ETH:USDC',
        ].join('\n')
        const digest = digestPolicyLog(text, { tick: 'USDC' })
        assert.deepStrictEqual(digest.finalized, [{ origin: 'ETH', tick: 'USDC', seq: 4, sigs: 2 }])
        assert.deepStrictEqual(digest.roundFailed, {})
        assert.deepStrictEqual(digest.declined, { 'ETH:USDC': 1 })
    })
})

describe('rail policy log digest CLI', function () {
    let directory
    beforeEach(function () { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-digest-')) })
    afterEach(function () { fs.rmSync(directory, { recursive: true, force: true }) })

    it('prints one sanitized summary per log in name order', function () {
        const secret = 'pass' + 'word=not-a-real-secret'
        fs.writeFileSync(path.join(directory, 'b.log'), 'CrossChainBridge: policy round failed for ETH:USDC: ' + secret)
        fs.writeFileSync(path.join(directory, 'a.log'), 'plain text')
        fs.writeFileSync(path.join(directory, 'ignored.txt'), 'ignored')
        const result = childProcess.spawnSync(process.execPath, [script, directory], { encoding: 'utf8' })
        assert.strictEqual(result.status, 0)
        assert.deepStrictEqual(result.stdout.trim().split('\n').map((line) => line.split(' ')[1]), ['a.log', 'b.log'])
        assert.match(result.stdout, /LOG b\.log .*round_failed=1/)
        assert.ok(!(result.stdout + result.stderr).includes(secret))
    })

    it('exits two for a missing directory', function () {
        const missing = path.join(directory, 'missing')
        const result = childProcess.spawnSync(process.execPath, [script, missing], { encoding: 'utf8' })
        assert.strictEqual(result.status, 2)
    })
})
