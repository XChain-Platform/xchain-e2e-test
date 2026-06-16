#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Post-deploy smoke check — verifies every running xchain service is up AND serving its JSON-RPC
 * `ping` across all coin/network combos on THIS host. Dependency-free (node built-ins only) so it
 * can be scp'd to any box and run with `node smoke.js`.
 *
 * Discovers services from `docker ps` (no hard-coded ports / combos), reads each container's
 * published host port, and POSTs a JSON-RPC ping. Exits non-zero if any service fails — suitable
 * as a deploy gate. Would have flagged today's encoder + utxo-tracker outages in seconds.
 *
 * Usage:  node smoke.js            (check local docker)
 *         ssh <host> 'node smoke.js'   (check a remote box)
 */
const { execSync } = require('child_process')
const http = require('http')

// Services that expose a JSON-RPC `ping`. (node coin-daemons + database are infra, not checked.)
const PINGABLE = ['xchain-decoder', 'xchain-indexer', 'xchain-utxo-tracker', 'xchain-encoder', 'xchain-explorer', 'xchain-hub']

function sh(cmd) { return execSync(cmd, { encoding: 'utf8' }).trim() }

// Map each running xchain service container → { name, coin, network, service, port }.
function discover() {
    const names = sh('docker ps --format "{{.Names}}"').split('\n').filter(Boolean)
    const out = []
    for (const name of names) {
        const svc = PINGABLE.find(s => name.endsWith(s))
        if (!svc) continue
        // name pattern: xchain-node-<coin>-<network>-<service>  OR  xchain-node-xchain-hub
        let coin = '-', network = '-'
        const m = name.match(/^xchain-node-([a-z]+)-([a-z]+)-xchain-/)
        if (m) { coin = m[1]; network = m[2] }
        // Published host port for the container's exposed TCP port.
        let port = null
        try {
            const ports = JSON.parse(sh(`docker inspect -f '{{json .NetworkSettings.Ports}}' ${name}`))
            for (const k of Object.keys(ports)) {
                if (ports[k] && ports[k][0] && ports[k][0].HostPort) { port = Number(ports[k][0].HostPort); break }
            }
        } catch (e) { /* no published port */ }
        out.push({ name, coin, network, service: svc.replace('xchain-', ''), port })
    }
    return out
}

function ping(port) {
    return new Promise((resolve) => {
        if (!port) return resolve({ ok: false, detail: 'no published port' })
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
        const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000 },
            (res) => {
                let data = ''
                res.on('data', c => data += c)
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve({ ok: false, detail: 'HTTP ' + res.statusCode })
                    try {
                        const j = JSON.parse(data)
                        if (j.error) return resolve({ ok: false, detail: 'rpc error ' + (j.error.code || '') })
                        return resolve({ ok: true, detail: (j.result && j.result.status) || 'ok' })
                    } catch (e) { return resolve({ ok: false, detail: 'bad json' }) }
                })
            })
        req.on('error', e => resolve({ ok: false, detail: e.code || e.message }))
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, detail: 'timeout' }) })
        req.write(body); req.end()
    })
}

;(async () => {
    const host = sh('hostname')
    const svcs = discover().sort((a, b) => (a.coin + a.network + a.service).localeCompare(b.coin + b.network + b.service))
    if (!svcs.length) { console.error('No xchain service containers found.'); process.exit(2) }
    let failed = 0
    console.log(`Smoke check on ${host} — ${svcs.length} services\n`)
    for (const s of svcs) {
        const r = await ping(s.port)
        if (!r.ok) failed++
        const label = `${s.coin}/${s.network}`.padEnd(20) + s.service.padEnd(16)
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${label} :${s.port || '-'}  ${r.detail}`)
    }
    console.log(`\n${svcs.length - failed}/${svcs.length} healthy` + (failed ? ` — ${failed} FAILED` : ' — all green'))
    process.exit(failed ? 1 : 0)
})()
