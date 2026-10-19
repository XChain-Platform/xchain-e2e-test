#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const PAIR = '([^:\\s]+):([^\\s]+)'

function increment (counts, origin, tick) {
    const key = origin + ':' + tick
    counts[key] = (counts[key] || 0) + 1
}

function digestPolicyLog (text, opts = {}) {
    const lines = String(text).replace(ANSI, '').split(/\r?\n/)
    const result = {
        spawns: 0,
        finalized: [],
        finalizedSinceLastSpawn: [],
        roundFailed: {},
        writeFailed: 0,
        declined: {},
        hashMismatch: {},
    }
    let lastSpawn = -1
    for (let index = 0; index < lines.length; index++) {
        if (/^=== \S+ spawn \S+ pid \d+ ===$/.test(lines[index])) {
            result.spawns++
            lastSpawn = index
        }
    }

    const finalized = new RegExp('CrossChainBridge: finalized policy snapshot .*?' +
        PAIR + ' seq (\\d+) \\((\\d+) sigs\\)')
    const roundFailed = new RegExp('CrossChainBridge: policy round failed for ' + PAIR + ':')
    const declined = new RegExp('CrossChainBridge: declining to sign a policy snapshot for ' + PAIR)
    const hashMismatch = new RegExp('CrossChainBridge: gettokenpolicy for ' + PAIR +
        ' returned a policy_hash that does not match')

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        let match = finalized.exec(line)
        if (match && (!opts.tick || match[2] === opts.tick)) {
            const entry = { origin: match[1], tick: match[2], seq: Number(match[3]), sigs: Number(match[4]) }
            result.finalized.push(entry)
            if (lastSpawn >= 0 && index > lastSpawn) result.finalizedSinceLastSpawn.push(entry)
        }
        match = roundFailed.exec(line)
        if (match && (!opts.tick || match[2] === opts.tick)) increment(result.roundFailed, match[1], match[2])
        if (line.includes('CrossChainBridge: finalized policy snapshot write FAILED')) result.writeFailed++
        match = declined.exec(line)
        if (match && (!opts.tick || match[2] === opts.tick)) increment(result.declined, match[1], match[2])
        match = hashMismatch.exec(line)
        if (match && (!opts.tick || match[2] === opts.tick)) increment(result.hashMismatch, match[1], match[2])
    }
    return result
}

function parseArgs (argv) {
    if (argv.length === 0) throw new Error('journal directory is required')
    const options = { directory: argv[0] }
    for (let index = 1; index < argv.length; index++) {
        if (argv[index] !== '--tick' || index + 1 >= argv.length) throw new Error('invalid arguments')
        options.tick = argv[++index]
    }
    return options
}

function countValues (counts) {
    return Object.values(counts).reduce((total, count) => total + count, 0)
}

function listFinalized (entries) {
    if (entries.length === 0) return 'none'
    return entries.map((entry) => entry.origin + ':' + entry.tick + ':' + entry.seq).join(',')
}

function outputLine (file, digest) {
    return 'LOG ' + file + ' spawns=' + digest.spawns +
        ' finalized=' + listFinalized(digest.finalized) +
        ' since_spawn=' + listFinalized(digest.finalizedSinceLastSpawn) +
        ' round_failed=' + countValues(digest.roundFailed) +
        ' write_failed=' + digest.writeFailed +
        ' declined=' + countValues(digest.declined) +
        ' hash_mismatch=' + countValues(digest.hashMismatch)
}

function main (argv) {
    let options
    try {
        options = parseArgs(argv)
        const files = fs.readdirSync(options.directory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
            .map((entry) => entry.name)
            .sort()
        for (const file of files) {
            const text = fs.readFileSync(path.join(options.directory, file), 'utf8')
            console.log(outputLine(file, digestPolicyLog(text, { tick: options.tick })))
        }
        return 0
    } catch {
        return 2
    }
}

module.exports = { digestPolicyLog }

if (require.main === module) process.exitCode = main(process.argv.slice(2))
