'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { CONSENSUS, resolveBase, selectFastTests } = require('../../bin/ci_fast_select')

const ROOT = path.resolve(__dirname, '..', '..')
const ALWAYS = [
    'test/unit/coins_conformance.test.js',
    'test/unit/sibling_coverage.test.js',
    'test/unit/suite_parses.test.js',
    'test/unit/test_file_reachability.test.js',
]

function git(args){
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
}

function listTests(){
    return git(['ls-files']).split('\n').filter(file => /^test\/unit\/(?:.+\/)?[^/]+\.test\.js$/.test(file))
}

function findRequirers(needle){
    const result = spawnSync('git', ['grep', '-l', '-F', '--', needle], { cwd: ROOT, encoding: 'utf8' })
    if(result.status === 1) return []
    assert.strictEqual(result.status, 0, result.stderr)
    return result.stdout.trim() ? result.stdout.trim().split('\n') : []
}

function select(changedFiles){
    return selectFastTests(changedFiles, {
        listTests,
        findRequirers,
        readFile: file => fs.readFileSync(path.join(ROOT, file), 'utf8'),
    })
}

function scratchGit(cwd, args){
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeScratchFile(cwd, file, source){
    const target = path.join(cwd, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, source)
}

function scratchCommit(cwd, message, files){
    scratchGit(cwd, ['add', '--', ...files])
    scratchGit(cwd, [
        '-c', 'user.name=Selector Test',
        '-c', 'user.email=selector-test',
        'commit', '-m', message,
    ])
}

describe('ci fast selector mappings', function(){
    it('maps a changed helper to its unit test and the always-run guards', function(){
        const plan = select(['test/helpers/addressHelper.js'])
        const files = plan.tests.map(test => test.file)
        assert.strictEqual(plan.consensus, false)
        assert.ok(files.includes('test/unit/helpers/addressHelper.test.js'))
        assert.ok(plan.tests.every(test => test.group === 'unit'))
        for(const guard of ALWAYS) assert.ok(files.includes(guard), guard)
    })

    it('widens a changed consensus coin module', function(){
        const plan = select(['src/coins/BTC.js'])
        assert.strictEqual(plan.consensus, true)
        assert.ok(plan.reasons.some(reason => reason.includes('src/coins/BTC.js')))
    })

    it('widens a changed core transaction or crypto helper', function(){
        for(const file of [
            'test/helpers/core/transactionHelper.js',
            'test/helpers/core/cryptoHelper.js',
            'test/helpers/core/transactionHelper/lib/01_create_and_send_transaction.js',
        ]){
            const plan = select([file])
            assert.strictEqual(plan.consensus, true, file)
            assert.ok(plan.reasons.includes('consensus: ' + file), file)
        }
    })

    // Fail on a moved file, which would otherwise drop its consensus widening silently.
    it('resolves every consensus prefix to a tracked file', function(){
        const tracked = git(['ls-files']).split('\n').filter(Boolean)
        for(const prefix of CONSENSUS){
            const resolves = prefix.endsWith('/')
                ? tracked.some(file => file.startsWith(prefix))
                : tracked.includes(prefix)
            assert.ok(resolves, 'consensus prefix matches no tracked file: ' + prefix)
        }
    })

    it('keeps a documentation-only change to the always-run guards', function(){
        const plan = select(['README.md'])
        assert.strictEqual(plan.consensus, false)
        assert.deepStrictEqual(plan.tests.map(test => test.file), ALWAYS)
    })

    it('widens a package manifest change', function(){
        const plan = select(['package.json'])
        assert.strictEqual(plan.consensus, true)
        assert.ok(plan.reasons.some(reason => reason.includes('package.json')))
    })

    it('defers a changed action suite outside the unit runner', function(){
        assert.strictEqual(git(['ls-files', '--error-unmatch', 'test/actions/address.test.js']).trim(),
            'test/actions/address.test.js')
        const plan = select(['test/actions/address.test.js'])
        assert.strictEqual(plan.consensus, false)
        assert.ok(!plan.tests.some(test => test.file === 'test/actions/address.test.js'))
        assert.ok(plan.reasons.includes('deferred: test/actions/address.test.js'))
    })

    it('does not select a changed unit path that no longer exists', function(){
        const plan = selectFastTests(['test/unit/deleted.test.js'], {
            listTests: () => ALWAYS,
            findRequirers: () => [],
        })
        assert.deepStrictEqual(plan.tests.map(test => test.file), ALWAYS)
    })

    it('replays develop history, compares narrowing, and checks required selections', function(){
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fast-select-replay-'))
        try {
            scratchGit(cwd, ['init', '--initial-branch=develop'])
            const initial = {
                'src/coins/rule.js': "module.exports = 'rule'\n",
                'src/feature/plain.js': "module.exports = 'plain'\n",
                'test/unit/coins/rule.test.js': "require('../../../src/coins/rule')\n",
                'test/unit/feature/plain.test.js': "require('../../../src/feature/plain')\n",
                'test/unit/only.test.js': "module.exports = 'only'\n",
                'test/unit/other/unrelated.test.js': "module.exports = 'unrelated'\n",
            }
            for(const [file, source] of Object.entries(initial)) writeScratchFile(cwd, file, source)
            scratchCommit(cwd, 'initial files', Object.keys(initial))

            const consensusFile = 'src/coins/rule.js'
            fs.appendFileSync(path.join(cwd, consensusFile), "module.exports += ' changed'\n")
            scratchCommit(cwd, 'consensus change', [consensusFile])

            const plainFile = 'src/feature/plain.js'
            fs.appendFileSync(path.join(cwd, plainFile), "module.exports += ' changed'\n")
            scratchCommit(cwd, 'plain source change', [plainFile])

            const testFile = 'test/unit/only.test.js'
            fs.appendFileSync(path.join(cwd, testFile), "module.exports += ' changed'\n")
            scratchCommit(cwd, 'test only change', [testFile])
            scratchGit(cwd, ['update-ref', 'refs/remotes/origin/develop', 'HEAD'])

            const selector = path.join(ROOT, 'bin/ci_fast_select.js')
            const mustSelect = [
                'src/coins/rule.js:test/unit/coins/rule.test.js',
                'src/feature/plain.js:test/unit/other/unrelated.test.js',
            ].join(',')
            const result = spawnSync(process.execPath, [
                selector,
                '--replay', '3',
                '--narrow', 'src/coins/',
                '--must-select', mustSelect,
            ], { cwd, encoding: 'utf8' })

            assert.strictEqual(result.status, 1, result.stderr)
            const lines = result.stdout.trim().split(/\r?\n/)
            assert.ok(lines.includes('plan commits consensus-1 changed-tests test-only no-tests'))
            assert.ok(lines.includes('current 3 1/3 1/3 1/3 0/3'))
            assert.ok(lines.includes('narrowed 3 0/3 2/3 1/3 0/3'))
            assert.ok(lines.includes(
                'must-select PASS src/coins/rule.js:test/unit/coins/rule.test.js'))
            assert.ok(lines.includes(
                'must-select FAIL src/feature/plain.js:test/unit/other/unrelated.test.js'))
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true })
        }
    })
})

describe('ci fast selector dependency widening', function(){
    it('widens when a consensus importer requires a changed source module', function(){
        const plan = selectFastTests(['src/lib/core.js'], {
            listTests: () => ALWAYS,
            findRequirers: needle => needle === 'core' ? ['src/coins/reader.js'] : [],
            readFile: file => file === 'src/coins/reader.js' ? "require('../lib/core')" : '',
        })
        assert.strictEqual(plan.consensus, true)
        assert.ok(plan.reasons.includes('consensus dependency: src/coins/reader.js -> src/lib/core.js'))
    })
})

describe('ci fast selector base resolution', function(){
    it('returns null when the proposed sha and fallback both fail', function(){
        const base = resolveBase({
            env: { PROM_CI_BASE_SHA: 'unknown' },
            git: () => { throw new Error('not found') },
        })
        assert.strictEqual(base, null)
    })

    it('returns the proposed sha when git accepts it as a commit', function(){
        const calls = []
        const base = resolveBase({
            env: { PROM_CI_BASE_SHA: 'abc123' },
            git: args => { calls.push(args); return '' },
        })
        assert.strictEqual(base, 'abc123')
        assert.deepStrictEqual(calls, [['cat-file', '-e', 'abc123^{commit}']])
    })
})

describe('ci full fast-tier wiring', function(){
    it('plans only in fast mode and retains the full live-tier command', function(){
        const script = fs.readFileSync(path.join(ROOT, 'bin/ci-full.sh'), 'utf8')
        assert.match(script, /if \[ "\$\{CI_TIER:-\}" = "fast" \]; then[\s\S]*ci_fast_select\.js --plan/)
        assert.match(script, /run_tier "live-tier \(ci:live\)"/)
        assert.match(script, /run_tier "unit \(test:unit, siblings required\)"/)
    })
})
