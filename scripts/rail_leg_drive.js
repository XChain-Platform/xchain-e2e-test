#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync, spawn } = require('child_process')

const { RAIL_DRIVES } = require('../test/helpers/bridge_rail_legs')
const {
    ancestorPids,
    otherRailDrives,
} = require('../test/helpers/rail_preflight/rail_drive_processes')
const { triageJournal } = require('./rail_journal_triage')
const { limitSchedule, parseGraceMinutes } = require('./rail_leg/rail_leg_limit')

const REPO_ROOT = path.resolve(__dirname, '..')
const MOCHA = './node_modules/.bin/mocha'
const DEFAULT_LIMIT_MINUTES = 45
const DEFAULT_TEARDOWN_GRACE_MINUTES = 20
const ENV_KEYS_SET = [
    'COIN',
    'NETWORK',
    'NODE_PATH',
    'BRIDGE_RAIL_REPO_ROOT',
    'BRIDGE_RAIL_MINER_PAUSE_FILE',
    'BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE',
    'ATTEST_VENUE_LOG_DIR',
    'BRIDGE_RAIL_JOURNAL_DIR',
]

function railLeg (driveName, legName, drives) {
    const drive = drives[driveName]
    if (!drive) throw new Error('unknown bridge rail drive: ' + String(driveName))
    const leg = drive.legs[legName]
    if (!leg) throw new Error('unknown ' + driveName + ' bridge rail leg: ' + String(legName))
    return { drive, leg }
}

function childEnvironment (source, journalDir, repoRoot) {
    const env = { ...source }
    const platformRoot = path.dirname(repoRoot)
    env.COIN = 'bitcoin'
    env.NETWORK = 'regtest'
    env.NODE_PATH = env.NODE_PATH || platformRoot
    env.BRIDGE_RAIL_REPO_ROOT = env.BRIDGE_RAIL_REPO_ROOT || platformRoot
    env.BRIDGE_RAIL_MINER_PAUSE_FILE = env.BRIDGE_RAIL_MINER_PAUSE_FILE ||
        path.join('/home', 'jdog', 'scratch', 'xc-meta', 'btc-loop.pause')
    env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE = env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE ||
        path.join('/home', 'jdog', 'scratch', 'xc-meta', 'doge-loop.pause')
    env.ATTEST_VENUE_LOG_DIR = journalDir
    env.BRIDGE_RAIL_JOURNAL_DIR = journalDir
    delete env.XC_ROLLCALL_IDLE_GENERATION
    return env
}

function buildLegCommand (driveName, legName, opts = {}) {
    const drives = opts.drives || RAIL_DRIVES
    const { drive, leg } = railLeg(driveName, legName, drives)
    const repoRoot = opts.repoRoot || REPO_ROOT
    const journalDir = opts.journalDir
    if (!journalDir) throw new Error('--journal-dir is required')
    const reportPath = leg.files
        ? path.join(journalDir, 'mocha-report.json')
        : null
    const argv = ['--no-config', '--reporter', reportPath ? 'json' : 'spec',
        '--timeout', '0', '--exit']
    if (leg.grep) argv.push('--grep', leg.grep)
    const files = leg.files || [...(drive.before || []), drive.root, drive.glob]
    argv.push('--require', './test/initial_check.test.js', ...files)
    const env = childEnvironment(opts.env || {}, journalDir, repoRoot)
    Object.assign(env, leg.env || {})
    return {
        command: MOCHA,
        argv,
        cwd: repoRoot,
        env,
        envKeys: [...new Set([
            ...ENV_KEYS_SET,
            ...(drive.envKeys || []),
            ...Object.keys(leg.env || {}),
        ])],
        journalPath: path.join(journalDir, 'case-journal.jsonl'),
        reportPath,
        minPassed: leg.minPassed,
    }
}

function parseArgs (argv) {
    if (argv.length < 2) throw new Error('drive and leg are required')
    const options = {
        drive: argv[0],
        leg: argv[1],
        limitMinutes: DEFAULT_LIMIT_MINUTES,
        teardownGraceMinutes: DEFAULT_TEARDOWN_GRACE_MINUTES,
        dryRun: false,
    }
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--dry-run') options.dryRun = true
        else if (argv[i] === '--journal-dir' && i + 1 < argv.length) options.journalDir = argv[++i]
        else if (argv[i] === '--limit-minutes' && i + 1 < argv.length) options.limitMinutes = Number(argv[++i])
        else if (argv[i] === '--teardown-grace-minutes' && i + 1 < argv.length) {
            options.teardownGraceMinutes = parseGraceMinutes(argv[++i])
        }
        else throw new Error('unknown or incomplete argument: ' + argv[i])
    }
    if (!options.journalDir) throw new Error('--journal-dir is required')
    if (!Number.isFinite(options.limitMinutes) || options.limitMinutes <= 0) {
        throw new Error('--limit-minutes must be greater than zero')
    }
    return options
}

function printDryRun (command) {
    console.log('mocha argv: ' + JSON.stringify(command.argv))
    console.log('env keys set: ' + command.envKeys.join(', '))
}

function findCompetingDrive () {
    const psText = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    return otherRailDrives(psText, ancestorPids(psText, process.pid))[0]
}

function runChild (command, limitMinutes, graceMinutes) {
    return new Promise((resolve, reject) => {
        const schedule = limitSchedule(limitMinutes, graceMinutes)
        const reportFd = command.reportPath
            ? fs.openSync(command.reportPath, 'w')
            : null
        let child
        try {
            child = spawn(command.command, command.argv, {
                cwd: command.cwd,
                env: command.env,
                stdio: ['inherit', reportFd === null ? 'inherit' : reportFd, 'inherit'],
            })
        } finally {
            if (reportFd !== null) fs.closeSync(reportFd)
        }
        let timedOut = false
        let killTimer
        const limitTimer = setTimeout(() => {
            timedOut = true
            console.error('leg exceeded ' + limitMinutes + ' minutes')
            child.kill('SIGTERM')
            killTimer = setTimeout(() => {
                console.error('leg teardown killed after ' + graceMinutes +
                    ' grace minutes: run test/attestMirror/releaseLeakedStakes.js before the next drive')
                child.kill('SIGKILL')
            }, schedule.killAtMs - schedule.termAtMs)
        }, schedule.termAtMs)
        child.once('error', (error) => {
            clearTimeout(limitTimer)
            if (killTimer) clearTimeout(killTimer)
            reject(error)
        })
        child.once('close', (code, signal) => {
            clearTimeout(limitTimer)
            if (killTimer) clearTimeout(killTimer)
            resolve({ code, signal, timedOut })
        })
    })
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

function triageFile (command) {
    if (command.reportPath) return triageMochaReport(command)
    let text
    try {
        text = fs.readFileSync(command.journalPath, 'utf8')
    } catch (error) {
        if (error && error.code === 'ENOENT') console.log('VERDICT FAIL no journal at ' + command.journalPath)
        else console.log('VERDICT FAIL cannot read journal at ' + command.journalPath)
        return false
    }
    const result = triageJournal(text, { minPassed: command.minPassed })
    printTriage(result)
    return result.pass
}

function mochaFailureLine (test) {
    const error = String(test.err && (test.err.message || test.err.stack) || '')
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 240)
    return 'case failure: ' + test.fullTitle + ' error=' + error
}

function readMochaReport (reportPath) {
    const text = fs.readFileSync(reportPath, 'utf8')
    const reportStart = text.lastIndexOf('{\n  "stats":')
    return JSON.parse(reportStart === -1 ? text : text.slice(reportStart))
}

function triageMochaReport (command) {
    let report
    try {
        report = readMochaReport(command.reportPath)
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            console.log('VERDICT FAIL no mocha report at ' + command.reportPath)
        } else {
            console.log('VERDICT FAIL cannot read mocha report at ' + command.reportPath)
        }
        return false
    }
    const passed = Number(report.stats && report.stats.passes) || 0
    const failed = Number(report.stats && report.stats.failures) || 0
    const pending = Number(report.stats && report.stats.pending) || 0
    for (const failure of report.failures || []) console.log(mochaFailureLine(failure))
    console.log('triage: passed=' + passed + ' failed=' + failed + ' pending=' + pending)
    if (failed > 0) {
        console.log('VERDICT FAIL ' + failed + ' failed case(s)')
        return false
    }
    if (passed < command.minPassed) {
        console.log('VERDICT FAIL passed=' + passed + ' below minPassed=' + command.minPassed)
        return false
    }
    console.log('VERDICT PASS')
    return true
}

async function main (argv) {
    const options = parseArgs(argv)
    const competing = findCompetingDrive()
    if (competing) {
        console.error('refusing bridge rail drive while pid ' + competing.pid + ' is running')
        return 2
    }
    const command = buildLegCommand(options.drive, options.leg, {
        journalDir: options.journalDir,
        env: process.env,
    })
    if (options.dryRun) {
        printDryRun(command)
        return 0
    }
    fs.mkdirSync(options.journalDir, { recursive: true })
    fs.rmSync(command.journalPath, { force: true })
    if (command.reportPath) fs.rmSync(command.reportPath, { force: true })
    const childResult = await runChild(command, options.limitMinutes, options.teardownGraceMinutes)
    const passed = triageFile(command)
    return passed && !childResult.timedOut ? 0 : 1
}

module.exports = { buildLegCommand, otherRailDrives }

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code
    }, (error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
