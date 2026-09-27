#!/usr/bin/env node
'use strict'

const fs = require('fs')

const { triageJournal } = require('../../../scripts/rail_journal_triage')
const { RAIL_DRIVES } = require('../bridge_rail_legs')

function railLeg (drive, leg, drives) {
    const hasDrive = drives && Object.prototype.hasOwnProperty.call(drives, drive)
    if (!hasDrive) throw new Error('unknown bridge rail drive: ' + String(drive))
    const driveConfig = drives[drive]
    const hasLeg = driveConfig.legs &&
        Object.prototype.hasOwnProperty.call(driveConfig.legs, leg)
    if (!hasLeg) throw new Error('unknown ' + drive + ' bridge rail leg: ' + String(leg))
    return driveConfig.legs[leg]
}

function matchingJournal (journalText, grep) {
    const pattern = grep === null ? null : new RegExp(grep)
    const matches = []
    for (const journalLine of String(journalText).split(/\r?\n/)) {
        let entry
        try {
            entry = JSON.parse(journalLine)
        } catch {
            continue
        }
        if (!pattern || (entry && typeof entry.title === 'string' &&
            pattern.test(entry.title))) matches.push(journalLine)
    }
    return matches
}

function readJournalLeg (journalText, drive, leg, drives = RAIL_DRIVES) {
    const legConfig = railLeg(drive, leg, drives)
    const matches = matchingJournal(journalText, legConfig.grep)
    if (matches.length === 0) return { line: null, clean: false, rootFailures: [] }
    const triage = triageJournal(matches.join('\n'), { minPassed: legConfig.minPassed })
    const verdict = triage.failed === 0 && triage.passed >= legConfig.minPassed
        ? 'PASS' : 'FAIL'
    const line = {
        drive,
        leg,
        verdict,
        passed: triage.passed,
        failed: triage.failed,
        root: triage.root,
        cascade: triage.cascade,
        missing: Math.max(0, legConfig.minPassed - triage.passed - triage.failed),
    }
    const clean = verdict === 'PASS' ||
        (verdict === 'FAIL' && line.failed >= 1 && line.root === 0)
    const rootFailures = triage.rootFailures.map(({ title, durationMs }) => ({
        title,
        durationMs,
    }))
    return { line, clean, rootFailures }
}

function parseArgs (argv) {
    const options = {}
    const names = { '--journal': 'journal', '--drive': 'drive', '--leg': 'leg' }
    for (let index = 0; index < argv.length; index++) {
        const name = names[argv[index]]
        if (!name) throw new Error('unknown flag: ' + argv[index])
        if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
            throw new Error(argv[index] + ' requires a value')
        }
        options[name] = argv[++index]
    }
    for (const required of Object.keys(names)) {
        if (!options[names[required]]) throw new Error(required + ' is required')
    }
    return options
}

function legLine (line) {
    return 'LEG ' + line.drive + ' ' + line.leg + ' ' + line.verdict +
        ' passed=' + line.passed + ' failed=' + line.failed +
        ' root=' + line.root + ' cascade=' + line.cascade +
        ' missing=' + line.missing
}

function readJournal (journalPath) {
    return fs.readFileSync(journalPath === '-' ? 0 : journalPath, 'utf8')
}

function main (argv) {
    let options
    try {
        options = parseArgs(argv)
    } catch (error) {
        console.error(error.message)
        return 2
    }
    let journalText
    try {
        journalText = readJournal(options.journal)
    } catch {
        console.error('cannot read journal')
        return 2
    }
    let reading
    try {
        reading = readJournalLeg(journalText, options.drive, options.leg)
    } catch (error) {
        console.error(error.message)
        return 2
    }
    console.log(reading.line ? legLine(reading.line) :
        'LEG ' + options.drive + ' ' + options.leg + ' ABSENT')
    for (const failure of reading.rootFailures) {
        console.log('ROOT ' + failure.title + ' durationMs=' + failure.durationMs)
    }
    console.log('CLEAN ' + (reading.clean ? 'yes' : 'no'))
    return reading.line ? 0 : 1
}

module.exports = { readJournalLeg }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
