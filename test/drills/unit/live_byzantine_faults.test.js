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
 * Unit tests for the in-process-of-the-VICTIM byzantine injectors.
 *
 * Driven against duck-typed stand-ins for the hub, so the rules that decide
 * WHAT gets corrupted are pinned without a database or a network. The point
 * being defended: a forging validator must stay CONNECTED and keep voting.
 * If the injector corrupted transport auth too, peers would drop it and the
 * drill would silently degrade into a crash-fault test, which is a strictly
 * weaker adversary than the one the threat model asks about.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();
const byz = require('../lib/liveByzantineFaults');

function fakeHub() {
    const sent = [];
    const hub = {
        consensus: {
            handled: [],
            handleMessage(m) { this.handled.push(m); },
            digest: (c) => 'digest:' + JSON.stringify(c),
            peerManager: { validatorAddr: '10.0.0.1:41000' }
        },
        peerManager: {
            validatorAddr: '10.0.0.1:41000',
            buildEnvelope(type, data) {
                const env = { type, data, sender: this.validatorAddr, sig: 'ab'.repeat(63) + 'c4', sig_pubkey: 'pub' };
                sent.push(env);
                return env;
            }
        }
    };
    return { hub, sent };
}

describe('liveByzantineFaults: what counts as consensus traffic', function () {
    it('forges the whole PBFT family and nothing else', function () {
        for (const t of ['PBFT_PRE_PREPARE', 'PBFT_PREPARE', 'PBFT_COMMIT', 'PBFT_VIEW_CHANGE', 'PBFT_NEW_VIEW']) {
            assert.strictEqual(byz.shouldForge(t), true, t + ' should be forged');
        }
        for (const t of ['HEARTBEAT', 'HANDSHAKE', 'GOV_PROPOSE', 'ATTEST_PREPARE', '', null, undefined]) {
            assert.strictEqual(byz.shouldForge(t), false, String(t) + ' must not be forged');
        }
    });
});

describe('liveByzantineFaults: signature corruption', function () {
    it('produces a different signature of the same length', function () {
        const sig = 'ab'.repeat(63) + 'c4';
        const bad = byz.corruptSignature(sig);
        assert.notStrictEqual(bad, sig);
        assert.strictEqual(bad.length, sig.length);
        assert.match(bad, /^[0-9a-f]+$/);
    });

    it('is deterministic, so a drill result reproduces', function () {
        assert.strictEqual(byz.corruptSignature('00ff'), byz.corruptSignature('00ff'));
    });

    it('leaves an empty or absent signature alone rather than inventing one', function () {
        assert.strictEqual(byz.corruptSignature(''), '');
        assert.strictEqual(byz.corruptSignature(null), null);
    });
});

describe('liveByzantineFaults: silenceConsensus', function () {
    it('drops every consensus message while the listener stays attached', function () {
        const { hub } = fakeHub();
        const listener = (m) => hub.consensus.handleMessage(m);   // the arrow Consensus.start registers
        listener({ type: 'PBFT_PREPARE' });
        assert.strictEqual(hub.consensus.handled.length, 1);

        const restore = byz.silenceConsensus(hub);
        listener({ type: 'PBFT_PREPARE' });
        listener({ type: 'PBFT_COMMIT' });
        assert.strictEqual(hub.consensus.handled.length, 1, 'a silenced node reacted to consensus traffic');

        restore();
        listener({ type: 'PBFT_COMMIT' });
        assert.strictEqual(hub.consensus.handled.length, 2, 'restore() did not put the node back');
    });

    it('refuses a hub with no consensus engine instead of silently doing nothing', function () {
        assert.throws(() => byz.silenceConsensus({}), /no started consensus engine/);
    });
});

describe('liveByzantineFaults: forgeConsensusSignatures', function () {
    it('corrupts PBFT signatures and leaves transport traffic verifiable', function () {
        const { hub } = fakeHub();
        const honest = hub.peerManager.buildEnvelope('PBFT_PREPARE', {}).sig;

        const restore = byz.forgeConsensusSignatures(hub);
        const pbft      = hub.peerManager.buildEnvelope('PBFT_PREPARE', { seq: 1 });
        const heartbeat = hub.peerManager.buildEnvelope('HEARTBEAT', {});

        assert.notStrictEqual(pbft.sig, honest, 'PBFT signature was not forged');
        assert.strictEqual(heartbeat.sig, honest, 'transport signature was forged; the victim will be disconnected');
        assert.strictEqual(restore.forgedCount(), 1);

        restore();
        assert.strictEqual(hub.peerManager.buildEnvelope('PBFT_PREPARE', {}).sig, honest, 'restore() left the victim forging');
    });

    it('keeps the envelope otherwise intact, so the victim is a voter not a stranger', function () {
        const { hub } = fakeHub();
        byz.forgeConsensusSignatures(hub);
        const env = hub.peerManager.buildEnvelope('PBFT_COMMIT', { seq: 9 });
        assert.strictEqual(env.sender, '10.0.0.1:41000');
        assert.strictEqual(env.sig_pubkey, 'pub');
        assert.deepStrictEqual(env.data, { seq: 9 });
    });

    it('refuses a hub with no peer manager', function () {
        assert.throws(() => byz.forgeConsensusSignatures({}), /no started peer manager/);
    });

    it('refuses a peer manager that only exposes the pre-rename method', function () {
        const hub = { peerManager: { ['_build' + 'Envelope']() { return { sig: 'ab' }; } } };
        assert.throws(() => byz.forgeConsensusSignatures(hub), /no started peer manager/);
    });
});

describe('liveByzantineFaults: faults installed by drill phases', function () {
    it('the real phase E and F bodies install forging on every selected victim', async function () {
        const suites = [];
        const installations = [];
        let registering;

        function captureDescribe(name, register) {
            const suite = { name, tests: [] };
            const parent = registering;
            registering = suite;
            register.call({ timeout() {} });
            registering = parent;
            suites.push(suite);
        }

        const mochaGlobals = {
            describe: global.describe,
            before: global.before,
            after: global.after,
            it: global.it
        };
        const env = {
            hosts: process.env.XCHAIN_DRILL_HOSTS,
            hubPath: process.env.XCHAIN_DRILL_LOCAL_HUB_PATH,
            applyWait: process.env.XCHAIN_DRILL_APPLY_WAIT_MS,
            stallWait: process.env.XCHAIN_DRILL_STALL_WAIT_MS
        };
        const createWriteStream = fs.createWriteStream;

        function planDrill(spec) {
            return Object.assign({}, spec, {
                hosts: [{}],
                nodes: Array.from({ length: spec.count }, (_, i) => ({
                    id: 'v' + i,
                    role: i < spec.faults ? 'byzantine' : 'honest',
                    hostId: 'unit'
                }))
            });
        }

        async function startMesh(plan) {
            const handles = plan.nodes.map((node, index) => {
                const { hub } = fakeHub();
                const honest = hub.peerManager.buildEnvelope('PBFT_PREPARE', {}).sig;
                return {
                    id: node.id,
                    node,
                    hub,
                    honest,
                    applied: null,
                    restore: null,
                    async send(command, args) {
                        if (command === 'peers') return { peers: plan.count - 1 };
                        if (command === 'quorum') return { quorum: plan.quorum };
                        if (command === 'seq') return { seq: 1 };
                        if (command === 'alignSeq' || command === 'clearPending') return {};
                        if (command === 'isLeader') return { leader: index === 0 };
                        if (command === 'getConfig') return { value: this.applied };
                        if (command === 'dropDb') return { dropped: true };
                        if (command === 'fault') {
                            if (this.restore) { this.restore(); this.restore = null; }
                            if (args.mode === 'forge') {
                                this.restore = byz.forgeConsensusSignatures(this.hub);
                                installations.push({
                                    id: this.id,
                                    pbft: this.hub.peerManager.buildEnvelope('PBFT_COMMIT', {}).sig,
                                    heartbeat: this.hub.peerManager.buildEnvelope('HEARTBEAT', {}).sig,
                                    honest: this.honest
                                });
                            }
                            return { mode: args.mode };
                        }
                        if (command === 'propose') {
                            const forged = handles.filter((h) => h.restore).length;
                            if (forged <= plan.faults) {
                                const value = args.config.BTC.regtest.node.GAS_PRICE;
                                handles.forEach((h) => { h.applied = value; });
                            }
                            return { accepted: true };
                        }
                        throw new Error('unexpected command ' + command);
                    }
                };
            });
            return {
                handles,
                byzantine: () => handles.filter((h) => h.node.role === 'byzantine'),
                honest: () => handles.filter((h) => h.node.role === 'honest'),
                async stop() {
                    handles.forEach((h) => { if (h.restore) h.restore(); });
                }
            };
        }

        try {
            global.describe = captureDescribe;
            global.before = (fn) => { registering.before = fn; };
            global.after = (fn) => { registering.after = fn; };
            global.it = (name, fn) => { registering.tests.push({ name, fn }); };
            process.env.XCHAIN_DRILL_HOSTS = 'unit';
            process.env.XCHAIN_DRILL_LOCAL_HUB_PATH = path.resolve(__dirname, '../../../xchain-hub');
            process.env.XCHAIN_DRILL_APPLY_WAIT_MS = '1';
            process.env.XCHAIN_DRILL_STALL_WAIT_MS = '1';
            fs.createWriteStream = () => ({ write() {}, end() {} });

            proxyquire('../physicalByzantine.drill', {
                './lib/drillPlan': { planDrill, describePlan: () => 'unit plan' },
                './lib/drillRunner': { startMesh },
                './lib/drillVerdict': {
                    PASS: 'PASS',
                    evaluateLiveness: () => ({ status: 'PASS', phase: 'liveness', reasons: [] }),
                    evaluateBoundary: () => ({ status: 'PASS', phase: 'boundary', reasons: [] }),
                    evaluateSafetyForge: () => ({ status: 'PASS', phase: 'safety', reasons: [] }),
                    summarize: () => ({}),
                    renderReport: () => ''
                }
            });

            const suite = suites.find((s) => s.name.includes('N=7'));
            assert.ok(suite, 'the physical N=7 drill did not register');
            await suite.before.call({ skip() {} });

            const phaseE = suite.tests.find((t) => t.name.startsWith('E ACTIVE-BFT'));
            const phaseF = suite.tests.find((t) => t.name.startsWith('F EXCLUSION'));
            assert.ok(phaseE, 'the real phase E body is absent');
            assert.ok(phaseF, 'the real phase F body is absent');

            await phaseE.fn();
            const phaseEInstalls = installations.splice(0);
            assert.strictEqual(phaseEInstalls.length, 2, 'phase E did not install f faults');

            await phaseF.fn();
            const phaseFInstalls = installations.splice(0);
            assert.strictEqual(phaseFInstalls.length, 3, 'phase F did not install f+1 faults');

            for (const installed of phaseEInstalls.concat(phaseFInstalls)) {
                assert.notStrictEqual(installed.pbft, installed.honest, installed.id + ' kept an honest PBFT signature');
                assert.strictEqual(installed.heartbeat, installed.honest, installed.id + ' forged transport traffic');
            }
            await suite.after();
        } finally {
            global.describe = mochaGlobals.describe;
            global.before = mochaGlobals.before;
            global.after = mochaGlobals.after;
            global.it = mochaGlobals.it;
            fs.createWriteStream = createWriteStream;
            if (env.hosts === undefined) delete process.env.XCHAIN_DRILL_HOSTS;
            else process.env.XCHAIN_DRILL_HOSTS = env.hosts;
            if (env.hubPath === undefined) delete process.env.XCHAIN_DRILL_LOCAL_HUB_PATH;
            else process.env.XCHAIN_DRILL_LOCAL_HUB_PATH = env.hubPath;
            if (env.applyWait === undefined) delete process.env.XCHAIN_DRILL_APPLY_WAIT_MS;
            else process.env.XCHAIN_DRILL_APPLY_WAIT_MS = env.applyWait;
            if (env.stallWait === undefined) delete process.env.XCHAIN_DRILL_STALL_WAIT_MS;
            else process.env.XCHAIN_DRILL_STALL_WAIT_MS = env.stallWait;
        }
    });
});

describe('liveByzantineFaults: proposal envelopes', function () {
    it('builds a forged PRE_PREPARE whose digest cannot match its config', function () {
        const config = { BTC: { regtest: { node: { GAS_PRICE: '1' } } } };
        const env = byz.forgedPrePrepare(9100, config, 100);
        assert.strictEqual(env.type, 'PBFT_PRE_PREPARE');
        assert.strictEqual(env.data.seq, 9100);
        assert.strictEqual(env.data.configDigest, 'deadbeef'.repeat(8));
        assert.deepStrictEqual(env.data.config, config);
    });

    it('builds an honest PRE_PREPARE whose digest does match, for equivocation rounds', function () {
        const { hub } = fakeHub();
        const config = { BTC: { regtest: { node: { GAS_PRICE: '2' } } } };
        const env = byz.prePrepareEnvelope(hub.consensus, 42, 0, config, 100);
        assert.strictEqual(env.data.configDigest, hub.consensus.digest(config));
        assert.strictEqual(env.sender, '10.0.0.1:41000');
        assert.strictEqual(env.data.view, 0);
    });
});
