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

const CLAIMER = [
    'const v = require(process.argv[1])',
    'const spec = JSON.parse(process.argv[2])',
    'try {',
    '    const c = spec.offline ? v.claimOfflineSuite(spec.leg) : v.claimLegIsolation(spec)',
    "    process.stdout.write('CLAIMED ' + c.file + '\\n')",
    "    if (spec.hold) { process.stdin.resume(); process.stdin.on('end', () => { c.release(); process.exit(0) }) } else { c.release() }",
    "} catch (e) { process.stdout.write('REFUSED ' + e.message + '\\n'); process.exit(3) }",
].join('\n')

function runClaimer (dir, spec) {
    const child = require('child_process').spawn(process.execPath, ['-e', CLAIMER, __filename, JSON.stringify(spec)], {
        env: Object.assign({}, process.env, { BF_LEG_CLAIM_DIR: dir }), stdio: ['pipe', 'pipe', 'inherit'],
    })
    const first = new Promise((resolve) => {
        let out = ''
        child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.trim()) })
        child.on('exit', () => resolve(out.trim() || 'EXITED'))
    })
    const stop = () => new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.on('exit', resolve)
        child.stdin.end()
    })
    return { child, first, stop }
}

/**
 * Prove isolation with real concurrent claimers, each a separate process: a live AB leg and a
 * live BF leg hold their claims while the BF4 and BF6 offline suites register beside them, then
 * a duplicate label, an overlapping port window and a duplicate offline suite are each refused.
 * Resolves with the evidence lines and throws on the first violated expectation.
 *
 * @param {{basePort?: number}} [opts]
 * @returns {Promise<string[]>}
 */
async function proveConcurrentIsolation (opts) {
    const base = (opts && opts.basePort) || 18000
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bf-iso-'))
    const held = []
    const evidence = []
    const count = () => fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length
    const expect = (cond, msg) => { evidence.push((cond ? 'ok ' : 'FAIL ') + msg); assert.ok(cond, msg) }
    const attempt = (spec) => runClaimer(dir, spec).first
    try {
        const specs = [
            { leg: 'ab-live', label: 'ablive', basePort: base, hold: true },
            { leg: 'bf-live', label: 'bflive', basePort: base + PORT_WINDOW_SPAN, hold: true },
            { leg: 'bf4', offline: true, hold: true },
            { leg: 'bf6', offline: true, hold: true },
        ]
        const runs = specs.map((spec) => runClaimer(dir, spec))
        held.push(...runs)
        const firsts = await Promise.all(runs.map((r) => r.first))
        firsts.forEach((out, i) => expect(out.startsWith('CLAIMED'), specs[i].leg + ' registered beside the others: ' + out))
        const claims = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
            .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')))
        expect(claims.length === 4 && new Set(claims.map((c) => c.label)).size === 4, 'four concurrent claims on distinct DB labels')
        expect(new Set(claims.map((c) => c.pid)).size === 4, 'four distinct claimer processes')
        expect(claims.filter((c) => c.basePort === null).length === 2, 'the BF4 and BF6 claims carry no port window')
        expect((await attempt({ leg: 'ab-dup', label: 'ablive', basePort: base + 500 })).startsWith('REFUSED'), 'a second leg on the live AB label is refused')
        expect((await attempt({ leg: 'bf-clash', label: 'bfother', basePort: base + 150 })).startsWith('REFUSED'), 'an overlapping port window is refused')
        expect((await attempt({ leg: 'bf6', offline: true })).startsWith('REFUSED'), 'a second BF6 offline claim is refused')
        expect(count() === 4, 'refused claimers left no claim behind')
        expect((await attempt({ leg: 'bf-free', label: 'bffree', basePort: base + 2 * PORT_WINDOW_SPAN })).startsWith('CLAIMED'), 'a non-overlapping leg is admitted')
        await Promise.all(held.map((h) => h.stop()))
        held.length = 0
        expect(count() === 0, 'every claim released on exit')
        return evidence
    } finally {
        await Promise.all(held.map((h) => h.stop()))
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

if (require.main === module) {
    proveConcurrentIsolation().then((ev) => { ev.forEach((l) => console.log(l)) }, (e) => { console.error(e.message); process.exit(1) })
}

module.exports = { claimLegIsolation, claimOfflineSuite, proveConcurrentIsolation, PORT_WINDOW_SPAN }
