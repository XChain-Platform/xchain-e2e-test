#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const acorn = require('acorn')

const DEFAULT_SUITES = path.join(__dirname, '..', 'test', 'integration', 'bridge_rail_policy.test')

function stringPrefix (expression) {
    if (!expression) return null
    if (expression.type === 'Literal' && typeof expression.value === 'string') return expression.value
    if (expression.type !== 'BinaryExpression' || expression.operator !== '+') return null
    return stringPrefix(expression.left) || stringPrefix(expression.right)
}

function collectStaticSkips (node, titles) {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        !node.callee.computed && node.callee.object.type === 'Identifier' &&
        node.callee.object.name === 'it' && node.callee.property.name === 'skip') {
        const title = stringPrefix(node.arguments[0])
        if (title !== null) titles.push(title)
    }
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const child of value) {
                if (child && typeof child.type === 'string') collectStaticSkips(child, titles)
            }
        } else if (value && typeof value.type === 'string') {
            collectStaticSkips(value, titles)
        }
    }
}

function staticSkipTitles (suiteDir) {
    const files = fs.readdirSync(suiteDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
        .map((entry) => entry.name)
        .sort()
    const titles = []
    for (const file of files) {
        const source = fs.readFileSync(path.join(suiteDir, file), 'utf8')
        const tree = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true })
        collectStaticSkips(tree, titles)
    }
    return titles
}

function unreadableResult () {
    return { verdict: 'UNREADABLE', passes: 0, failures: 0, staticPending: 0, gatedPending: 0 }
}

function isReadableReport (report) {
    return Boolean(report && typeof report === 'object' && report.stats &&
        Number.isInteger(report.stats.passes) && report.stats.passes >= 0 &&
        Array.isArray(report.passes) && Array.isArray(report.failures) && Array.isArray(report.pending))
}

function isStaticPending (entry, staticTitles) {
    const title = entry && typeof entry.title === 'string' ? entry.title : ''
    return staticTitles.some((prefix) => title.startsWith(prefix))
}

function judgePolicyDrive (report, staticTitles, { minPasses = 28 } = {}) {
    if (!Number.isInteger(minPasses) || minPasses < 0) throw new TypeError('minPasses must be a non-negative integer')
    if (!Array.isArray(staticTitles)) throw new TypeError('staticTitles must be an array')
    if (!isReadableReport(report)) return unreadableResult()

    const staticPending = report.pending.filter((entry) => isStaticPending(entry, staticTitles)).length
    const gatedPending = report.pending.length - staticPending
    const result = {
        verdict: 'PASS',
        passes: report.stats.passes,
        failures: report.failures.length,
        staticPending,
        gatedPending,
    }
    if (result.failures > 0) result.verdict = 'FAIL'
    else if (result.gatedPending > 0) result.verdict = 'GATED'
    else if (result.passes < minPasses) result.verdict = 'SHORT'
    return result
}

function parseArgs (argv) {
    if (argv.length === 0 || argv[0].startsWith('--')) throw new Error('report is required')
    const options = { reportPath: argv[0], minPasses: 28, suiteDir: DEFAULT_SUITES }
    const seen = new Set()
    for (let index = 1; index < argv.length; index += 2) {
        const option = argv[index]
        const value = argv[index + 1]
        if (!['--min-passes', '--suites'].includes(option) || seen.has(option) || value === undefined) {
            throw new Error('invalid arguments')
        }
        seen.add(option)
        if (option === '--suites') options.suiteDir = path.resolve(value)
        else {
            if (!/^\d+$/.test(value)) throw new Error('invalid minimum')
            options.minPasses = Number(value)
            if (!Number.isSafeInteger(options.minPasses)) throw new Error('invalid minimum')
        }
    }
    return options
}

function firstLine (value) {
    return String(value || '').split(/\r?\n/, 1)[0]
}

function printResult (result, report, staticTitles) {
    console.log('DRIVE policy ' + result.verdict + ' passes=' + result.passes +
        ' failures=' + result.failures + ' static=' + result.staticPending +
        ' gated=' + result.gatedPending)
    if (!isReadableReport(report)) return
    for (const pending of report.pending) {
        if (!isStaticPending(pending, staticTitles)) console.log('GATED ' + firstLine(pending.fullTitle))
    }
    for (const failure of report.failures) {
        console.log('FAILED ' + firstLine(failure.fullTitle) + ': ' + firstLine(failure.err && failure.err.message))
    }
}

function main (argv) {
    let options
    try {
        options = parseArgs(argv)
    } catch {
        return 64
    }

    let report = null
    let staticTitles = []
    try {
        report = JSON.parse(fs.readFileSync(options.reportPath, 'utf8'))
        staticTitles = staticSkipTitles(options.suiteDir)
    } catch {
        report = null
    }
    const result = judgePolicyDrive(report, staticTitles, { minPasses: options.minPasses })
    printResult(result, report, staticTitles)
    return result.verdict === 'PASS' ? 0 : 1
}

module.exports = { staticSkipTitles, judgePolicyDrive }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
