'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const net = require('net')

function portFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => srv.close(() => resolve(true)));
        srv.listen(port, '127.0.0.1');
    });
}

// A spawned hub cannot answer JSON-RPC until its HTTP server is listening. Probe
// that lifecycle boundary without using XChainHubConnector: the connector logs a
// full warning and Axios stack for every expected ECONNREFUSED while the child is
// still migrating its fresh database, making a normal boot look like a failed
// endpoint on the rail. The real connector ping follows once the listener exists.
function processListening(proc, host, port) {
    if (proc && (proc.exitCode !== null || proc.signalCode !== null)) {
        return Promise.resolve({ ok: false, dead: true });
    }
    return new Promise((resolve) => {
        let settled = false;
        const socket = net.createConnection({ host: host, port: port });
        const finish = (result) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(1000);
        socket.once('connect', () => finish({ ok: true }));
        socket.once('error', () => finish({ ok: false }));
        socket.once('timeout', () => finish({ ok: false }));
    });
}

// The kernel's OUTBOUND port range. A port inside it is free when probed and
// taken a moment later by some other socket the run opens, and the child then
// dies on listen EADDRINUSE; multiValidatorHubHelper documents the same lottery
// at length. Linux publishes the range; elsewhere use the common default.
function ephemeralRange() {
    try {
        const [lo, hi] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
            .trim().split(/\s+/).map(Number);
        if (Number.isInteger(lo) && Number.isInteger(hi) && lo < hi) return { lo, hi };
    } catch (internal) { /* not Linux, or a locked-down /proc */ }
    return { lo: 32768, hi: 60999 };
}

// Probe upward from `base` for `count` free ports, never handing back one inside
// the ephemeral range. A base inside the range jumps ABOVE it rather than below,
// because below is where the other suites' hand-assigned bases live.
async function pickFreePorts(count, base) {
    const eph = ephemeralRange();
    let p = (base >= eph.lo && base <= eph.hi) ? eph.hi + 1 : base;
    const picked = [];
    for (let tries = 0; picked.length < count && tries < 2000 && p < 65535; tries++) {
        if (p >= eph.lo && p <= eph.hi) { p = eph.hi + 1; continue; }
        if (await portFree(p)) picked.push(p);
        p++;
    }
    if (picked.length < count) throw new Error('oracleBatchReplay: not enough free ports near ' + base);
    return picked;
}

module.exports = { pickFreePorts, processListening }
