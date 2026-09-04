'use strict';

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
 * Disposable MariaDB fixture for L2 multi-hub integration tests.
 *
 * Why: the platform DB user `xchain_hub` lacks CREATE DATABASE, so the
 * MultiValidatorHub harness (which makes one DB per hub) can't run against it.
 * Rather than gate every consensus test on a privileged platform grant (which
 * makes them silently SKIP, reading as "covered" when they aren't), this spins
 * a throwaway root MariaDB in Docker that any test can use anywhere.
 *
 * Usage:
 *   const { startDisposableHubDb } = require('../helpers/disposableHubDb');
 *   const db = await startDisposableHubDb();      // null if no DB available
 *   if (!db) this.skip();
 *   // ... MultiValidatorHub now reads HUB_DB_* from env ...
 *   await db.stop();
 *
 * Resolution order:
 *   1. If HUB_DB_USER/HUB_DB_PASS are already in env (CI provisions a DB), use
 *      them as-is with no Docker and no teardown. Zero silent skips in CI.
 *   2. Else, if Docker is available, run a throwaway `mariadb:11`, wait until it
 *      accepts connections, export HUB_DB_* into process.env, and return a
 *      handle whose stop() removes the container.
 *   3. Else return null so the caller can this.skip() cleanly.
 */

const { execFileSync } = require('child_process');
const net = require('net');
const mariadb = require('mariadb');

// Throwaway, non-secret password for an ephemeral local-only test container.
// (Empty-root would be cleaner but the hub's DB layer rejects a blank password.)
const TEST_DB_PASS = 'mvhtest';
const IMAGE        = 'mariadb:11';

function dockerAvailable() {
    try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }); return true; }
    catch (_) { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The first port at or above `base` that nothing is listening on, probed by binding it.
//
// Binding is the only honest test: docker publishes on the host network stack, so a
// port held by another container, or by a process outside docker, is unavailable to us
// either way and only an actual bind sees both. Bounded so a saturated host fails with
// this function's own message rather than looping.
async function firstFreePort(base, span = 64) {
    for (let p = base; p < base + span; p++) {
        const free = await new Promise((resolve) => {
            const probe = net.createServer();
            probe.once('error', () => resolve(false));
            probe.listen(p, '127.0.0.1', () => probe.close(() => resolve(true)));
        });
        if (free) return p;
    }
    throw new Error('disposableHubDb: no free port in [' + base + ', ' + (base + span) + ')');
}

// Probe readiness by actually opening a connection (no credentials on any
// command line; the driver handles auth in-process).
//
// `user` is a parameter rather than a hardcoded 'root' because resolution path (1)
// validates a PRE-PROVISIONED database, whose account is whatever HUB_DB_USER names
// and is routinely not root: the platform's own hub account. Probing that database as
// root with the hub account's password fails authentication, the path judges a healthy
// database dead, and the fallback then tries to bind a container port that is already
// taken, which surfaces as an opaque `docker run` failure several steps later.
async function waitForReady(host, port, pass, attempts = 180, user = 'root') {
    for (let i = 0; i < attempts; i++) {
        let conn;
        try {
            conn = await mariadb.createConnection({ host, port, user, password: pass, connectTimeout: 2000 });
            await conn.query('SELECT 1');
            await conn.end();
            return true;
        } catch (_) {
            if (conn) { try { await conn.end(); } catch (__) {} }
            await sleep(1000);
        }
    }
    return false;
}

async function startDisposableHubDb(opts = {}) {
    // (1) Reuse a pre-provisioned DB from env (CI / local platform DB), but
    // only if it actually answers. A PRIOR suite's self-provisioned DB exports
    // HUB_DB_* into process.env and its stop() removes the container; trusting
    // stale env here pointed every later suite at a dead port and hung its
    // before-all hook until the mocha timeout (suites passed solo, timed out
    // in the full glob run).
    if (process.env.HUB_DB_USER && process.env.HUB_DB_PASS && !opts.forceDocker) {
        const envHost = process.env.HUB_DB_HOST || '127.0.0.1';
        const envPort = process.env.HUB_DB_PORT || 3306;
        const alive = await waitForReady(envHost, envPort, process.env.HUB_DB_PASS, 3,
            process.env.HUB_DB_USER);
        if (alive) {
            return {
                host: envHost,
                port: envPort,
                user: process.env.HUB_DB_USER,
                pass: process.env.HUB_DB_PASS,
                disposable: false,
                async stop() {}
            };
        }
        // Stale env from a torn-down disposable: fall through and self-provision.
    }

    // (2) Self-provision a throwaway container.
    if (!dockerAvailable()) return null;

    const name = opts.name || ('xchain-mvh-testdb-' + process.pid);
    // A caller-named port is honoured as-is so a suite that must be reachable at a
    // fixed coordinate still is; otherwise start at the conventional one and take the
    // first free port above it. A bare literal here cannot survive a standing container
    // already holding that port: the boot aborts with docker's own port-allocation
    // message, which names neither the venue nor what is in the way.
    const port = String(opts.port || (await firstFreePort(13307)));
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch (_) {}
    try {
        execFileSync('docker', [
            'run', '-d', '--name', name,
            '-e', 'MARIADB_ROOT_PASSWORD=' + TEST_DB_PASS,
            '-p', '127.0.0.1:' + port + ':3306',
            // tmpfs datadir: the DB is throwaway by definition, and RAM-backing it
            // cuts MariaDB 11's first-boot "Initializing database files" from 60s+
            // (observed on a loaded host; it blew the old 60s readiness budget) to
            // a few seconds.
            '--tmpfs', '/var/lib/mysql:rw',
            IMAGE
        ], { stdio: 'ignore' });
    } catch (e) {
        throw new Error('disposableHubDb: could not start ' + IMAGE + ' as ' + name +
            ' on 127.0.0.1:' + port + '. If that port is held by a standing container, ' +
            'pass opts.port or provision HUB_DB_* instead. Underlying: ' + e.message);
    }

    const ready = await waitForReady('127.0.0.1', port, TEST_DB_PASS);
    if (!ready) {
        try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch (_) {}
        throw new Error('disposableHubDb: ' + IMAGE + ' did not become ready in time');
    }

    // Export so MultiValidatorHub (and the hub's config layer) pick it up.
    // Remember what we overwrote so stop() can restore it. Leaking these
    // exports poisons the next suite's resolution path (1).
    const prevEnv = {
        HUB_DB_HOST: process.env.HUB_DB_HOST,
        HUB_DB_PORT: process.env.HUB_DB_PORT,
        HUB_DB_USER: process.env.HUB_DB_USER,
        HUB_DB_PASS: process.env.HUB_DB_PASS
    };
    process.env.HUB_DB_HOST = '127.0.0.1';
    process.env.HUB_DB_PORT = port;
    process.env.HUB_DB_USER = 'root';
    process.env.HUB_DB_PASS = TEST_DB_PASS;

    return {
        host: '127.0.0.1', port, user: 'root', pass: TEST_DB_PASS,
        disposable: true,
        async stop() {
            try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch (_) {}
            for (const k of Object.keys(prevEnv)) {
                if (prevEnv[k] === undefined) delete process.env[k];
                else process.env[k] = prevEnv[k];
            }
        }
    };
}

module.exports = { startDisposableHubDb };
