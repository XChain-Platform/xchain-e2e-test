// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const guard = require('../../../bin/check-move-only-split')

const CLI = path.join(__dirname, '../../../bin/check-move-only-split.js')
const GIT_IDENTITY = [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=move-only-test',
    '-c', 'commit.gpgSign=false',
]
let root
let base

const BASELINE = [
    "'use strict'",
    "const helper = require('./helper')",
    '',
    "describe('alpha suite', () => {",
    "    it('keeps literals', () => {",
    "        const url = 'prefix // literal /*literal*/ suffix'",
    '        const message = `first line',
    '  // literal spacing',
    'last line`',
    '        return helper({ value: url, message })',
    '    })',
    '})',
    '',
    "describe('beta suite', () => {",
    "    it('keeps arithmetic', () => {",
    '        return 1 + 2',
    '    })',
    '})',
    '',
].join('\n')

const ALPHA = [
    "'use strict'",
    "const helper = require('./helper')",
    '',
    "describe('alpha suite', () => {",
    "  it('keeps literals', () => {",
    "    const url = 'prefix // literal /*literal*/ suffix'",
    '    const message = `first line',
    '  // literal spacing',
    'last line`',
    '    return helper( {value:url,message} )',
    '  })',
    '})',
    '',
].join('\n')

const BETA = [
    "'use strict'",
    "describe('beta suite', () => {",
    "    it('keeps arithmetic', () => {",
    '        return 1 + 2',
    '    })',
    '})',
    '',
].join('\n')

function writeFile(root, relPath, source) {
    const absolute = path.join(root, relPath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, source)
}

function createFixture() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'move-only-split-'))
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFile(root, 'sample.test.js', BASELINE)
    execFileSync('git', ['add', 'sample.test.js'], { cwd: root })
    execFileSync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'baseline'], { cwd: root })
    base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function resetSplit() {
    writeFile(root, 'sample.test.js', [
        "'use strict'",
        "require('./sample.test/01_alpha.test')",
        "require('./sample.test/02_beta.test')",
        '',
    ].join('\n'))
    writeFile(root, 'sample.test/01_alpha.test.js', ALPHA)
    writeFile(root, 'sample.test/02_beta.test.js', BETA)
    for (const extra of ['03_duplicate.test.js', '03_duplicate_require.test.js']) {
        const absolute = path.join(root, 'sample.test', extra)
        if (fs.existsSync(absolute)) fs.rmSync(absolute)
    }
}

function check(mutator) {
    resetSplit()
    if (mutator) mutator(root)
    return guard.checkMoveOnlySplit({ repoRoot: root, base, filePath: 'sample.test.js' })
}

function replace(root, relPath, from, to) {
    const absolute = path.join(root, relPath)
    const source = fs.readFileSync(absolute, 'utf8')
    assert.ok(source.includes(from), `fixture does not contain ${JSON.stringify(from)}`)
    fs.writeFileSync(absolute, source.replace(from, to))
}

describe('check-move-only-split', function() {
    this.timeout(30000)

    before(createFixture)

    after(() => fs.rmSync(root, { recursive: true, force: true }))

    it('accepts statements moved verbatim while ignoring formatting outside literals', () => {
        assert.deepStrictEqual(check(), { ok: true, problems: [] })
    })

    it('accepts the same fixture through the command line', () => {
        resetSplit()
        const result = spawnSync(process.execPath, [CLI, '--base', base, 'sample.test.js'], {
            cwd: root,
            encoding: 'utf8',
        })
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stdout, /move-only split holds/)
    })

    it('refuses an added behavior-bearing helper', () => {
        const result = check((root) => replace(
            root,
            'sample.test/01_alpha.test.js',
            "const helper = require('./helper')",
            "const helper = require('./helper')\nfunction addedHelper() { return 3 }",
        ))
        assert.strictEqual(result.ok, false)
        assert.ok(result.problems.some((problem) => problem.includes('function addedHelper')))
    })

    it('refuses a rewritten statement', () => {
        const result = check((root) => replace(root, 'sample.test/02_beta.test.js', 'return 1 + 2', 'return 1 + 3'))
        assert.strictEqual(result.ok, false)
        assert.ok(result.problems.some((problem) => problem.includes('statement missing')))
        assert.ok(result.problems.some((problem) => problem.includes('statement added')))
    })

    it('refuses a renamed suite title', () => {
        const result = check((root) => replace(root, 'sample.test/02_beta.test.js', 'beta suite', 'renamed suite'))
        assert.strictEqual(result.ok, false)
        assert.ok(result.problems.some((problem) => problem.includes('suite title missing')))
        assert.ok(result.problems.some((problem) => problem.includes('suite title added')))
    })

    it('refuses a duplicated baseline describe statement', () => {
        const result = check((root) => writeFile(root, 'sample.test/03_duplicate.test.js', BETA))
        assert.strictEqual(result.ok, false)
        assert.ok(result.problems.some((problem) => problem.includes('describe("beta suite")')))
    })

    it('refuses a duplicated baseline require statement', () => {
        const result = check((root) => writeFile(root, 'sample.test/03_duplicate_require.test.js', [
            "'use strict'",
            "const helper = require('./helper')",
            '',
        ].join('\n')))
        assert.strictEqual(result.ok, false)
        assert.ok(result.problems.some((problem) => problem.includes('statement added or duplicated')))
    })

    it('refuses changed expression delimiters', () => {
        const result = check((root) => replace(
            root,
            'sample.test/01_alpha.test.js',
            'helper( {value:url,message} )',
            'helper( [url,message] )',
        ))
        assert.strictEqual(result.ok, false)
    })

    it('refuses changed suite nesting', () => {
        const result = check((root) => writeFile(root, 'sample.test/02_beta.test.js', [
            "describe('wrapper suite', () => {",
            BETA,
            '})',
            '',
        ].join('\n')))
        assert.strictEqual(result.ok, false)
        assert.ok(result.problems.some((problem) => problem.includes('wrapper suite')))
    })

    it('refuses whitespace rewritten inside a string literal', () => {
        const result = check((root) => replace(
            root,
            'sample.test/01_alpha.test.js',
            '/*literal*/ suffix',
            '/*literal*/  suffix',
        ))
        assert.strictEqual(result.ok, false)
    })

    it('refuses whitespace rewritten inside a template literal', () => {
        const result = check((root) => replace(
            root,
            'sample.test/01_alpha.test.js',
            '  // literal spacing',
            ' // literal spacing',
        ))
        assert.strictEqual(result.ok, false)
    })

    it('refuses comment-like text rewritten inside string and template literals', () => {
        const stringResult = check((root) => replace(
            root,
            'sample.test/01_alpha.test.js',
            '/*literal*/',
            '/*changed*/',
        ))
        const templateResult = check((root) => replace(
            root,
            'sample.test/01_alpha.test.js',
            '// literal spacing',
            '// changed text',
        ))
        assert.strictEqual(stringResult.ok, false)
        assert.strictEqual(templateResult.ok, false)
    })

    it('refuses a changed parenthesis structure preserved by Acorn', () => {
        const baseline = guard.parseSource('const value = (1 + 2) * 3', 'baseline.js').body[0]
        const changed = guard.parseSource('const value = 1 + 2 * 3', 'changed.js').body[0]
        assert.notStrictEqual(guard.fingerprint(baseline), guard.fingerprint(changed))
    })

    it('refuses invalid syntax instead of falling back to text matching', () => {
        const result = check((root) => replace(root, 'sample.test/02_beta.test.js', 'return 1 + 2', 'return (1 + 2'))
        assert.strictEqual(result.ok, false)
        assert.ok(result.problems.some((problem) => problem.includes('cannot parse')))
    })

    it('returns a failing status through the command line', () => {
        resetSplit()
        replace(root, 'sample.test/02_beta.test.js', 'return 1 + 2', 'return 1 + 3')
        const result = spawnSync(process.execPath, [CLI, '--base', base, 'sample.test.js'], {
            cwd: root,
            encoding: 'utf8',
        })
        assert.strictEqual(result.status, 1)
        assert.match(result.stderr, /move-only split failed/)
    })
})
