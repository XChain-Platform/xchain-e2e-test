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
            'at2.test.js': "describe('AT2', () => { it.skip('holds delivery past the forward margin (DRIVEN in at2b: \"holds the barrier\")', () => {}) })",
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

const LEG_SUITE = "describe('delivery past the forward margin', () => { it('holds the barrier', () => {}) })"

function crossrefRun (pendingTitle, legSource) {
    return run(fixture({
        'at2.test.js': "describe('AT2', () => { it.skip(" + JSON.stringify(pendingTitle) + ', () => {}) })',
        'at2b-forward-margin.test.js': legSource,
    }))
}

describe('check-mirror-pendings: a cross-reference names its target case', function () {
    it('refuses a bare reference even when the leg shares every claim word', function () {
        const result = crossrefRun('holds delivery past the forward margin (DRIVEN in at2b)', LEG_SUITE)
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /at2b.*quotes no target case/)
    })

    it('refuses an anchor that only shares words with the active case', function () {
        const result = crossrefRun('holds delivery (DRIVEN in at2b: "holds the barrier when delayed")', LEG_SUITE)
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /no active case titled "holds the barrier when delayed"/)
    })

    it('refuses an anchor that matches only the suite title', function () {
        const result = crossrefRun('holds delivery (DRIVEN in at2b: "delivery past the forward margin")', LEG_SUITE)
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /no active case titled/)
    })

    it('refuses an anchor whose case is skipped or sits under a skipped suite', function () {
        const pending = 'holds delivery (DRIVEN in at2b: "holds the barrier")'
        const skippedCase = crossrefRun(pending, "describe('m', () => { it.skip('holds the barrier (needs a lever)', () => {}); it.skip('holds the barrier', () => {}) })")
        assert.strictEqual(skippedCase.status, 1)
        assert.match(skippedCase.stderr, /no active case titled "holds the barrier"/)
        const skippedSuite = crossrefRun(pending, "describe.skip('m (needs a lever)', () => { it('holds the barrier', () => {}) })")
        assert.strictEqual(skippedSuite.status, 1)
        assert.match(skippedSuite.stderr, /no active case titled "holds the barrier"/)
    })

    it('reads the anchor from the attached comment, normalizing case and spacing', function () {
        const root = fixture({
            'at2.test.js': [
                "describe('AT2', () => {",
                '  // DRIVEN in at2b: "Holds  the BARRIER"',
                "  it.skip('holds delivery past the margin (DRIVEN in at2b, see comment)', () => {})",
                '})',
            ].join('\n'),
            'at2b-forward-margin.test.js': LEG_SUITE,
        })
        const result = run(root)
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /cross-references 1/)
    })
})

describe('check-mirror-pendings: every skip form is reported', function () {
    it('reports a skipped suite with a reason and refuses one without', function () {
        const reasoned = run(fixture({ 'at3.test.js': "describe.skip('AT3 deadline (needs 257 rounds)', () => { it('a', () => {}); it('b', () => {}) })" }))
        assert.strictEqual(reasoned.status, 0, reasoned.stderr)
        assert.match(reasoned.stdout, /AT3 deadline \(needs 257 rounds\) \[skipped suite, 2 cases\]/)
        const bare = run(fixture({ 'at3.test.js': "context.skip('AT3 deadline', () => { it('a', () => {}) })" }))
        assert.strictEqual(bare.status, 1)
        assert.match(bare.stderr, /unreasoned pending: .*AT3 deadline/)
    })

    it('reports the xit, xdescribe and xcontext aliases', function () {
        const source = [
            "describe('AT7', () => {",
            "  xit('aliased case', () => {})",
            "  xdescribe('aliased suite', () => { it('inner', () => {}) })",
            "  xcontext('aliased context', () => { it('inner', () => {}) })",
            '})',
        ].join('\n')
        const titles = checker.parseSource(source, 'at7.test.js').pending.map((p) => p.claim)
        assert.deepStrictEqual(titles, ['aliased case', 'aliased suite', 'aliased context'])
    })

    it('reports a this.skip in a test body, reasoned by its attached comment', function () {
        const source = (comment) => [
            "describe('AT8', function () {",
            "  it('settles an llm request', function () {",
            '    if (!llm.ok) {',
            comment,
            '      this.skip()',
            '    }',
            '  })',
            '})',
        ].join('\n')
        const reasoned = checker.parseSource(source('      // Skipped, not passed: no model is reachable here.'), 'at8.test.js').pending
        assert.strictEqual(reasoned.length, 1)
        assert.strictEqual(reasoned[0].kind, 'body')
        assert.match(reasoned[0].reason, /no model is reachable/)
        const bare = checker.parseSource(source('      console.log(why)'), 'at8.test.js').pending
        assert.strictEqual(bare.length, 1)
        assert.strictEqual(bare[0].reason, '')
    })

    it('does not mistake a regex .test( member call for a mocha test', function () {
        const source = [
            "describe('AT9', function () {",
            '  const ok = pattern.test(value)',
            "  it('runs only when ready', function () {",
            '    // Skipped, not passed: the venue is not ready yet.',
            '    this.skip()',
            '  })',
            '})',
        ].join('\n')
        const pending = checker.parseSource(source, 'at9.test.js').pending
        assert.strictEqual(pending.length, 1)
        assert.strictEqual(pending[0].claim, 'runs only when ready')
    })
})
