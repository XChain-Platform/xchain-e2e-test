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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Disposable MariaDB fixture for L2 multi-hub integration tests.
 *
 * Why: the platform DB user `xchain_hub` lacks CREATE DATABASE, so the
 * MultiValidatorHub harness (which makes one DB per hub) can't run against it.
 * Rather than gate every consensus test on a privileged platform grant — which
 * makes them silently SKIP, reading as "covered" when they aren't — this spins
 * a throwaway root MariaDB in Docker that any test can use anywhere.
 * Ref: claude/reports/2026-05-30_validator-testing-handover.md §4.
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
 *      them as-is — no Docker, no teardown. Zero silent skips in CI.
 *   2. Else, if Docker is available, run a throwaway `mariadb:11`, wait until it
 *      accepts connections, export HUB_DB_* into process.env, and return a
 *      handle whose stop() removes the container.
 *   3. Else return null so the caller can this.skip() cleanly.
 */

const { execFileSync } = require('child_process');
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

// Probe readiness by actually opening a connection (no credentials on any
// command line — the driver handles auth in-process).
async function waitForReady(host, port, pass, attempts = 60) {
    for (let i = 0; i < attempts; i++) {
        let conn;
        try {
            conn = await mariadb.createConnection({ host, port, user: 'root', password: pass, connectTimeout: 2000 });
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
    // (1) Reuse a pre-provisioned DB from env (CI / local platform DB).
    if (process.env.HUB_DB_USER && process.env.HUB_DB_PASS && !opts.forceDocker) {
        return {
            host: process.env.HUB_DB_HOST || '127.0.0.1',
            port: process.env.HUB_DB_PORT || 3306,
            user: process.env.HUB_DB_USER,
            pass: process.env.HUB_DB_PASS,
            disposable: false,
            async stop() {}
        };
    }

    // (2) Self-provision a throwaway container.
    if (!dockerAvailable()) return null;

    const name = opts.name || ('xchain-mvh-testdb-' + process.pid);
    const port = String(opts.port || 13307);
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch (_) {}
    execFileSync('docker', [
        'run', '-d', '--name', name,
        '-e', 'MARIADB_ROOT_PASSWORD=' + TEST_DB_PASS,
        '-p', '127.0.0.1:' + port + ':3306',
        IMAGE
    ], { stdio: 'ignore' });

    const ready = await waitForReady('127.0.0.1', port, TEST_DB_PASS);
    if (!ready) {
        try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch (_) {}
        throw new Error('disposableHubDb: ' + IMAGE + ' did not become ready in time');
    }

    // Export so MultiValidatorHub (and the hub's config layer) pick it up.
    process.env.HUB_DB_HOST = '127.0.0.1';
    process.env.HUB_DB_PORT = port;
    process.env.HUB_DB_USER = 'root';
    process.env.HUB_DB_PASS = TEST_DB_PASS;

    return {
        host: '127.0.0.1', port, user: 'root', pass: TEST_DB_PASS,
        disposable: true,
        async stop() { try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch (_) {} }
    };
}

module.exports = { startDisposableHubDb };
