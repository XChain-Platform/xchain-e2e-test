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
 * Harness self-test: the control plane, exercised against REAL child
 * processes running lib/drillNode.js in its no-hub mode.
 *
 * This proves the plumbing the physical drill rides on (spawn, the line
 * protocol, request/response correlation, fault commands, teardown) without a
 * database, a network mesh or a venue. It proves NOTHING about consensus: the
 * fake validator has none, which is exactly why the drill refuses to grade a
 * run against it. Keeping the plumbing honest here is what stops a venue
 * window being burned on a harness bug.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { planDrill } = require('../lib/drillPlan');
const { startMesh, nodeEnv } = require('../lib/drillRunner');
const { encode, decodeLine, LineSplitter, TAG } = require('../lib/protocol');

function fakeIdentities(n) {
    return Array.from({ length: n }, (_, i) => ({
        privkeyHex: String(i).padStart(2, '0').repeat(32).slice(0, 64),
        pubkeyHex:  'pub' + i
    }));
}

function localPlan(count) {
    return planDrill({
        count,
        hosts: [{ id: 'local', advertise: '127.0.0.1', ssh: null, nodePath: process.execPath }],
        allowSingleHost: true,
        basePort: 45000,
        runId: 'selftest' + process.pid
    });
}

describe('drill protocol', function () {
    it('round-trips a tagged object', function () {
        assert.deepStrictEqual(decodeLine(encode({ a: 1, b: 'x' })), { a: 1, b: 'x' });
    });

    it('ignores hub logs and ssh banners rather than choking on them', function () {
        assert.strictEqual(decodeLine('Warning: Permanently added host to known hosts.'), null);
        assert.strictEqual(decodeLine('P2P: peer connected 10.0.0.2:41001'), null);
        assert.strictEqual(decodeLine(''), null);
        assert.strictEqual(decodeLine(null), null);
    });

    it('drops a corrupt tagged line instead of throwing mid-drill', function () {
        assert.strictEqual(decodeLine(TAG + ' {not json'), null);
        assert.strictEqual(decodeLine(TAG + ' '), null);
        assert.strictEqual(decodeLine(TAG + ' "a string"'), null);
    });

    it('finds the tag even when ssh prefixed the line', function () {
        assert.deepStrictEqual(decodeLine('stdout: ' + TAG + ' {"ev":"ready"}'), { ev: 'ready' });
    });

    it('reassembles lines split across arbitrary chunk boundaries', function () {
        const s = new LineSplitter();
        assert.deepStrictEqual(s.push('one\ntw'), ['one']);
        assert.deepStrictEqual(s.push('o\nthree'), ['two']);
        assert.deepStrictEqual(s.flush(), ['three']);
        assert.deepStrictEqual(s.flush(), []);
    });
});

describe('drillRunner: node environment', function () {
    it('gives each validator the other validators as seeds and never a credential', function () {
        const plan = localPlan(4);
        const env  = nodeEnv(plan, plan.nodes[1], { identities: fakeIdentities(4) });
        assert.strictEqual(env.DRILL_ID, 'v1');
        assert.strictEqual(env.DRILL_SEEDS.split(',').length, 3);
        assert.ok(!env.DRILL_SEEDS.includes(plan.nodes[1].endpoint));
        assert.strictEqual(env.DRILL_VALIDATOR_PUBKEYS.split(',').length, 4);
        // Pubkeys and addresses must stay index-aligned; a shifted pair
        // registers each validator under a peer's address and leader rotation
        // silently elects nobody.
        assert.deepStrictEqual(env.DRILL_VALIDATOR_ADDRS.split(','), plan.nodes.map((n) => n.endpoint));
        // Credentials are read by the far box from its own file; nothing here
        // may carry a password, which is what keeps them out of drill logs.
        assert.ok(!('HUB_DB_PASS' in env) && !('HUB_DB_USER' in env));
    });

    it('refuses to start a mesh with fewer identities than validators', async function () {
        await assert.rejects(
            startMesh(localPlan(4), { identities: fakeIdentities(3), fake: true }),
            /need one identity per validator/
        );
    });
});

describe('drillRunner: real child processes (no hub)', function () {
    this.timeout(60000);
    let mesh;

    before(async function () {
        mesh = await startMesh(localPlan(4), { identities: fakeIdentities(4), fake: true, readyTimeoutMs: 30000 });
    });

    after(async function () {
        if (mesh) await mesh.stop();
    });

    it('boots one OS process per validator and each announces itself', function () {
        assert.strictEqual(mesh.handles.length, 4);
        const pids = mesh.handles.map((h) => h.ready.pid);
        assert.strictEqual(new Set(pids).size, 4, 'validators are sharing a process');
        assert.deepStrictEqual(mesh.handles.map((h) => h.id), ['v0', 'v1', 'v2', 'v3']);
    });

    it('correlates concurrent commands to the right answers', async function () {
        const answers = await Promise.all(mesh.handles.map((h) => h.send('hello')));
        assert.deepStrictEqual(answers.map((a) => a.id), ['v0', 'v1', 'v2', 'v3']);
    });

    it('carries fault commands into the child and back out again', async function () {
        const v0 = mesh.byId('v0');
        assert.deepStrictEqual(await v0.send('fault', { mode: 'silent' }), { mode: 'silent' });
        // A silenced validator declines to act on a proposal, which is what the
        // liveness phase relies on to hold the honest set to exactly quorum.
        assert.strictEqual((await v0.send('propose', { values: { k: '1' } })).accepted, false);
        await v0.send('fault', { mode: 'none' });
        assert.strictEqual((await v0.send('propose', { values: { k: '1' } })).accepted, true);
        assert.strictEqual((await v0.send('getConfig', { key: 'k' })).value, '1');
    });

    it('reports an unknown command as an error instead of hanging the drill', async function () {
        await assert.rejects(mesh.byId('v1').send('nonsense'), /unknown command nonsense/);
    });

    it('splits the mesh into honest and byzantine as the plan laid it out', function () {
        assert.strictEqual(mesh.byzantine().length, 1);
        assert.strictEqual(mesh.honest().length, 3);
    });

    it('times out a command rather than waiting forever on a wedged box', async function () {
        const v2 = mesh.byId('v2');
        const orig = v2.child.stdin.write;
        v2.child.stdin.write = () => true;          // the command never reaches the child
        try {
            await assert.rejects(v2.send('hello', {}, 250), /timeout: v2 did not answer hello/);
        } finally {
            v2.child.stdin.write = orig;
        }
    });
});

describe('drillRunner: teardown', function () {
    this.timeout(60000);

    it('leaves no validator process behind', async function () {
        const mesh = await startMesh(localPlan(4), { identities: fakeIdentities(4), fake: true, readyTimeoutMs: 30000 });
        const children = mesh.handles.map((h) => h.child);
        await mesh.stop();
        await new Promise((r) => setTimeout(r, 500));
        for (const c of children) {
            assert.ok(c.exitCode !== null || c.signalCode !== null, 'a validator survived teardown');
        }
    });

    it('a validator whose control channel drops shuts itself down', async function () {
        const mesh = await startMesh(localPlan(4), { identities: fakeIdentities(4), fake: true, readyTimeoutMs: 30000 });
        const v3 = mesh.byId('v3');
        const exited = new Promise((res) => v3.child.on('close', res));
        v3.child.stdin.end();                        // the harness died, or ssh dropped
        await exited;
        assert.ok(v3.exited, 'an orphaned validator kept running on the box');
        await mesh.stop();
    });
});
