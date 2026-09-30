#!/usr/bin/env node
'use strict'

// Classifier half of the base drive's AT6 surplus case: grades the recorded hub answer
// with the platform watch script, which only the platform checkout above this repo has.
// Usage: node scripts/rail_leg/rail_watch_verdict.js --journal <case-journal.jsonl> [--watch <xchain-watch.js>]
// Exit 0 PASS, 1 FAIL, 2 when the input or the classifier cannot be read.

const fs = require('fs')
const path = require('path')

const WATCH_INPUT_TITLE = '=== AT6 watch input ==='
const DEFAULT_WATCH = path.resolve(__dirname, '..', '..', '..', 'claude', 'scripts', 'xchain-watch.js')

// The last recorded input wins, as a rerun's journal line replaces the earlier one.
function watchInputFrom (journalText) {
    let input = null
    for (const line of String(journalText).split(/\r?\n/)) {
        let entry
        try {
            entry = JSON.parse(line)
        } catch {
            continue
        }
        if (entry && entry.title === WATCH_INPUT_TITLE && entry.evidence) input = entry.evidence
    }
    return input
}

function watchVerdict (input, watch) {
    const items = watch.bridgeInvariantVerdicts(input.reports)
    const found = items.filter((item) => item.tick === input.tick && item.chain === input.chain)
    const seen = found.map((item) => item.sev + '/' + item.kind).join(', ') || 'none'
    let reason = ''
    if (found.length !== 1) reason = 'expected one watch item for ' + input.tick + ' on ' + input.chain + ', got ' + seen
    else if (found[0].sev !== 'warn') reason = 'the watch raised ' + seen + ' where D65 requires warn'
    else if (found[0].kind !== 'BRIDGE_INVARIANT_SURPLUS') reason = 'the watch raised ' + seen + ' where D65 requires BRIDGE_INVARIANT_SURPLUS'
    return { pass: reason === '', reason, seen }
}

function parseArgs (argv) {
    const options = { watch: DEFAULT_WATCH }
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--journal' && i + 1 < argv.length) options.journal = argv[++i]
        else if (argv[i] === '--watch' && i + 1 < argv.length) options.watch = argv[++i]
        else throw new Error('unknown or incomplete argument: ' + argv[i])
    }
    if (!options.journal) throw new Error('--journal is required')
    return options
}

function main (argv) {
    let options
    let input
    let watch
    try {
        options = parseArgs(argv)
        input = watchInputFrom(fs.readFileSync(options.journal, 'utf8'))
        if (!input) throw new Error('no "' + WATCH_INPUT_TITLE + '" line in ' + options.journal)
        watch = require(path.resolve(options.watch))
        if (typeof watch.bridgeInvariantVerdicts !== 'function') {
            throw new Error(options.watch + ' exports no bridgeInvariantVerdicts')
        }
    } catch (error) {
        console.log('CASE at6-d65-watch: ERROR ' + error.message)
        return 2
    }
    const verdict = watchVerdict(input, watch)
    console.log('CASE at6-d65-watch: ' + (verdict.pass ? 'PASS ' + verdict.seen : 'FAIL ' + verdict.reason) +
        ' (hub ' + JSON.stringify(input.reports[0].byTick[input.tick][input.chain]) + ')')
    return verdict.pass ? 0 : 1
}

module.exports = { WATCH_INPUT_TITLE, watchInputFrom, watchVerdict }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
