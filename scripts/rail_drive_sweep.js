#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const { RAIL_DRIVES } = require('../test/helpers/bridge_rail_legs')

const DEFAULT_DRIVES = ['policy', 'token']
const DEFAULT_LIMIT_MINUTES = 180
const REPO_ROOT = path.resolve(__dirname, '..')
const LEG_DRIVER = path.join(__dirname, 'rail_leg_drive.js')

function latestJournalEntries (journalText) {
    const latest = new Map()
    for (const line of String(journalText).split(/\r?\n/)) {
        let entry
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        if (!entry || Array.isArray(entry) || typeof entry !== 'object' ||
            typeof entry.title !== 'string') continue
        latest.delete(entry.title)
        latest.set(entry.title, entry)
    }
    return [...latest.values()]
}

function verdictForLeg (entries, legName, leg) {
    const selected = leg.grep
        ? entries.filter((entry) => new RegExp(leg.grep).test(entry.title))
        : entries
    let passed = 0
    let failed = 0
    let root = 0
    let cascade = 0
    for (const entry of selected) {
        if (entry.state === 'passed') passed++
        if (entry.state !== 'failed') continue
        failed++
        if (/must have run/.test(entry.error)) cascade++
        else root++
    }
    const missing = Math.max(0, leg.minPassed - passed - failed)
    const verdict = failed === 0 && passed >= leg.minPassed ? 'PASS' : 'FAIL'
    return { leg: legName, verdict, passed, failed, root, cascade, missing }
}

function legVerdicts (journalText, driveName, drives) {
    const drive = drives[driveName]
    if (!drive) throw new Error('unknown bridge rail drive: ' + String(driveName))
    const entries = latestJournalEntries(journalText)
    return Object.entries(drive.legs).map(([legName, leg]) =>
        verdictForLeg(entries, legName, leg))
}

function renderSweepReport (results) {
    const lines = []
    const legs = results.flatMap((result) => result.legs.map((leg) => ({
        drive: result.drive,
        ...leg,
    })))
    for (const result of legs) {
        lines.push('LEG ' + result.drive + ' ' + result.leg + ' ' + result.verdict +
            ' passed=' + result.passed + ' failed=' + result.failed +
            ' root=' + result.root + ' cascade=' + result.cascade +
            ' missing=' + result.missing)
    }
    for (const result of results) {
        lines.push('## ' + result.drive)
        lines.push(...result.runnerLines)
    }
    const passed = legs.filter((leg) => leg.verdict === 'PASS').length
    lines.push('SWEEP legs=' + legs.length + ' pass=' + passed +
        ' fail=' + (legs.length - passed))
    return lines.join('\n') + '\n'
}

function parseSweepArgs (argv, drives = RAIL_DRIVES) {
    const options = { drives: DEFAULT_DRIVES.slice(), limitMinutes: DEFAULT_LIMIT_MINUTES }
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--journal-root' && i + 1 < argv.length) options.journalRoot = argv[++i]
        else if (argv[i] === '--report' && i + 1 < argv.length) options.report = argv[++i]
        else if (argv[i] === '--drives' && i + 1 < argv.length) {
            options.drives = argv[++i].split(',').filter(Boolean)
        } else if (argv[i] === '--limit-minutes' && i + 1 < argv.length) {
            options.limitMinutes = Number(argv[++i])
        } else throw new Error('unknown or incomplete argument: ' + argv[i])
    }
    if (!options.journalRoot) throw new Error('--journal-root is required')
    if (!options.report) throw new Error('--report is required')
    if (options.drives.length === 0) throw new Error('--drives requires at least one drive')
    for (const driveName of options.drives) {
        if (!drives[driveName]) throw new Error('unknown bridge rail drive: ' + driveName)
    }
    if (!Number.isFinite(options.limitMinutes) || options.limitMinutes <= 0) {
        throw new Error('--limit-minutes must be greater than zero')
    }
    return options
}

function retainRunnerLine (lines, line) {
    if (/^(?:root failure:|triage:|VERDICT(?:\s|$))/.test(line)) lines.push(line)
}

function pipeAndRetain (stream, output, lines) {
    let pending = ''
    stream.on('data', (chunk) => {
        output.write(chunk)
        const parts = (pending + chunk.toString()).split(/\r?\n/)
        pending = parts.pop()
        for (const line of parts) retainRunnerLine(lines, line)
    })
    stream.on('end', () => {
        if (pending) retainRunnerLine(lines, pending)
    })
}

function runDrive (driveName, options) {
    const journalDir = path.join(options.journalRoot, driveName)
    const argv = [LEG_DRIVER, driveName, 'full', '--journal-dir', journalDir,
        '--limit-minutes', String(options.limitMinutes)]
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, argv, { cwd: REPO_ROOT })
        const runnerLines = []
        pipeAndRetain(child.stdout, process.stdout, runnerLines)
        pipeAndRetain(child.stderr, process.stderr, runnerLines)
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal, runnerLines }))
    })
}

function readJournal (journalRoot, driveName) {
    const journalPath = path.join(journalRoot, driveName, 'case-journal.jsonl')
    try {
        return fs.readFileSync(journalPath, 'utf8')
    } catch (error) {
        if (error && error.code === 'ENOENT') return ''
        throw error
    }
}

function writeReport (reportPath, results) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true })
    fs.writeFileSync(reportPath, renderSweepReport(results))
}

async function main (argv) {
    const options = parseSweepArgs(argv)
    const results = []
    for (const driveName of options.drives) {
        const run = await runDrive(driveName, options)
        if (run.code === 2) return 2
        const journalText = readJournal(options.journalRoot, driveName)
        results.push({
            drive: driveName,
            legs: legVerdicts(journalText, driveName, RAIL_DRIVES),
            runnerLines: run.runnerLines,
        })
        writeReport(options.report, results)
    }
    const expected = options.drives.reduce((count, name) =>
        count + Object.keys(RAIL_DRIVES[name].legs).length, 0)
    const readings = results.reduce((count, result) => count + result.legs.length, 0)
    return readings === expected ? 0 : 1
}

module.exports = { legVerdicts, parseSweepArgs, renderSweepReport }

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code
    }, (error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
