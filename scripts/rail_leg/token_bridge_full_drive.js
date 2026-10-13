#!/usr/bin/env node
'use strict'

// Runner for the token and base bridge rail full drives. Captures the three repo heads,
// drives token then base full into one run directory (journals and venue logs per drive),
// and writes the drive report from both journals.
// Usage: node scripts/rail_leg/token_bridge_full_drive.js --run-dir <dir> [--date YYYY-MM-DD]
//   [--platform-root <dir>] [--indexer-root <dir>] [--limit-minutes <n>]
// Exit 0 when both drives pass, 1 when either fails, 2 on a usage error.

const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const { triageJournal } = require('../rail_journal_triage')
const { renderDriveReport } = require('./token_bridge_drive_report')
const { RAIL_DRIVES } = require('../../test/helpers/bridge_rail_legs')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const LEG_DRIVE = path.join(REPO_ROOT, 'scripts', 'rail_leg_drive.js')
const DRIVE_ORDER = ['token', 'base']
const LEG = 'full'
const REPORT_NAME = 'drive-report.md'
const VALUE_FLAGS = ['--run-dir', '--date', '--platform-root', '--indexer-root', '--limit-minutes']

function parseArgs (argv, now = new Date()) {
    const options = {
        date: now.toISOString().slice(0, 10),
        platformRoot: path.dirname(REPO_ROOT),
        indexerRoot: path.join(path.dirname(REPO_ROOT), 'xchain-indexer'),
        limitMinutes: null,
    }
    const keys = {
        '--run-dir': 'runDir',
        '--date': 'date',
        '--platform-root': 'platformRoot',
        '--indexer-root': 'indexerRoot',
        '--limit-minutes': 'limitMinutes',
    }
    for (let i = 0; i < argv.length; i++) {
        if (!VALUE_FLAGS.includes(argv[i]) || i + 1 >= argv.length) {
            throw new Error('unknown or incomplete argument: ' + argv[i])
        }
        options[keys[argv[i]]] = argv[++i]
    }
    if (!options.runDir) throw new Error('--run-dir is required')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('--date must be YYYY-MM-DD')
    if (options.limitMinutes !== null &&
        !(Number(options.limitMinutes) > 0)) {
        throw new Error('--limit-minutes must be greater than zero')
    }
    return options
}

function gitHead (root, exec = execFileSync) {
    try {
        return String(exec('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })).trim() || 'unknown'
    } catch {
        return 'unknown'
    }
}

function captureHeads (options, exec = execFileSync) {
    return {
        platform: gitHead(options.platformRoot, exec),
        indexer: gitHead(options.indexerRoot, exec),
        e2eTest: gitHead(REPO_ROOT, exec),
    }
}

function driveDir (runDir, name) {
    return path.join(runDir, name)
}

function legDriveArgs (name, options) {
    const args = [LEG_DRIVE, name, LEG, '--journal-dir', driveDir(options.runDir, name)]
    if (options.limitMinutes !== null) args.push('--limit-minutes', String(options.limitMinutes))
    return args
}

function spawnLegDrive (args) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: REPO_ROOT })
    return result.status === null ? 1 : result.status
}

function noJournal () {
    return {
        pass: false,
        reason: 'no journal',
        passed: 0,
        failed: 0,
        root: 0,
        cascade: 0,
        other: 0,
        malformed: 0,
        rootFailures: [],
    }
}

function readJournal (runDir, name, drives = RAIL_DRIVES) {
    const journalPath = path.join(driveDir(runDir, name), 'case-journal.jsonl')
    try {
        return triageJournal(fs.readFileSync(journalPath, 'utf8'), {
            minPassed: drives[name].legs[LEG].minPassed,
        })
    } catch {
        return noJournal()
    }
}

// A drive passes only when its process exited 0 and its fresh journal triages as a pass.
function withExitCode (result, exitCode) {
    if (exitCode === 0) return result
    return { ...result, pass: false, reason: 'drive exited ' + exitCode + (result.reason ? ': ' + result.reason : '') }
}

// Drives both rails in order even when the first fails, so one run yields both journals.
function runFullDrive (options, io = {}) {
    const runLegDrive = io.runLegDrive || spawnLegDrive
    const heads = captureHeads(options, io.exec)
    const exitCodes = {}
    for (const name of DRIVE_ORDER) {
        fs.mkdirSync(driveDir(options.runDir, name), { recursive: true })
        // A journal left by an earlier run must never be read as this drive's result.
        for (const stale of ['case-journal.jsonl', 'mocha-report.json']) {
            fs.rmSync(path.join(driveDir(options.runDir, name), stale), { force: true })
        }
        exitCodes[name] = runLegDrive(legDriveArgs(name, options))
    }
    const token = withExitCode(readJournal(options.runDir, 'token', io.drives), exitCodes.token)
    const base = withExitCode(readJournal(options.runDir, 'base', io.drives), exitCodes.base)
    const report = renderDriveReport({ date: options.date, heads, token, base })
    const reportPath = path.join(options.runDir, REPORT_NAME)
    fs.writeFileSync(reportPath, report)
    return { heads, exitCodes, token, base, reportPath, pass: token.pass && base.pass }
}

function main (argv, io = {}) {
    let options
    try {
        options = parseArgs(argv, io.now)
    } catch (error) {
        process.stderr.write('usage error: ' + error.message + '\n')
        return 2
    }
    fs.mkdirSync(options.runDir, { recursive: true })
    const outcome = runFullDrive(options, io)
    process.stdout.write('report: ' + outcome.reportPath + '\n')
    return outcome.pass ? 0 : 1
}

module.exports = { captureHeads, legDriveArgs, main, parseArgs, readJournal, runFullDrive }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
