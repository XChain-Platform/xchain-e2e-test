#!/usr/bin/env node
'use strict'

const fs = require('fs')

function parseJournal (text) {
    const lines = String(text).split(/\r?\n/)
    const latest = new Map()
    let malformed = 0
    if (lines[lines.length - 1] === '') lines.pop()

    for (const line of lines) {
        let entry
        try {
            entry = JSON.parse(line)
        } catch {
            malformed++
            continue
        }
        // Keep only objects that can participate in the title-keyed rerun collapse.
        if (!entry || Array.isArray(entry) || typeof entry !== 'object' ||
            typeof entry.title !== 'string') {
            malformed++
            continue
        }
        latest.delete(entry.title)
        latest.set(entry.title, entry)
    }
    return { entries: [...latest.values()], malformed }
}

function failureReason (counts, minPassed) {
    if (counts.failed > 0) return counts.failed + ' failed case(s)'
    if (counts.passed < minPassed) {
        return 'passed=' + counts.passed + ' below minPassed=' + minPassed
    }
    return ''
}

function triageJournal (text, options = {}) {
    const minPassed = options.minPassed === undefined ? 1 : options.minPassed
    // Refuse impossible thresholds instead of producing a misleading verdict.
    if (!Number.isInteger(minPassed) || minPassed < 0) {
        throw new TypeError('minPassed must be a non-negative integer')
    }
    const parsed = parseJournal(text)
    const result = {
        passed: 0,
        failed: 0,
        root: 0,
        cascade: 0,
        other: 0,
        malformed: parsed.malformed,
        rootFailures: [],
    }

    for (const entry of parsed.entries) {
        if (entry.state === 'passed') {
            result.passed++
        } else if (entry.state === 'failed') {
            result.failed++
            if (/must have run/.test(entry.error)) result.cascade++
            else {
                result.root++
                result.rootFailures.push(entry)
            }
        } else {
            result.other++
        }
    }
    result.reason = failureReason(result, minPassed)
    result.pass = result.reason === ''
    result.verdict = result.pass ? 'PASS' : 'FAIL ' + result.reason
    return result
}

function parseArgs (argv) {
    if (argv.length === 0) throw new Error('journal path is required')
    const options = { journalPath: argv[0], minPassed: 1 }
    for (let i = 1; i < argv.length; i++) {
        // Accept only complete flag-value pairs so a typo cannot change the threshold.
        if (argv[i] !== '--min-passed' || i + 1 >= argv.length) {
            throw new Error('usage: rail_journal_triage.js <journal> [--min-passed N]')
        }
        options.minPassed = Number(argv[++i])
    }
    // Apply the same threshold domain at the command boundary and the pure API.
    if (!Number.isInteger(options.minPassed) || options.minPassed < 0) {
        throw new Error('--min-passed must be a non-negative integer')
    }
    return options
}

function rootFailureLine (entry) {
    const error = String(entry.error === undefined ? '' : entry.error)
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 240)
    return 'root failure: ' + entry.title + ' durationMs=' + entry.durationMs + ' error=' + error
}

function printTriage (result) {
    for (const entry of result.rootFailures) console.log(rootFailureLine(entry))
    console.log('triage: passed=' + result.passed + ' failed=' + result.failed +
        ' root=' + result.root + ' cascade=' + result.cascade + ' other=' + result.other +
        ' malformed=' + result.malformed)
    console.log('VERDICT ' + result.verdict)
}

function main (argv) {
    let options
    try {
        options = parseArgs(argv)
    } catch (error) {
        console.log('VERDICT FAIL ' + error.message)
        return 1
    }

    let text
    try {
        text = fs.readFileSync(options.journalPath, 'utf8')
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            console.log('VERDICT FAIL no journal at ' + options.journalPath)
        } else {
            console.log('VERDICT FAIL cannot read journal at ' + options.journalPath)
        }
        return 1
    }
    const result = triageJournal(text, { minPassed: options.minPassed })
    printTriage(result)
    return result.pass ? 0 : 1
}

module.exports = { triageJournal }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
