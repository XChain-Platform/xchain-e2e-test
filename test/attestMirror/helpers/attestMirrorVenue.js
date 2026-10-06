'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// A venue probes ports upward from its base and the runner gives each concurrency slot a
// 100-wide window, so two live legs conflict when their windows overlap.
const PORT_WINDOW_SPAN = 100

function claimDir () {
    const dir = process.env.BF_LEG_CLAIM_DIR || path.join(os.tmpdir(), 'xchain-bf-leg-claims')
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

function claimerAlive (pid) {
    try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function liveClaims (dir, except) {
    const out = []
    for (const name of fs.readdirSync(dir)) {
        if (name === except || !name.endsWith('.json')) continue
        let c
        try { c = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) } catch (e) { continue }
        if (!claimerAlive(c.pid)) {
            try { fs.unlinkSync(path.join(dir, name)) } catch (e) { /* another claimer reaped it first */ }
            continue
        }
        out.push(c)
    }
    return out
}

/**
 * Register a leg's isolation claim: its DB label and, for a live leg, its port window.
 * A live AB or BF leg claims both; an offline suite (BF4, BF6) claims a label only, so it
 * can run beside a live leg without sharing a database name or a port with it.
 * The label is claimed with an exclusive create, then the port window is checked against
 * every other live claim; an overlap releases this claim and throws, naming the holder.
 * A claim whose process is gone is reaped, so a crashed leg never blocks the next one.
 *
 * @param {{leg: string, label: string, basePort?: number}} spec  no basePort = offline
 * @returns {{file: string, release: function(): void}}
 */
function claimLegIsolation (spec) {
    assert.ok(spec && spec.leg && spec.label, 'claimLegIsolation: leg and label are required')
    const dir = claimDir()
    const label = String(spec.label).replace(/[^A-Za-z0-9]/g, '').toLowerCase()
    assert.ok(label, 'claimLegIsolation: label ' + spec.label + ' has no usable characters')
    const file = 'label-' + label + '.json'
    const mine = { leg: spec.leg, label, pid: process.pid, basePort: spec.basePort === undefined ? null : Number(spec.basePort) }
    const write = () => fs.writeFileSync(path.join(dir, file), JSON.stringify(mine), { flag: 'wx' })
    try {
        write()
    } catch (e) {
        if (e.code !== 'EEXIST') throw e
        liveClaims(dir, null)
        try { write() } catch (e2) {
            if (e2.code !== 'EEXIST') throw e2
            const held = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            throw new Error('claimLegIsolation: DB label ' + label + ' for ' + spec.leg + ' is held by live leg ' +
                held.leg + ' (pid ' + held.pid + ')')
        }
    }
    const release = () => { try { fs.unlinkSync(path.join(dir, file)) } catch (e) { /* already released */ } }
    if (mine.basePort !== null) {
        const clash = liveClaims(dir, file).find((c) => c.basePort !== null && c.basePort !== undefined &&
            c.basePort < mine.basePort + PORT_WINDOW_SPAN && mine.basePort < c.basePort + PORT_WINDOW_SPAN)
        if (clash) {
            release()
            throw new Error('claimLegIsolation: port window ' + mine.basePort + ' for ' + spec.leg + ' overlaps live leg ' +
                clash.leg + ' at ' + clash.basePort + ' (pid ' + clash.pid + ')')
        }
    }
    return { file, release }
}

/**
 * An offline suite (a BF4 or BF6 case that spawns no venue) claims its DB label only.
 *
 * @param {string} suite  suite name, e.g. bf6
 * @returns {{file: string, release: function(): void}}
 */
function claimOfflineSuite (suite) {
    return claimLegIsolation({ leg: suite + ':offline', label: suite + 'offline' })
}

module.exports = { claimLegIsolation, claimOfflineSuite, PORT_WINDOW_SPAN }
