'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const checker = require('../../../scripts/check-mirror-pendings')
const checkerPath = path.resolve(__dirname, '../../../scripts/check-mirror-pendings.js')

function fixture (files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-pendings-'))
    for (const [relative, source] of Object.entries(files || {})) {
        const absolute = path.join(root, relative)
        fs.mkdirSync(path.dirname(absolute), { recursive: true })
        fs.writeFileSync(absolute, source)
    }
    return root
}

function run (input) {
    return spawnSync(process.execPath, [checkerPath, input], { encoding: 'utf8' })
}

describe('check-mirror-pendings', function () {
    it('reports and accepts an it.skip with a stated reason', function () {
        const root = fixture({
            'at1-example.test.js': "describe('AT1', () => { it.skip('covers the slow edge (needs 257 rounds)', () => {}) })",
        })
        const result = run(root)
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /PENDING .*at1-example\.test\.js:1/)
        assert.match(result.stdout, /reason: needs 257 rounds/)
    })

    it('refuses and names an it.skip with no reason', function () {
        const root = fixture({
            'at1-example.test.js': "describe('AT1', () => { it.skip('quietly absent claim', () => {}) })",
        })
        const result = run(root)
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /unreasoned pending: .*quietly absent claim/)
    })

    it('finds a this.skip in a lifecycle hook', function () {
        const source = [
            "describe('seeder runs only when the roster is absent', function () {",
            '  before(function () {',
            '    this.skip()',
            '  })',
            "  it('seeds the roster', () => {})",
            '})',
        ].join('\n')
        const parsed = checker.parseSource(source, 'at4.test.js')
        assert.strictEqual(parsed.pending.length, 1)
        assert.strictEqual(parsed.pending[0].line, 3)
        assert.match(parsed.pending[0].title, /before hook/)
    })

    it('resolves a named leg whose active case title covers the deferred claim', function () {
        const root = fixture({
            'at2.test.js': "describe('AT2', () => { it.skip('holds delivery past the forward margin (DRIVEN in at2b)', () => {}) })",
            'at2b-forward-margin.test.js': "describe('delivery past the forward margin', () => { it('holds the barrier', () => {}) })",
        })
        const result = run(root)
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /cross-references 1/)
    })

    it('refuses a pending that names a leg which does not exist', function () {
        const root = fixture({
            'at2.test.js': "describe('AT2', () => { it.skip('holds delivery past the margin (DRIVEN in at9b)', () => {}) })",
        })
        const result = run(root)
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /unresolved cross-reference at9b.*leg file does not exist/)
    })

    it('refuses a named leg whose active cases do not cover the claim', function () {
        const root = fixture({
            'at2.test.js': "describe('AT2', () => { it.skip('holds delivery past the margin (DRIVEN in at2b)', () => {}) })",
            'at2b-other.test.js': "describe('AT2b', () => { it('checks an unrelated property', () => {}) })",
        })
        const result = run(root)
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /at2b.*no matching active case title/)
    })

    it('refuses an empty directory as zero files read', function () {
        const result = run(fixture())
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /read zero files from input/)
    })

    it('distinguishes a missing input path from an empty directory', function () {
        const root = fixture()
        const result = run(path.join(root, 'does-not-exist'))
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /input path does not exist/)
        assert.match(result.stderr, /read zero files from input/)
    })

    it('refuses a file with no pending tests after reporting one file read', function () {
        const root = fixture({ 'clean.test.js': "describe('clean', () => { it('runs', () => {}) })" })
        const result = run(path.join(root, 'clean.test.js'))
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /read 1 file\(s\) but found zero pending tests/)
    })

    it('prints file, line, title and reason on every census line', function () {
        const root = fixture({
            'at5.test.js': [
                "describe('AT5', function () {",
                "  it.skip('dead-letters the window (needs 257 rounds)', function () {})",
                '})',
            ].join('\n'),
        })
        const result = run(root)
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /PENDING .*at5\.test\.js:2 \| title: AT5 > dead-letters the window \(needs 257 rounds\) \| reason: needs 257 rounds/)
    })

    it('uses a directly attached comment as the stated reason', function () {
        const root = fixture({
            'at6.test.js': [
                "describe('AT6', function () {",
                '  // Regtest is armed at height zero, so no below-height request can exist.',
                "  it.skip('serves a below-height request', function () {})",
                '})',
            ].join('\n'),
        })
        const result = run(root)
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /reason: Regtest is armed at height zero/)
    })

    it('does not count the standard unavailable-venue hook as a pending claim', function () {
        const source = [
            "describe('venue leg', function () {",
            '  before(function () {',
            '    if (!up) {',
            "      console.log('SKIPPED: ' + venue.unavailable)",
            '      this.skip()',
            '    }',
            '  })',
            '})',
        ].join('\n')
        assert.deepStrictEqual(checker.parseSource(source, 'at0.test.js').pending, [])
    })
})
