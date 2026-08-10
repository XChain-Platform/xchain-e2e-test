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
 * : PHYSICAL multi-box byzantine drill at N=7/f=2 and N=10/f=3.
 *
 * The in-process suite (test/integration/multiHubByzantineF2) proves the same
 * two scales, but every validator there shares a process, an event loop, a
 * loopback address and a connection pool, and every fault is injected by
 * reaching into the victim's memory from the test file. This drill runs each
 * validator as its own OS process on its own box, injects faults from INSIDE
 * the victim's process, and reads the outcome only out of each validator's own
 * MariaDB. What it adds over the in-process suite is not a new assertion, it is
 * the removal of every shared-fate shortcut an auditor would object to.
 *
 * Phases, per scale:
 *   A  MESH        every validator sees N-1 peers and all agree on the quorum
 *   B  LIVENESS    f silent validators do not stall the federation
 *   C  BOUNDARY    f+1 silent validators drop it below quorum: nothing applies
 *   D  SAFETY      a forged-digest PRE_PREPARE is rejected, no state change
 *   E  ACTIVE-BFT  f validators that keep VOTING with forged consensus
 *                  signatures do not stall the federation
 *   F  EXCLUSION   f+1 forging validators stall it. This is what proves the
 *                  forged votes were never counted: if honest nodes were
 *                  accepting them, F would commit exactly like E.
 *
 * VENUE-GATED. Does nothing without XCHAIN_DRILL_HOSTS, because it needs real
 * boxes with a hub checkout and a reachable MariaDB. See README.md.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const { planDrill, describePlan } = require('./lib/drillPlan');
const { startMesh }               = require('./lib/drillRunner');
const V                           = require('./lib/drillVerdict');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = 500;

// Wait on the CONDITION, never on the clock. Every validator here is a real OS
// process on its own box reached over ssh, so a fixed settle is too short on a
// loaded venue and wasted time on an idle one. Returns false on timeout rather
// than throwing, and lets the phase's own verdict engine rule: a wait that
// threw would report a slow box as a consensus failure.
async function waitUntil(check, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let ok = false;
        try { ok = await check(); } catch (e) { ok = false; }
        if (ok) return true;
        if (Date.now() >= deadline) return false;
        await sleep(POLL_MS);
    }
}

// The negative phases (C, F) assert that NOTHING applies, and absence cannot be
// polled for. Hold the whole window and re-read throughout, returning the first
// observation that broke the expectation: a value that applies and is then
// cleared would slip past a single read taken at the end.
async function holdAbsence(read, windowMs, broke) {
    const deadline = Date.now() + windowMs;
    let last = await read();
    for (;;) {
        if (broke(last)) return last;
        if (Date.now() >= deadline) return last;
        await sleep(POLL_MS);
        last = await read();
    }
}

// Hosts come in as JSON (an array of descriptors) or as a bare comma-separated
// list of ssh targets. The JSON form is what a real run uses, because each box
// needs its own credentials-file and hub paths.
function parseHosts(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    if (text.startsWith('[')) return JSON.parse(text);
    return text.split(',').map((s) => s.trim()).filter(Boolean).map((t) => ({
        ssh:       t.includes('@') || !t.startsWith('127.') ? t : null,
        advertise: t.includes('@') ? t.split('@')[1] : t,
        envFile:   process.env.XCHAIN_DRILL_ENV_FILE || null,
        hubPath:   process.env.XCHAIN_DRILL_HUB_PATH || null
    }));
}

function loadIdentities(count) {
    const ValidatorIdentity = require(path.join(
        process.env.XCHAIN_DRILL_LOCAL_HUB_PATH || path.resolve(__dirname, '../../../xchain-hub'),
        'src/ValidatorIdentity.js'
    ));
    const out = [];
    for (let i = 0; i < count; i++) out.push(ValidatorIdentity.generate());
    return out;
}

// One config key per phase, per scale, so no phase can be fooled by a value a
// previous phase left behind.
function phaseValue(count, phase) { return String(count) + phase; }

const COIN = 'BTC', NET = 'regtest', MODULE = 'node', KEY = 'GAS_PRICE';
const cfgFor = (value) => ({ [COIN]: { [NET]: { [MODULE]: { [KEY]: value } } } });

// Read the applied value from every validator's own database.
async function readAll(mesh, value) {
    const rows = await Promise.all(mesh.handles.map(async (h) => {
        try {
            const r = await h.send('getConfig', { coin: COIN, net: NET, module: MODULE, key: KEY });
            return { id: h.id, role: h.node.role, applied: r.value };
        } catch (e) {
            // `undefined` is the harness saying "I could not read this node".
            // The verdict engine turns that into INCONCLUSIVE, never a pass.
            return { id: h.id, role: h.node.role, applied: undefined, error: String(e.message || e) };
        }
    }));
    return rows.map((r) => Object.assign({}, r, { expected: value }));
}

// Level every validator's sequence number and drop stale pendings. A proposer
// advances its own seq the moment it proposes, even on a round that never
// commits, so a stalled phase leaves the federation one seq apart. Production
// closes that gap with state sync; a drill mesh has none.
async function realign(mesh) {
    const seqs = await Promise.all(mesh.handles.map((h) => h.send('seq').then((r) => r.seq).catch(() => 0)));
    const max  = Math.max(...seqs.map((s) => s || 0));
    await Promise.all(mesh.handles.map((h) => h.send('alignSeq', { seq: max }).catch(() => {})));
    await Promise.all(mesh.handles.map((h) => h.send('clearPending').catch(() => {})));
}

async function findLeader(mesh, exclude) {
    const skip = new Set((exclude || []).map((h) => h.id));
    for (const h of mesh.handles) {
        if (skip.has(h.id)) continue;
        const r = await h.send('isLeader');
        if (r.leader) return h;
    }
    return null;
}

// Put `mode` on the first `n` non-leader validators, preferring the ones the
// plan already designated byzantine so faults stay spread across boxes.
async function applyFaults(mesh, leader, n, mode) {
    const preferred = mesh.byzantine().filter((h) => h !== leader);
    const rest      = mesh.honest().filter((h) => h !== leader);
    const victims   = preferred.concat(rest).slice(0, n);
    await Promise.all(victims.map((h) => h.send('fault', { mode })));
    return victims;
}

async function clearFaults(mesh) {
    await Promise.all(mesh.handles.map((h) => h.send('fault', { mode: 'none' }).catch(() => {})));
}

// Roles as the CURRENT phase sees them: whichever validators are faulted right
// now, not whatever the plan labelled at layout time.
function roleObservations(observations, victims) {
    const faulty = new Set(victims.map((v) => v.id));
    return observations.map((o) => Object.assign({}, o, { role: faulty.has(o.id) ? 'byzantine' : 'honest' }));
}

function drillScale(spec) {
    const hostsRaw = process.env.XCHAIN_DRILL_HOSTS;
    const APPLY_WAIT_MS = parseInt(process.env.XCHAIN_DRILL_APPLY_WAIT_MS, 10) || 20000;
    const STALL_WAIT_MS = parseInt(process.env.XCHAIN_DRILL_STALL_WAIT_MS, 10) || 20000;
    const PEER_WAIT_MS  = parseInt(process.env.XCHAIN_DRILL_PEER_WAIT_MS, 10)  || 20000;

    describe('PHYSICAL byzantine drill N=' + spec.count + ' f=' + spec.faults + ' ', function () {
        this.timeout(30 * 60 * 1000);

        let plan, mesh, verdicts, logStream, logPath;

        before(async function () {
            if (!hostsRaw) {
                console.log('Skipping physical drill N=' + spec.count + ': set XCHAIN_DRILL_HOSTS (see test/drills/README.md)');
                this.skip();
            }
            verdicts = [];
            plan = planDrill({
                count:           spec.count,
                faults:          spec.faults,
                hosts:           parseHosts(hostsRaw),
                basePort:        spec.basePort,
                runId:           's' + spec.count + '_' + process.pid,
                allowSingleHost: process.env.XCHAIN_DRILL_ALLOW_SINGLE_HOST === '1'
            });
            console.log('\n' + describePlan(plan) + '\n');

            logPath   = path.join(process.env.XCHAIN_DRILL_LOG_DIR || require('os').tmpdir(),
                                  'xchain-drill-N' + spec.count + '-' + process.pid + '.log');
            logStream = fs.createWriteStream(logPath);
            console.log('validator output: ' + logPath);

            mesh = await startMesh(plan, {
                identities:   loadIdentities(spec.count),
                logStream:    logStream,
                snapshotBlock: 100
            });
            await waitUntil(async () => {
                const seen = await Promise.all(mesh.handles.map((h) => h.send('peers').catch(() => ({ peers: -1 }))));
                return seen.every((p) => p.peers === spec.count - 1);
            }, PEER_WAIT_MS);
        });

        after(async function () {
            if (mesh) {
                // Drop each validator's schema before killing it; a shared venue
                // must be handed back the way it was found.
                await Promise.all(mesh.handles.map((h) => h.send('dropDb', {}, 60000).catch(() => {})));
                await mesh.stop();
            }
            if (logStream) logStream.end();
            if (verdicts && verdicts.length) {
                const summary = V.summarize(verdicts);
                console.log('\n' + V.renderReport(plan, summary, { runId: 'N' + spec.count, startedAt: new Date().toISOString() }) + '\n');
            }
        });

        it('A MESH: every validator sees ' + (spec.count - 1) + ' peers and all agree on quorum ' + spec.quorum, async function () {
            const peers   = await Promise.all(mesh.handles.map((h) => h.send('peers')));
            const quorums = await Promise.all(mesh.handles.map((h) => h.send('quorum')));
            peers.forEach((p, i) => assert.strictEqual(
                p.peers, spec.count - 1,
                mesh.handles[i].id + ' on ' + mesh.handles[i].node.hostId + ' sees ' + p.peers + ' peers, expected ' + (spec.count - 1)));
            const qs = quorums.map((q) => q.quorum);
            assert.ok(qs.every((q) => q === qs[0]), 'validators disagree on quorum: ' + JSON.stringify(qs));
            assert.strictEqual(qs[0], spec.quorum, 'expected quorum ' + spec.quorum + ', got ' + qs[0]);
        });

        it('B LIVENESS: ' + spec.faults + ' silent validators do not stall the federation', async function () {
            const value = phaseValue(spec.count, 'B');
            await realign(mesh);
            const leader = await findLeader(mesh);
            assert.ok(leader, 'no leader identified');
            const victims = await applyFaults(mesh, leader, spec.faults, 'silent');
            try {
                await leader.send('propose', { config: cfgFor(value) });
                await waitUntil(async () => {
                    const rows = await readAll(mesh, value);
                    return rows.filter((o) => o.applied === value).length >= spec.quorum;
                }, APPLY_WAIT_MS);
                const v = V.evaluateLiveness({
                    quorum: spec.quorum,
                    expectedValue: value,
                    observations: roleObservations(await readAll(mesh, value), victims)
                });
                verdicts.push(v);
                assert.strictEqual(v.status, V.PASS, v.phase + ': ' + v.status + ' ' + v.reasons.join('; '));
            } finally {
                await clearFaults(mesh);
            }
        });

        it('C BOUNDARY: ' + (spec.faults + 1) + ' silent validators drop it below quorum, so nothing applies', async function () {
            const value = phaseValue(spec.count, 'C');
            await realign(mesh);
            const leader = await findLeader(mesh);
            assert.ok(leader, 'no leader identified');
            const victims = await applyFaults(mesh, leader, spec.faults + 1, 'silent');
            try {
                await leader.send('propose', { config: cfgFor(value) });
                const held = await holdAbsence(
                    () => readAll(mesh, value),
                    STALL_WAIT_MS,
                    (rows) => rows.some((o) => o.applied === value));
                const v = V.evaluateBoundary({
                    expectedValue: value,
                    observations: roleObservations(held, victims)
                });
                verdicts.push(v);
                assert.strictEqual(v.status, V.PASS, v.phase + ': ' + v.status + ' ' + v.reasons.join('; '));
            } finally {
                await clearFaults(mesh);
                await realign(mesh);
            }
        });

        it('D SAFETY: a forged-digest PRE_PREPARE is rejected with no state change', async function () {
            const value = phaseValue(spec.count, 'D');
            const seq   = 9100 + spec.count;
            const observations = [];
            for (const h of mesh.handles) {
                try {
                    const r   = await h.send('forgePrePrepare', { seq, config: cfgFor(value), blockIndex: 100 });
                    const cfg = await h.send('getConfig', { coin: COIN, net: NET, module: MODULE, key: KEY });
                    observations.push({ id: h.id, pendingCreated: r.pendingCreated, applied: cfg.value });
                } catch (e) {
                    observations.push({ id: h.id, pendingCreated: undefined, applied: undefined });
                }
            }
            const v = V.evaluateSafetyForge({ forgedValue: value, observations });
            verdicts.push(v);
            assert.strictEqual(v.status, V.PASS, v.phase + ': ' + v.status + ' ' + v.reasons.join('; '));
            await realign(mesh);
        });

        it('E ACTIVE-BFT: ' + spec.faults + ' validators voting with forged signatures do not stall the federation', async function () {
            const value = phaseValue(spec.count, 'E');
            await realign(mesh);
            const leader = await findLeader(mesh);
            assert.ok(leader, 'no leader identified');
            const victims = await applyFaults(mesh, leader, spec.faults, 'forge');
            try {
                await leader.send('propose', { config: cfgFor(value) });
                await waitUntil(async () => {
                    const rows = await readAll(mesh, value);
                    const honest = rows.filter((o) => !victims.some((x) => x.id === o.id));
                    return honest.filter((o) => o.applied === value).length >= spec.quorum;
                }, APPLY_WAIT_MS);
                // A forging validator still RECEIVES honest votes, so it may apply
                // too; only the honest quorum is asserted here. Whether its own
                // forged votes counted is what phase F settles.
                const rows = (await readAll(mesh, value)).map((o) => Object.assign({}, o, { role: 'honest' }));
                const honestOnly = rows.filter((o) => !victims.some((x) => x.id === o.id));
                const v = V.evaluateLiveness({ quorum: spec.quorum, expectedValue: value, observations: honestOnly });
                verdicts.push(Object.assign({}, v, { phase: 'active-byzantine-liveness' }));
                assert.strictEqual(v.status, V.PASS, 'active-byzantine liveness: ' + v.status + ' ' + v.reasons.join('; '));
            } finally {
                await clearFaults(mesh);
                await realign(mesh);
            }
        });

        it('F EXCLUSION: ' + (spec.faults + 1) + ' forging validators stall it, proving forged votes were never counted', async function () {
            const value = phaseValue(spec.count, 'F');
            await realign(mesh);
            const leader = await findLeader(mesh);
            assert.ok(leader, 'no leader identified');
            const victims = await applyFaults(mesh, leader, spec.faults + 1, 'forge');
            try {
                await leader.send('propose', { config: cfgFor(value) });
                const held = await holdAbsence(
                    () => readAll(mesh, value),
                    STALL_WAIT_MS,
                    (rows) => rows.some((o) => o.applied === value));
                const v = V.evaluateBoundary({
                    expectedValue: value,
                    observations: roleObservations(held, victims)
                });
                verdicts.push(Object.assign({}, v, { phase: 'forged-vote-exclusion' }));
                assert.strictEqual(v.status, V.PASS,
                    'forged-vote exclusion: ' + v.status + ' ' + v.reasons.join('; ') +
                    ' (an apply here means honest validators counted a signature that does not verify)');
            } finally {
                await clearFaults(mesh);
            }
        });
    });
}

drillScale({ count: 7,  quorum: 5, faults: 2, basePort: 41000 });
drillScale({ count: 10, quorum: 7, faults: 3, basePort: 42000 });
