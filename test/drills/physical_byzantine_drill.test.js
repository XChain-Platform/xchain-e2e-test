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
 * PHYSICAL multi-box byzantine drill at N=7/f=2 and N=10/f=3.
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
        'src/validators/identity.js'
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

async function startDrill(ctx, mochaContext) {
    const { spec } = ctx;
    if (!ctx.hostsRaw) {
        console.log('Skipping physical drill N=' + spec.count + ': set XCHAIN_DRILL_HOSTS (see test/drills/README.md)');
        mochaContext.skip();
    }
    ctx.verdicts = [];
    ctx.plan = planDrill({
        count: spec.count, faults: spec.faults, hosts: parseHosts(ctx.hostsRaw), basePort: spec.basePort,
        runId: 's' + spec.count + '_' + process.pid,
        allowSingleHost: process.env.XCHAIN_DRILL_ALLOW_SINGLE_HOST === '1'
    });
    console.log('\n' + describePlan(ctx.plan) + '\n');
    ctx.logPath = path.join(process.env.XCHAIN_DRILL_LOG_DIR || require('os').tmpdir(),
        'xchain-drill-N' + spec.count + '-' + process.pid + '.log');
    ctx.logStream = fs.createWriteStream(ctx.logPath);
    console.log('validator output: ' + ctx.logPath);
    ctx.mesh = await startMesh(ctx.plan, {
        identities: loadIdentities(spec.count), logStream: ctx.logStream, snapshotBlock: 100
    });
    await waitUntil(async () => {
        const seen = await Promise.all(ctx.mesh.handles.map((h) => h.send('peers').catch(() => ({ peers: -1 }))));
        return seen.every((p) => p.peers === spec.count - 1);
    }, ctx.peerWaitMs);
}

async function stopDrill(ctx) {
    if (ctx.mesh) {
        // Drop each validator's schema before killing it; a shared venue
        // must be handed back the way it was found.
        const drops = await Promise.all(ctx.mesh.handles.map((h) => h.send('dropDb', {}, 60000)
            .then((r) => (r && r.dropped === false && !r.skipped ? 'not dropped: ' + JSON.stringify(r) : null),
                (e) => 'dropDb failed: ' + String(e && e.message || e))));
        ctx.dropFailures = drops.filter(Boolean);
        await ctx.mesh.stop();
    }
    if (ctx.logStream) ctx.logStream.end();
    if (ctx.verdicts && ctx.verdicts.length) {
        const summary = V.summarize(ctx.verdicts);
        console.log('\n' + V.renderReport(ctx.plan, summary, {
            runId: 'N' + ctx.spec.count, startedAt: new Date().toISOString()
        }) + '\n');
    }
    if (ctx.dropFailures.length)
        throw new Error('schema teardown left databases behind: ' + ctx.dropFailures.join('; '));
}

async function proveMesh(ctx) {
    const { mesh, spec } = ctx;
    const peers = await Promise.all(mesh.handles.map((h) => h.send('peers')));
    const quorums = await Promise.all(mesh.handles.map((h) => h.send('quorum')));
    peers.forEach((p, i) => assert.strictEqual(p.peers, spec.count - 1,
        mesh.handles[i].id + ' on ' + mesh.handles[i].node.hostId + ' sees ' + p.peers +
        ' peers, expected ' + (spec.count - 1)));
    const qs = quorums.map((q) => q.quorum);
    assert.ok(qs.every((q) => q === qs[0]), 'validators disagree on quorum: ' + JSON.stringify(qs));
    assert.strictEqual(qs[0], spec.quorum, 'expected quorum ' + spec.quorum + ', got ' + qs[0]);
}

async function proveLiveness(ctx) {
    const { mesh, spec } = ctx;
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
        }, ctx.applyWaitMs);
        const verdict = V.evaluateLiveness({
            quorum: spec.quorum, expectedValue: value,
            observations: roleObservations(await readAll(mesh, value), victims)
        });
        ctx.verdicts.push(verdict);
        assert.strictEqual(verdict.status, V.PASS,
            verdict.phase + ': ' + verdict.status + ' ' + verdict.reasons.join('; '));
    } finally { await clearFaults(mesh); }
}

async function proveBoundary(ctx) {
    const { mesh, spec } = ctx;
    const value = phaseValue(spec.count, 'C');
    await realign(mesh);
    const leader = await findLeader(mesh);
    assert.ok(leader, 'no leader identified');
    const victims = await applyFaults(mesh, leader, spec.faults + 1, 'silent');
    try {
        await leader.send('propose', { config: cfgFor(value) });
        const held = await holdAbsence(() => readAll(mesh, value), ctx.stallWaitMs,
            (rows) => rows.some((o) => o.applied === value));
        const verdict = V.evaluateBoundary({
            expectedValue: value, observations: roleObservations(held, victims)
        });
        ctx.verdicts.push(verdict);
        assert.strictEqual(verdict.status, V.PASS,
            verdict.phase + ': ' + verdict.status + ' ' + verdict.reasons.join('; '));
    } finally {
        await clearFaults(mesh);
        await realign(mesh);
    }
}

async function proveSafety(ctx) {
    const { mesh, spec } = ctx;
    const value = phaseValue(spec.count, 'D');
    const observations = [];
    for (const handle of mesh.handles) {
        try {
            const result = await handle.send('forgePrePrepare', {
                seq: 9100 + spec.count, config: cfgFor(value), blockIndex: 100
            });
            const config = await handle.send('getConfig', { coin: COIN, net: NET, module: MODULE, key: KEY });
            observations.push({ id: handle.id, pendingCreated: result.pendingCreated, applied: config.value });
        } catch (error) {
            observations.push({ id: handle.id, pendingCreated: undefined, applied: undefined });
        }
    }
    const verdict = V.evaluateSafetyForge({ forgedValue: value, observations });
    ctx.verdicts.push(verdict);
    assert.strictEqual(verdict.status, V.PASS,
        verdict.phase + ': ' + verdict.status + ' ' + verdict.reasons.join('; '));
    await realign(mesh);
}

async function proveActiveByzantineLiveness(ctx) {
    const { mesh, spec } = ctx;
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
        }, ctx.applyWaitMs);
        // A forging validator still receives honest votes, so it may apply
        // too; only the honest quorum is asserted here. Whether its own
        // forged votes counted is what phase F settles.
        // The returned rows therefore exclude every faulted validator.
        const rows = (await readAll(mesh, value)).map((o) => Object.assign({}, o, { role: 'honest' }));
        const honestOnly = rows.filter((o) => !victims.some((x) => x.id === o.id));
        const verdict = V.evaluateLiveness({ quorum: spec.quorum, expectedValue: value, observations: honestOnly });
        ctx.verdicts.push(Object.assign({}, verdict, { phase: 'active-byzantine-liveness' }));
        assert.strictEqual(verdict.status, V.PASS,
            'active-byzantine liveness: ' + verdict.status + ' ' + verdict.reasons.join('; '));
    } finally {
        await clearFaults(mesh);
        await realign(mesh);
    }
}

async function proveForgedVoteExclusion(ctx) {
    const { mesh, spec } = ctx;
    const value = phaseValue(spec.count, 'F');
    await realign(mesh);
    const leader = await findLeader(mesh);
    assert.ok(leader, 'no leader identified');
    const victims = await applyFaults(mesh, leader, spec.faults + 1, 'forge');
    try {
        await leader.send('propose', { config: cfgFor(value) });
        const held = await holdAbsence(() => readAll(mesh, value), ctx.stallWaitMs,
            (rows) => rows.some((o) => o.applied === value));
        const verdict = V.evaluateBoundary({
            expectedValue: value, observations: roleObservations(held, victims)
        });
        ctx.verdicts.push(Object.assign({}, verdict, { phase: 'forged-vote-exclusion' }));
        assert.strictEqual(verdict.status, V.PASS,
            'forged-vote exclusion: ' + verdict.status + ' ' + verdict.reasons.join('; ') +
            ' (an apply here means honest validators counted a signature that does not verify)');
    } finally { await clearFaults(mesh); }
}

function registerDrillSuite(ctx) {
    this.timeout(30 * 60 * 1000);
    const { spec } = ctx;
    before(function () { return startDrill(ctx, this); });
    after(() => stopDrill(ctx));
    it('A MESH: every validator sees ' + (spec.count - 1) + ' peers and all agree on quorum ' + spec.quorum,
        () => proveMesh(ctx));
    it('B LIVENESS: ' + spec.faults + ' silent validators do not stall the federation',
        () => proveLiveness(ctx));
    it('C BOUNDARY: ' + (spec.faults + 1) + ' silent validators drop it below quorum, so nothing applies',
        () => proveBoundary(ctx));
    it('D SAFETY: a forged-digest PRE_PREPARE is rejected with no state change', () => proveSafety(ctx));
    it('E ACTIVE-BFT: ' + spec.faults + ' validators voting with forged signatures do not stall the federation',
        () => proveActiveByzantineLiveness(ctx));
    it('F EXCLUSION: ' + (spec.faults + 1) + ' forging validators stall it, proving forged votes were never counted',
        () => proveForgedVoteExclusion(ctx));
}

function drillScale(spec) {
    const ctx = {
        spec,
        hostsRaw: process.env.XCHAIN_DRILL_HOSTS,
        applyWaitMs: parseInt(process.env.XCHAIN_DRILL_APPLY_WAIT_MS, 10) || 20000,
        stallWaitMs: parseInt(process.env.XCHAIN_DRILL_STALL_WAIT_MS, 10) || 20000,
        peerWaitMs: parseInt(process.env.XCHAIN_DRILL_PEER_WAIT_MS, 10) || 20000,
        plan: null, mesh: null, verdicts: [], logStream: null, logPath: null, dropFailures: []
    };
    describe('PHYSICAL byzantine drill N=' + spec.count + ' f=' + spec.faults,
        function () { registerDrillSuite.call(this, ctx); });
}

drillScale({ count: 7,  quorum: 5, faults: 2, basePort: 41000 });
drillScale({ count: 10, quorum: 7, faults: 3, basePort: 42000 });
