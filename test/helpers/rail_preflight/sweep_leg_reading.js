'use strict'

const fs = require('fs')

const { RAIL_DRIVES } = require('../bridge_rail_legs')

const LEG_PATTERN = /^LEG (\S+) (\S+) (PASS|FAIL) passed=(\d+) failed=(\d+) root=(\d+) cascade=(\d+) missing=(\d+)$/
const ROOT_PATTERN = /^root failure: (.*?) durationMs=(\d+) error=/
const SWEEP_PATTERN = /^SWEEP legs=(\d+) pass=(\d+) fail=(\d+)$/

function parsedLeg (match) {
    return {
        drive: match[1],
        leg: match[2],
        verdict: match[3],
        passed: Number(match[4]),
        failed: Number(match[5]),
        root: Number(match[6]),
        cascade: Number(match[7]),
        missing: Number(match[8]),
    }
}

function parseSweepReport (text) {
    const legs = []
    const rootFailures = {}
    let sweep = null
    let currentDrive = null
    for (const reportLine of String(text).split(/\r?\n/)) {
        const legMatch = LEG_PATTERN.exec(reportLine)
        if (legMatch) {
            legs.push(parsedLeg(legMatch))
            continue
        }
        const headingMatch = /^## (\S+)$/.exec(reportLine)
        if (headingMatch) {
            currentDrive = headingMatch[1]
            if (!rootFailures[currentDrive]) rootFailures[currentDrive] = []
            continue
        }
        const rootMatch = ROOT_PATTERN.exec(reportLine)
        if (rootMatch && currentDrive) {
            rootFailures[currentDrive].push({
                title: rootMatch[1],
                durationMs: Number(rootMatch[2]),
            })
            continue
        }
        const sweepMatch = SWEEP_PATTERN.exec(reportLine)
        if (sweepMatch) {
            sweep = {
                legs: Number(sweepMatch[1]),
                pass: Number(sweepMatch[2]),
                fail: Number(sweepMatch[3]),
            }
        }
    }
    return { legs, rootFailures, sweep }
}

function railLeg (drive, leg, drives) {
    const hasDrive = drives && Object.prototype.hasOwnProperty.call(drives, drive)
    if (!hasDrive) throw new Error('unknown bridge rail drive: ' + String(drive))
    const driveConfig = drives[drive]
    const hasLeg = driveConfig.legs &&
        Object.prototype.hasOwnProperty.call(driveConfig.legs, leg)
    if (!hasLeg) throw new Error('unknown ' + drive + ' bridge rail leg: ' + String(leg))
    const legConfig = driveConfig.legs[leg]
    return legConfig
}

function readSweepLeg (text, drive, leg, drives = RAIL_DRIVES) {
    const legConfig = railLeg(drive, leg, drives)
    const report = parseSweepReport(text)
    const matches = report.legs.filter((entry) => entry.drive === drive && entry.leg === leg)
    const line = matches.length ? matches[matches.length - 1] : null
    const clean = Boolean(line && (line.verdict === 'PASS' ||
        (line.verdict === 'FAIL' && line.failed >= 1 && line.root === 0)))
    const failures = report.rootFailures[drive] || []
    const rootFailures = leg === 'full' || !legConfig.grep
        ? failures.slice()
        : failures.filter((failure) => new RegExp(legConfig.grep).test(failure.title))
    return { line, clean, rootFailures }
}

function parseArgs (argv) {
    const options = {}
    const names = { '--report': 'report', '--drive': 'drive', '--leg': 'leg' }
    for (let index = 0; index < argv.length; index++) {
        const name = names[argv[index]]
        if (!name) throw new Error('unknown flag: ' + argv[index])
        if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
            throw new Error(argv[index] + ' requires a value')
        }
        options[name] = argv[++index]
    }
    for (const required of Object.values(names)) {
        if (!options[required]) throw new Error('--' + required + ' is required')
    }
    return options
}

function reportLegLine (text, drive, leg) {
    let found = null
    for (const reportLine of String(text).split(/\r?\n/)) {
        const match = LEG_PATTERN.exec(reportLine)
        if (match && match[1] === drive && match[2] === leg) found = reportLine
    }
    return found
}

function main (argv) {
    let options
    try {
        options = parseArgs(argv)
    } catch (error) {
        console.error(error.message)
        return 2
    }
    let text
    try {
        text = fs.readFileSync(options.report, 'utf8')
    } catch {
        console.error('cannot read report')
        return 2
    }
    let reading
    try {
        reading = readSweepLeg(text, options.drive, options.leg)
    } catch (error) {
        console.error(error.message)
        return 2
    }
    console.log(reading.line ? reportLegLine(text, options.drive, options.leg) :
        'LEG ' + options.drive + ' ' + options.leg + ' ABSENT')
    for (const failure of reading.rootFailures) {
        console.log('ROOT ' + failure.title + ' durationMs=' + failure.durationMs)
    }
    console.log('CLEAN ' + (reading.clean ? 'yes' : 'no'))
    return reading.line ? 0 : 1
}

module.exports = { parseSweepReport, readSweepLeg }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
