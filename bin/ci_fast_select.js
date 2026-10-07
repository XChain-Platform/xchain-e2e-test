#!/usr/bin/env node
'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const path = require('node:path')
const fs = require('node:fs')
const { execFileSync, spawnSync } = require('node:child_process')

const CONSENSUS = [
    'src/coins/',
    'src/crypto_networks.js',
    'test/helpers/core/transactionHelper.js',
    'test/helpers/core/cryptoHelper.js',
    'test/helpers/core/transactionHelper/',
    'test/parity/',
    'test/integration/parity/',
]
const WIDEN = ['test/support/', 'test/initialCheck.test.js']
const GLOBAL_INPUTS = ['package.json', 'package-lock.json']
const SOURCE_ROOTS = ['src/', 'test/helpers/', 'scripts/']
const ALWAYS = [
    'test/unit/suite_parses.test.js',
    'test/unit/sibling_coverage.test.js',
    'test/unit/test_file_reachability.test.js',
    'test/unit/coins_conformance.test.js',
]
const GROUPS = [{ name: 'unit', args: [], matches: file => /^test\/unit\/(?:.+\/)?[^/]+\.test\.js$/.test(file) }]

function normalize(file){
    return file.split(path.sep).join('/')
}

function resolveBase({ env, git }){
    const proposed = env.PROM_CI_BASE_SHA
    if(proposed){
        try {
            git(['cat-file', '-e', proposed + '^{commit}'])
            return proposed
        } catch(error) {}
    }
    try {
        return String(git(['merge-base', 'HEAD', 'origin/develop'])).trim() || null
    } catch(error) {
        return null
    }
}

function groupFor(file){
    return GROUPS.find(group => group.matches(file)) || null
}

function directConsensus(changedFiles, consensusPrefixes){
    const prefixes = consensusPrefixes.concat(WIDEN, GLOBAL_INPUTS)
    return changedFiles.filter(file => prefixes.some(prefix => file.startsWith(prefix)))
}

function resolvedRequire(importer, request){
    const target = normalize(path.resolve(path.dirname(importer), request))
    const root = normalize(process.cwd()) + '/'
    const relative = target.startsWith(root) ? target.slice(root.length) : target
    return [relative, relative + '.js', relative + '/index.js']
}

function relativeRequires(file, readFile){
    let source
    try { source = readFile(file) } catch(error) { return [] }
    const requests = []
    const pattern = /require\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g
    let match
    while((match = pattern.exec(source))) requests.push(match[1])
    return requests
}

function dependencyConsensus(changedFiles, findRequirers, readFile, consensusPrefixes){
    const changedSources = new Set(changedFiles.filter(file => file.startsWith('src/')))
    const reasons = []
    for(const changed of changedSources){
        const basename = path.basename(changed, '.js')
        const candidates = findRequirers(basename)
        for(const importer of candidates){
            if(!consensusPrefixes.some(prefix => importer.startsWith(prefix))) continue
            const requests = relativeRequires(importer, readFile)
            if(requests.some(request => resolvedRequire(importer, request).includes(changed))){
                reasons.push('consensus dependency: ' + importer + ' -> ' + changed)
            }
        }
    }
    return reasons
}

function moduleTail(file){
    return file.replace(/\.js$/, '').replace(/^test\//, '')
}

function testsForSource(file, tests, findRequirers){
    const tail = moduleTail(file)
    const directory = path.posix.dirname(tail)
    const basename = path.posix.basename(tail)
    const directDirectory = directory === '.' ? 'test/unit/' : 'test/unit/' + directory + '/'
    const requirers = new Set(findRequirers(tail))
    return tests.filter(test => {
        const relative = test.slice(directDirectory.length)
        const sameDirectory = test.startsWith(directDirectory) && !relative.includes('/')
        const sameBasename = basename !== 'index' && path.posix.basename(test) === basename + '.test.js'
        const nestedSuite = test.includes('/' + basename + '.test/')
        return sameDirectory || sameBasename || nestedSuite || requirers.has(test)
    })
}

function isDeferredTest(file){
    if(!file.startsWith('test/') || SOURCE_ROOTS.some(root => file.startsWith(root))) return false
    return /(?:\.test\.js|\.e2e\.js|\.perf\.test\.js|\.chaos\.js|\.fuzz\.js|\.regression\.js|\.smoke\.js)$/.test(file)
}

function mappedTests(changedFiles, allTests, findRequirers){
    const selected = new Set(ALWAYS.filter(file => allTests.includes(file)))
    for(const file of changedFiles){
        if(groupFor(file) && allTests.includes(file)) selected.add(file)
        if(SOURCE_ROOTS.some(root => file.startsWith(root))){
            for(const test of testsForSource(file, allTests, findRequirers)) selected.add(test)
        }
    }
    return [...selected].sort().map(file => ({ group: groupFor(file).name, file }))
}

function selectFastTests(changedFiles, { listTests, findRequirers, readFile = fs.readFileSync },
    { consensusPrefixes = CONSENSUS } = {}){
    const changed = [...new Set(changedFiles.map(normalize))].sort()
    const direct = directConsensus(changed, consensusPrefixes).map(file => 'consensus: ' + file)
    const indirect = dependencyConsensus(changed, findRequirers, file => readFile(file, 'utf8'),
        consensusPrefixes)
    const deferred = changed.filter(file => !groupFor(file) && isDeferredTest(file)).map(file => 'deferred: ' + file)
    const reasons = [...new Set(direct.concat(indirect, deferred))].sort()
    const consensus = direct.length > 0 || indirect.length > 0
    const tests = consensus ? [] : mappedTests(changed, listTests().map(normalize), findRequirers)
    return { consensus, reasons, tests }
}

function git(args){
    return execFileSync('git', args, { encoding: 'utf8' })
}

function findRequirers(needle){
    const result = spawnSync('git', ['grep', '-l', '-F', '--', needle], { encoding: 'utf8' })
    if(result.status === 1) return []
    if(result.status !== 0) throw new Error((result.stderr || 'git grep failed').trim())
    return result.stdout.trim() ? result.stdout.trim().split('\n') : []
}

function listTests(){
    return git(['ls-files']).split('\n').filter(file => groupFor(file))
}

function gitLines(args){
    return git(args).split(/\r?\n/).filter(Boolean)
}

function selectionDependencies({ indexed = false } = {}){
    if(indexed){
        const tests = listTests()
        const sources = new Map(gitLines(['ls-files', 'src', 'test'])
            .filter(file => fs.existsSync(file))
            .map(file => [file, fs.readFileSync(file, 'utf8')]))
        const requirers = new Map()
        return {
            listTests: () => tests,
            findRequirers: needle => {
                if(!requirers.has(needle)){
                    requirers.set(needle, [...sources]
                        .filter(([, source]) => source.includes(needle))
                        .map(([file]) => file))
                }
                return requirers.get(needle)
            },
            readFile: file => sources.has(file) ? sources.get(file) : fs.readFileSync(file, 'utf8'),
        }
    }
    return { listTests, findRequirers }
}

function withoutConsensusPrefixes(prefixes){
    const removed = new Set(prefixes.flatMap(prefix => {
        const trimmed = prefix.trim()
        if(!trimmed) return []
        return [trimmed, trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed + '/']
    }))
    return CONSENSUS.filter(prefix => !removed.has(prefix))
}

function changedFilesForCommit(commit){
    const revision = gitLines(['rev-list', '--parents', '-n', '1', commit])[0]
    const [, parent] = revision.split(' ')
    if(parent) return gitLines(['diff', '--name-only', parent + '..' + commit])
    return gitLines(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit])
}

function emptyReplayCounts(){
    return { wholeUnit: 0, changedTests: 0, testOnly: 0, noTests: 0 }
}

function countReplayPlan(counts, changed, plan){
    if(plan.consensus) counts.wholeUnit++
    else if(plan.tests.length && changed.every(file => file.startsWith('test/'))) counts.testOnly++
    else if(plan.tests.length) counts.changedTests++
    else counts.noTests++
}

function replayPlans(limit, narrowPrefixes){
    const commits = gitLines(['log', '--first-parent', '-n', String(limit), '--format=%H',
        'origin/develop'])
    const current = emptyReplayCounts()
    const narrowed = emptyReplayCounts()
    const consensusPrefixes = withoutConsensusPrefixes(narrowPrefixes)
    const dependencies = selectionDependencies({ indexed: true })
    for(const commit of commits){
        const changed = changedFilesForCommit(commit)
        countReplayPlan(current, changed, selectFastTests(changed, dependencies))
        countReplayPlan(narrowed, changed,
            selectFastTests(changed, dependencies, { consensusPrefixes }))
    }
    return { commits, current, narrowed, consensusPrefixes, dependencies }
}

function fraction(value, total){
    return value + '/' + total
}

function printReplayRow(name, total, counts){
    console.log([
        name,
        total,
        fraction(counts.wholeUnit, total),
        fraction(counts.changedTests, total),
        fraction(counts.testOnly, total),
        fraction(counts.noTests, total),
    ].join(' '))
}

function parseList(value){
    return value.split(',').map(item => item.trim()).filter(Boolean)
}

function parseMustSelect(value){
    return parseList(value).map(pair => {
        const separator = pair.indexOf(':')
        if(separator <= 0 || separator === pair.length - 1){
            throw new Error('invalid --must-select pair: ' + pair)
        }
        return { source: pair.slice(0, separator), test: pair.slice(separator + 1) }
    })
}

function replayOptions(args){
    const limit = Number(args[0])
    if(!Number.isSafeInteger(limit) || limit < 1){
        throw new Error('--replay requires a positive integer')
    }
    const options = { limit, narrowPrefixes: [], mustSelect: [] }
    for(let index = 1; index < args.length; index += 2){
        const flag = args[index]
        const value = args[index + 1]
        if(!value || (flag !== '--narrow' && flag !== '--must-select')){
            throw new Error(('invalid replay option: ' + (flag || '')).trim())
        }
        if(flag === '--narrow') options.narrowPrefixes.push(...parseList(value))
        else options.mustSelect.push(...parseMustSelect(value))
    }
    return options
}

function runReplay(args){
    try {
        const options = replayOptions(args)
        const result = replayPlans(options.limit, options.narrowPrefixes)
        console.log('plan commits consensus-1 changed-tests test-only no-tests')
        printReplayRow('current', result.commits.length, result.current)
        if(options.narrowPrefixes.length){
            printReplayRow('narrowed', result.commits.length, result.narrowed)
        }
        let failed = false
        for(const pair of options.mustSelect){
            const plan = selectFastTests([pair.source], result.dependencies, {
                consensusPrefixes: result.consensusPrefixes,
            })
            const selected = plan.tests.some(test => test.file === pair.test)
            console.log('must-select ' + (selected ? 'PASS' : 'FAIL') + ' ' + pair.source + ':' + pair.test)
            if(!selected) failed = true
        }
        return failed ? 1 : 0
    } catch(error) {
        console.error('replay-error ' + error.message)
        return 2
    }
}

function buildPlan(){
    const base = resolveBase({ env: process.env, git })
    if(!base) return { noBase: process.env.PROM_CI_BASE_SHA
        ? 'PROM_CI_BASE_SHA is not a commit and origin/develop has no merge base'
        : 'origin/develop has no merge base' }
    const changed = git(['diff', '--name-only', base + '...HEAD']).trim().split('\n').filter(Boolean)
    return selectFastTests(changed, { listTests, findRequirers })
}

function printPlan(plan){
    console.log('consensus ' + (plan.consensus ? '1' : '0'))
    for(const reason of plan.reasons) console.log('reason ' + reason)
    for(const test of plan.tests) console.log('test ' + test.group + ' ' + test.file)
}

function testsToRun(plan){
    if(!plan.consensus) return plan.tests
    return listTests().sort().map(file => ({ group: groupFor(file).name, file }))
}

function runPlan(plan){
    const tests = testsToRun(plan)
    if(tests.length === 0){
        console.log('ci:fast: no test maps to this push')
        return 0
    }
    let failed = false
    for(const group of GROUPS){
        const files = tests.filter(test => test.group === group.name).map(test => test.file)
        if(files.length === 0) continue
        const result = spawnSync('./node_modules/.bin/mocha', ['--no-config', ...group.args, ...files], { stdio: 'inherit' })
        if(result.status !== 0) failed = true
    }
    return failed ? 1 : 0
}

function main(){
    if(process.argv[2] === '--replay') return runReplay(process.argv.slice(3))
    if(!['--plan', '--run'].includes(process.argv[2])){
        console.error('usage: node bin/ci_fast_select.js --plan|--run|--replay N ' +
            '[--narrow prefix,...] [--must-select file:testfile,...]')
        return 2
    }
    let plan
    try { plan = buildPlan() } catch(error) {
        console.error('selector-error ' + error.message)
        return 2
    }
    if(plan.noBase){
        console.log('no-base ' + plan.noBase)
        return 3
    }
    if(process.argv[2] === '--plan'){
        printPlan(plan)
        return 0
    }
    return runPlan(plan)
}

module.exports = { CONSENSUS, replayPlans, resolveBase, selectFastTests }

if(require.main === module) process.exitCode = main()
