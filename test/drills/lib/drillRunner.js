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
 * Launches and drives the drill validators.
 *
 * Local and remote are the same code path: a local node is `node drillNode.js`
 * and a remote node is `ssh box -- node drillNode.js`, both speaking
 * lib/protocol.js over the child's stdio. Nothing in the harness knows which
 * kind it is holding, which is why adding a third box to a drill is an entry
 * in the hosts array and not a new branch here.
 *
 * The harness never sends credentials. A remote node is told the PATH of a
 * credentials file on its own box and reads it itself.
 ********************************************************************/

'use strict';

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { encode, decodeLine, LineSplitter } = require('./protocol');

const LIB_FILES = ['protocol.js', 'liveByzantineFaults.js', 'drillNode.js'];

// Copy the validator half of the harness onto a box. Deliberately plain `cat`
// over ssh rather than rsync or scp: those are not guaranteed present, and a
// drill that cannot deploy is a drill that does not run.
async function deployLib(sshTarget, remoteDir) {
    await sh('ssh', ['-o', 'BatchMode=yes', sshTarget, 'mkdir -p ' + shq(remoteDir)]);
    for (const f of LIB_FILES) {
        const body = fs.readFileSync(path.join(__dirname, f));
        await sh('ssh', ['-o', 'BatchMode=yes', sshTarget, 'cat > ' + shq(path.posix.join(remoteDir, f))], body);
    }
    return remoteDir;
}

function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function sh(cmd, args, stdin) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(cmd + ' exited ' + code + ': ' + err.trim())));
        if (stdin != null) p.stdin.end(stdin); else p.stdin.end();
    });
}

// Build the `KEY=value ... node drillNode.js` command for one validator. No
// secret is ever a member of this map; DRILL_ENV_FILE points at the box's own
// credentials file instead.
function nodeEnv(plan, node, opts) {
    return {
        DRILL_ID:                node.id,
        DRILL_P2P_HOST:          node.address,
        DRILL_P2P_PORT:          String(node.port),
        DRILL_SEEDS:             plan.seedsFor(node.index).join(','),
        DRILL_PRIVKEY_HEX:       opts.identities[node.index].privkeyHex,
        DRILL_VALIDATOR_PUBKEYS: opts.identities.map((i) => i.pubkeyHex).join(','),
        // Index-aligned with the pubkeys above: the pair is what each validator
        // writes into its own registry, so leader rotation resolves.
        DRILL_VALIDATOR_ADDRS:   plan.nodes.map((n) => n.endpoint).join(','),
        DRILL_DB_NAME:           node.dbName,
        DRILL_SNAPSHOT_BLOCK:    String(opts.snapshotBlock || 100),
        DRILL_MAX_CONN_PER_IP:   String(Math.max(64, plan.count * 4)),
        NETWORK:                 opts.network || 'regtest'
    };
}

class NodeHandle {
    constructor(node, child, opts) {
        this.node    = node;
        this.child   = child;
        this.id      = node.id;
        this.ready   = null;
        this.events  = [];
        this.stderr  = '';
        this.exited  = false;
        this._rid    = 0;
        this._pending = new Map();
        this._readyResolve = null;
        this._readyPromise = new Promise((res, rej) => {
            this._readyResolve = res;
            this._readyReject  = rej;
        });
        this._logStream = opts && opts.logStream ? opts.logStream : null;

        const split = new LineSplitter();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            for (const line of split.push(chunk)) this._line(line);
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => {
            this.stderr += d;
            if (this._logStream) this._logStream.write('[' + this.id + '] ' + d);
        });
        child.on('close', (code) => {
            this.exited = true;
            const err = new Error('validator ' + this.id + ' exited (' + code + ')');
            for (const [, p] of this._pending) p.reject(err);
            this._pending.clear();
            this._readyReject(err);
        });
    }

    _line(line) {
        const msg = decodeLine(line);
        if (!msg) {
            // Hub logs and ssh banners land here. Kept, not discarded: a drill
            // that fails is diagnosed from exactly this text.
            if (this._logStream && line.trim()) this._logStream.write('[' + this.id + '] ' + line + '\n');
            return;
        }
        if (msg.ev) {
            this.events.push(msg);
            if (msg.ev === 'ready') { this.ready = msg; this._readyResolve(msg); }
            if (msg.ev === 'error' && !this.ready) this._readyReject(new Error(this.id + ' boot failed: ' + msg.error));
            return;
        }
        const p = this._pending.get(msg.rid);
        if (!p) return;
        this._pending.delete(msg.rid);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(this.id + ' ' + p.cmd + ': ' + msg.error));
    }

    whenReady(timeoutMs) {
        return withTimeout(this._readyPromise, timeoutMs || 120000, this.id + ' never reported ready');
    }

    send(cmd, args, timeoutMs) {
        if (this.exited) return Promise.reject(new Error(this.id + ' has exited'));
        const rid = ++this._rid;
        const p = new Promise((resolve, reject) => this._pending.set(rid, { resolve, reject, cmd }));
        this.child.stdin.write(JSON.stringify({ rid, cmd, args: args || {} }) + '\n');
        return withTimeout(p, timeoutMs || 60000, this.id + ' did not answer ' + cmd);
    }

    async kill() {
        if (this.exited) return;
        try { await this.send('stop', {}, 15000); } catch (e) { /* forced below */ }
        try { this.child.kill('SIGTERM'); } catch (e) { /* already gone */ }
    }
}

function withTimeout(promise, ms, label) {
    let t;
    return Promise.race([
        promise.finally(() => clearTimeout(t)),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout: ' + label + ' after ' + ms + 'ms')), ms); })
    ]);
}

/**
 * Bring up every validator in a plan.
 *
 * @param {object} plan          from lib/drillPlan.planDrill
 * @param {object} opts
 * @param {Array}  opts.identities  [{ pubkeyHex, privkeyHex }] one per validator
 * @param {string} [opts.remoteDir] where to stage the harness on remote boxes
 * @param {object} [opts.logStream] writable that receives all child output
 */
async function startMesh(plan, opts) {
    if (!opts || !Array.isArray(opts.identities) || opts.identities.length < plan.count) {
        throw new Error('startMesh: need one identity per validator (' + plan.count + ')');
    }
    const remoteDir = opts.remoteDir || ('/tmp/xchain-drill-' + Date.now());
    const deployed  = new Set();
    const handles   = [];

    for (const node of plan.nodes) {
        const host = plan.hosts[node.hostIndex];
        const env  = nodeEnv(plan, node, opts);
        if (host.envFile) env.DRILL_ENV_FILE = host.envFile;
        if (host.hubPath) env.DRILL_HUB_PATH = host.hubPath;
        if (opts.fake)    env.DRILL_FAKE_HUB = '1';

        let child;
        if (host.ssh) {
            if (!deployed.has(host.ssh)) { await deployLib(host.ssh, remoteDir); deployed.add(host.ssh); }
            const assigns = Object.entries(env).map(([k, v]) => k + '=' + shq(v)).join(' ');
            const remoteCmd = 'env ' + assigns + ' ' + shq(host.nodePath) + ' ' + shq(path.posix.join(remoteDir, 'drillNode.js'));
            child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', host.ssh, remoteCmd],
                { stdio: ['pipe', 'pipe', 'pipe'] });
        } else {
            child = spawn(host.nodePath, [path.join(__dirname, 'drillNode.js')],
                { stdio: ['pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, env) });
        }
        handles.push(new NodeHandle(node, child, { logStream: opts.logStream }));
    }

    // Boot failures surface as a rejected whenReady; tear the whole mesh down
    // rather than leaving half a federation running on someone's box.
    try {
        await Promise.all(handles.map((h) => h.whenReady(opts.readyTimeoutMs || 180000)));
    } catch (e) {
        await Promise.all(handles.map((h) => h.kill().catch(() => {})));
        throw e;
    }

    return {
        plan,
        handles,
        byId: (id) => handles.find((h) => h.id === id),
        honest:    () => handles.filter((h) => h.node.role === 'honest'),
        byzantine: () => handles.filter((h) => h.node.role === 'byzantine'),
        async stop() {
            await Promise.all(handles.map((h) => h.kill().catch(() => {})));
            // Take the staged harness back off every box. Cheap, and it keeps a
            // shared venue from accumulating a /tmp dir per drill run.
            await Promise.all([...deployed].map((target) =>
                sh('ssh', ['-o', 'BatchMode=yes', target, 'rm -rf ' + shq(remoteDir)]).catch(() => {})));
        }
    };
}

module.exports = { startMesh, deployLib, nodeEnv, NodeHandle, withTimeout, LIB_FILES };
