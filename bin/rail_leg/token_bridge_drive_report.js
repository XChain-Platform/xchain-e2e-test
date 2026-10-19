#!/usr/bin/env node
'use strict'

const fs = require('fs')

const { triageJournal } = require('../rail_journal_triage')
const { RAIL_DRIVES } = require('../../test/helpers/bridge_rail_legs')

const FLAGS = [
    '--token-journal',
    '--base-journal',
    '--platform-head',
    '--indexer-head',
    '--e2e-head',
    '--date',
    '--out',
]

function requireString (value, field, pattern) {
    if (typeof value !== 'string' || value.length === 0 || (pattern && !pattern.test(value))) {
        throw new TypeError(field + ' is required')
    }
}

function validateReport (input) {
    if (!input || typeof input !== 'object') throw new TypeError('report input is required')
    requireString(input.date, 'date', /^\d{4}-\d{2}-\d{2}$/)
    if (!input.heads || typeof input.heads !== 'object') throw new TypeError('heads is required')
    requireString(input.heads.platform, 'heads.platform')
    requireString(input.heads.indexer, 'heads.indexer')
    requireString(input.heads.e2eTest, 'heads.e2eTest')
    if (!input.token || typeof input.token !== 'object') throw new TypeError('token is required')
    if (!input.base || typeof input.base !== 'object') throw new TypeError('base is required')
}

function failureName (result) {
    const value = result.rootFailures && result.rootFailures.length
        ? result.rootFailures[0].title
        : result.reason
    return oneLine(value)
}

function oneLine (value) {
    return String(value === undefined ? '' : value).replace(/[\r\n]+/g, ' ')
}

function driveLines (name, result) {
    const verdict = result.pass ? 'PASS' : 'FAIL (' + failureName(result) + ')'
    const lines = [name + ' drive: ' + verdict]
    lines.push(name + ' counts: passed=' + result.passed + ' failed=' + result.failed +
        ' root=' + result.root + ' cascade=' + result.cascade + ' other=' + result.other +
        ' malformed=' + result.malformed)
    for (const failure of result.rootFailures || []) {
        lines.push(name + ' root failure: ' + oneLine(failure.title) + ' | ' + oneLine(failure.error))
    }
    return lines
}

function renderDriveReport (input) {
    validateReport(input)
    const lines = [
        '# Token bridge rail drive',
        '',
        'date: ' + input.date,
        'platform head: ' + input.heads.platform,
        'indexer head: ' + input.heads.indexer,
        'e2e-test head: ' + input.heads.e2eTest,
        '',
        ...driveLines('token', input.token),
        '',
        ...driveLines('base', input.base),
    ]
    return lines.join('\n') + '\n'
}

function parseArgs (argv) {
    const options = {}
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]
        if (!FLAGS.includes(flag) || i + 1 >= argv.length) {
            throw new Error(flag + ' is unknown or missing a value')
        }
        options[flag] = argv[++i]
    }
    for (const flag of FLAGS) {
        if (!options[flag]) throw new Error(flag + ' is required')
    }
    return options
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

function readDrive (journalPath, minPassed) {
    try {
        return triageJournal(fs.readFileSync(journalPath, 'utf8'), { minPassed })
    } catch {
        return noJournal()
    }
}

function main (argv) {
    let options
    try {
        options = parseArgs(argv)
    } catch (error) {
        process.stderr.write('usage error: ' + error.message + '\n')
        return 2
    }
    const token = readDrive(options['--token-journal'], RAIL_DRIVES.token.legs.full.minPassed)
    const base = readDrive(options['--base-journal'], RAIL_DRIVES.base.legs.full.minPassed)
    const report = renderDriveReport({
        date: options['--date'],
        heads: {
            platform: options['--platform-head'],
            indexer: options['--indexer-head'],
            e2eTest: options['--e2e-head'],
        },
        token,
        base,
    })
    fs.writeFileSync(options['--out'], report)
    return token.pass && base.pass ? 0 : 1
}

module.exports = { main, renderDriveReport }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
