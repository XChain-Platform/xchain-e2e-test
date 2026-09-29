#!/usr/bin/env node
'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const CONSENSUS = [
    'src/coins/',
    'src/CryptoNetworks.js',
    'test/transactionHelper.js',
    'test/cryptoHelper.js',
    'test/transactionHelper/',
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

function directConsensus(changedFiles){
    const prefixes = CONSENSUS.concat(WIDEN, GLOBAL_INPUTS)
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

function dependencyConsensus(changedFiles, findRequirers, readFile){
    const changedSources = new Set(changedFiles.filter(file => file.startsWith('src/')))
    const reasons = []
    for(const changed of changedSources){
        const basename = path.basename(changed, '.js')
        const candidates = findRequirers(basename)
        for(const importer of candidates){
            if(!CONSENSUS.some(prefix => importer.startsWith(prefix))) continue
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

function selectFastTests(changedFiles, { listTests, findRequirers, readFile = require('node:fs').readFileSync }){
    const changed = [...new Set(changedFiles.map(normalize))].sort()
    const direct = directConsensus(changed).map(file => 'consensus: ' + file)
    const indirect = dependencyConsensus(changed, findRequirers, file => readFile(file, 'utf8'))
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
    if(!['--plan', '--run'].includes(process.argv[2])){
        console.error('usage: node bin/ci_fast_select.js --plan|--run')
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

module.exports = { resolveBase, selectFastTests }

if(require.main === module) process.exitCode = main()
