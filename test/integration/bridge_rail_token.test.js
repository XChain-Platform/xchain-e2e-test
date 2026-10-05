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
 *
 * THE TOKEN BRIDGE ACCEPTANCE DRIVE: token AT1 to AT8, over the base drive's venue shape (a harness federation of the seated roster
 * keys, a venue BTC clone, a venue DOGE indexer REPLAYED from genesis under this tree's
 * bridge code). AT9 is the gate run plus the activation parity test and is not a drive:
 * this file runs both as child processes after the drive (see the AT9 section at its foot).
 *
 * ── ONE SUITE IN TWO PLACES ────────────────────────────────────────────────────────
 * This root holds the venue bring-up, the T0 precondition and the arming case; the legs
 * live in `bridge_rail_token.test/0*.test.js` and share the venue through
 * `./bridge_rail_token.test/support`. ONE mocha run, root first, glob quoted, never
 * `--sort` (bridge_rail_base.test.js says why):
 *
 *   npx mocha test/integration/bridge_rail_token.test.js "test/integration/bridge_rail_token.test/*.test.js"
 *
 * ── HOW TO RUN IT, on the regtest rail host, from this repository root ──────────────
 *
 *   nohup ~/scratch/xc-meta/doge-loop.sh >/dev/null 2>&1 & echo $! > ~/scratch/xc-meta/doge-loop.pid
 *   COIN=bitcoin NETWORK=regtest NODE_PATH=<the chunked module directory> \
 *     BRIDGE_RAIL_REPO_ROOT=<the pinned root the standing containers were built from> \
 *     BRIDGE_RAIL_MINER_PAUSE_FILE=<flag file the BTC loop honours> \
 *     BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE=<flag file the DOGE loop honours> \
 *     npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js \
 *     test/integration/bridge_rail_token.test.js "test/integration/bridge_rail_token.test/*.test.js"
 *   kill $(cat ~/scratch/xc-meta/doge-loop.pid)
 *
 * The federation secret is sourced from the operator's own 0600 store into the
 * environment and passed no other way (`resolveVenueQuorum` is the gate; without it every
 * federated case skips with the reason named). One leg (`--grep "token AT<n>"`) can be
 * run alone only together with the root and the parts that come before it in the order
 * below, because the later legs read rows the earlier ones created.
 *
 * ── THE ORDER IS NOT THE SPEC'S NUMBERING, AND HERE IS WHY ─────────────────────────
 * AT8's retraction claim, "DOGE never gains a root row" (D45: a retracted FIRST in-leg
 * must leave no root row), is only a claim while no in-leg has applied yet. So the
 * retraction leg runs FIRST, right after the engine is armed, on its own tick, and its
 * lock rides back into the chain when mining resumes (the reorg suite's header says why
 * an orphaned lock cannot be kept out): that legitimate second finalization is what
 * creates the BTC root on DOGE, and the leg asserts that creation too. AT1 then proves
 * the child row under an existing root, which is the shape every later token takes.
 * Otherwise the legs run in numbered order, AT8's cap and invariant halves last.
 *
 * ── WHAT THE REGTEST RAIL READS DIFFERENTLY FROM THE SPEC TEXT, MEASURED ──────────
 * `TOKEN_POLICY_INHERITANCE_ACTIVATION` is 0 on regtest (xchain-indexer
 * protocol_changes/shared_rows_5.js), so the policy spec's flag day is ACTIVE on this
 * rail and the token spec's milestone-1 refusals for policy-bound tokens are lifted
 * exactly as that spec's AT1 says ("refused below the flag, applied above it"). AT6
 * reads the indexer's own registry at the case's block and asserts the verdicts the
 * flag state implies: refused with the milestone-1 strings below it, applied above it,
 * with the format 6 controller bind refused either way. Both readings are journaled.
 *
 * ── AT9 IS RUN, NOT QUOTED ─────────────────────────────────────────────────────────
 * The last suite in the run is a plain `describe`, not a drive part, so it runs after the
 * venue is torn down and needs no federation. It audits the drive's own cases (every
 * drivable case passed, in the order above), then spawns, on this process's Node 22 with
 * an allowlisted environment: this repository's full CI gate (`npm run ci:full`) and
 * xchain-indexer's activation constants parity test out of
 * the pinned root with XCHAIN_REQUIRE_SIBLINGS=1. On a hosted venue the CI gate runs
 * directly; a workstation with the dispatcher sends it to one of its configured venues.
 * The direct child carries its venue as a recursion guard, so a token drive selected by
 * that full gate does not launch the full gate again. Each outer gate is judged on its
 * exit status and its own counts. A dispatcher exit 95 and every nonzero direct exit are
 * RED verdicts here: a gate that did not run proves nothing. The last case prints the
 * dated record.
 *
 * ── EVERY DOGE-SIDE READ IS ON THE VENUE LEDGER, ASSERT BY IDENTITY ─────────────────
 * As the base drive: the standing DOGE indexer parsed a different history, and a count
 * over a set this small passes against broken code half the time.
 *
 * Acceptance section 10 of the token bridge drive, decisions D24, D29 and D45; the
 * base drive's section 15 for the venue.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { journalCase } = require('../helpers/bridgeRailVenue');
const {
    assert,
    GAS_TICK,
    state,
    rowsLike,
    pickFreeTick,
    chainHalves,
    needsFederation,
    bridgeRailSuite,
    TOKEN_DRIVE,
} = require('./bridge_rail_token.test/support');

const T0 = 'token T0: the destination ledger before any token leg';

// ── THE QUIET BEFORE THE FIRST IN LEG ──────────────────────────────────────────
bridgeRailSuite(T0, function () {
    it('token AT1 precondition: no BTC root row on the DOGE ledger in any case, and the native tick is free', async function () {
        this.timeout(0);
        if (needsFederation(this, 'token AT1 precondition')) return;
        const T = state.tokens;
        const btcRows = await rowsLike('DOGE', 'BTC');
        state.evidence.at1_dogeBtcRootBefore = btcRows.map((r) => r.tick);
        assert.deepStrictEqual(btcRows, [],
            'the venue DOGE ledger already holds a root row spelled like BTC: ' + JSON.stringify(btcRows) +
            '. A PREVIOUS run of this drive applied an in leg into this same stable database. Drop the ' +
            'venue DOGE indexer and mirror databases (`..._bridgerailtokendoge_Rpl_Ixr0`, ' +
            '`..._bridgerailtokendoge_Mirror0`) and let it replay from genesis.');
        T.tick = await pickFreeTick(['FUFU', 'FUFB', 'FUFC', 'FUFD']);
        assert.ok(T.tick, 'no free native tick among FUFU..FUFD on the venue BTC ledger');
        T.bridged = 'BTC.' + T.tick;
        state.evidence.tick = T.tick;
        state.evidence.bridgeRoleDoge = await state.venue.roleAddress('DOGE', 'BRIDGE_BTC');
        state.evidence.bridgeRoleBtc = await state.venue.roleAddress('BTC', 'BRIDGE_DOGE');
        assert.ok(state.evidence.bridgeRoleDoge, 'DOGE resolves no BRIDGE_BTC role address');
    });
});

bridgeRailSuite(T0, function () {
    it('arms the venue bridge engine, drains the XCHAIN backlog and takes the XCHAIN baseline (token AT8 control)', async function () {
        this.timeout(0);
        if (needsFederation(this, 'the token baseline')) return;
        // The base drive's note 3: arming re-finalizes every historical XCHAIN lock, and a
        // reading taken while that lands measures two events. The wait is on the
        // destination's settlement rows, not on in_flight.
        const overlay = await state.venue.rewireHubs();
        state.evidence.engineEnv = Object.keys(overlay).sort().join(', ');
        const settled = await state.venue.waitForRailSettled(GAS_TICK, { timeoutMs: 60 * 60 * 1000 });
        assert.ok(settled, 'the XCHAIN backlog never drained: ' + JSON.stringify(state.venue['_lastSettlePoll']) +
            '\n' + state.venue.indexerTails(40));
        state.evidence.backlogApplied = settled.applied;
        const dupes = await state.venue.duplicateSourceTransfers();
        state.evidence.overFinalizedSourceLegs = dupes;
        assert.deepStrictEqual(dupes, [],
            'the federation finalized ' + dupes.length + ' source leg(s) more than once: ' + JSON.stringify(dupes));
        state.baseline = { xchain: await chainHalves(), invariant: settled.invariant || null };
        state.evidence.xchainBaseline = state.baseline;
    });
});

// ── AT9: THE GATES, RUN ───────────────────────────────────────────────────────────
const E2E_ROOT = path.resolve(__dirname, '..', '..');
// The indexer the venue spawned is the one whose constants are judged, so the parity test
// runs out of the same pinned root; a hand run falls back to the sibling layout.
const PLATFORM_ROOT = process.env.BRIDGE_RAIL_REPO_ROOT || path.resolve(E2E_ROOT, '..');
const INDEXER_ROOT = path.join(PLATFORM_ROOT, 'xchain-indexer');
const PARITY_FILES = [
    'test/unit/activations/activation_constants_parity.test.js',
    'test/unit/activations/activation_constants_parity.test/height_ordering.test.js',
];
const PARITY_ORDERING_TITLE = 'holds TOKEN_BRIDGE_ACTIVATION >= XCHAIN_BRIDGE_ACTIVATION for every chain key';
const CI_GATE_COMMAND = 'npm run ci:full';
const ENCLOSING_CI_VENUE_ENV = 'TOKEN_AT9_ENCLOSING_CI_VENUE';
const GATE_DID_NOT_RUN_EXITS = new Set([2, 3, 94, 95, 97, 99, 255]);
const SIBLING_BRANCH_RULE = /^PUSH_BRANCH="\$\{REMOTE_REF#refs\/heads\/\}"$/m;
const GATE_BASE_HANDLER = /^\s*--base\)/m;
const GATE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
// The two cases a leg skips on purpose because regtest arms their flag at height 0, so no
// block below it exists to drive; each names the indexer unit coverage that carries it. A skip
// title is the declared name, or the declared name followed by '. ' and the reason it is skipped.
const NOT_DRIVABLE_ON_REGTEST = new Set([
    'token AT4: an ISSUE|7 below TOKEN_BRIDGE_ACTIVATION is invalid: VERSION (unknown)',
    'token AT6 (R8): a ^id edit of a pre-flag three-character row applies',
]);
// The part order the header documents, one label per part, consecutive repeats collapsed.
const DRIVE_ORDER = ['T0', 'AT8', 'AT1', 'AT2', 'AT3', 'AT4', 'AT5', 'AT6', 'AT7', 'AT8'];
// The child sees the host basics and nothing the drive carries: no federation secret, no
// NODE_PATH, no pinned database, exactly as the workflow gives the gate a clean runner.
const GATE_ENV_KEYS = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM',
    'DOCKER_HOST', 'XDG_RUNTIME_DIR'];
const GATE_ENV_MASK_KEYS = [
    'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
    'DATABASE_URL', 'DATABASE_PORT',
    'INDEXER_URL', 'INDEXER_API_PORT', 'BTC_INDEXER_API_URL',
    'P2P_MAX_CONNECTIONS_PER_IP',
];

const at9 = { record: null, drive: null, ordinaryCi: null, parity: null };
let gitShim = null;

function executableOnPath(name) {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        const candidate = path.join(dir, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch (e) { /* keep looking */ }
    }
    return null;
}

function mappedGitEnv() {
    if (gitShim) return gitShim.env;
    const dotGit = path.join(E2E_ROOT, '.git');
    let pointer = null;
    try {
        const match = /^gitdir:\s*(.+)\s*$/.exec(fs.readFileSync(dotGit, 'utf8'));
        if (match) pointer = path.resolve(E2E_ROOT, match[1]);
    } catch (e) { return {}; }
    if (!pointer || fs.existsSync(pointer)) return {};

    const marker = path.sep + path.basename(E2E_ROOT) + path.sep + '.git' + path.sep;
    const at = pointer.lastIndexOf(marker);
    if (at < 0) return {};
    let platform;
    try { platform = path.dirname(fs.realpathSync(INDEXER_ROOT)); } catch (e) { return {}; }
    const mapped = path.join(platform, pointer.slice(at + 1));
    const realGit = executableOnPath('git');
    if (!realGit || !fs.existsSync(mapped)) return {};

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-at9-git-'));
    const shim = path.join(dir, 'git');
    fs.writeFileSync(shim, [
        '#!/bin/sh',
        'has_c=0',
        'mapped_c=0',
        'take_c=0',
        'for arg in "$@"; do',
        '  if [ "$take_c" = 1 ]; then',
        '    has_c=1',
        '    if [ "$arg" = "$AT9_GIT_WORK_TREE" ]; then mapped_c=1; fi',
        '    take_c=0',
        '  elif [ "$arg" = "-C" ]; then',
        '    take_c=1',
        '  fi',
        'done',
        'if [ "$has_c" = 1 ] && [ "$mapped_c" = 0 ]; then',
        '  exec "$AT9_REAL_GIT" "$@"',
        'fi',
        'if [ "$mapped_c" = 1 ] || [ "$PWD" = "$AT9_GIT_WORK_TREE" ]; then',
        '  exec "$AT9_REAL_GIT" --git-dir="$AT9_GIT_DIR" --work-tree="$AT9_GIT_WORK_TREE" "$@"',
        'fi',
        'exec "$AT9_REAL_GIT" "$@"',
        '',
    ].join('\n'), { mode: 0o755 });
    gitShim = { dir, env: { AT9_GIT_DIR: mapped, AT9_GIT_WORK_TREE: E2E_ROOT,
        AT9_REAL_GIT: realGit, PATH: dir + path.delimiter + (process.env.PATH || '') } };
    return gitShim.env;
}

function gateEnv(extra) {
    const env = {};
    for (const key of GATE_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    for (const key of GATE_ENV_MASK_KEYS) env[key] = '';
    // This process's own node first, so `npm` and every `node` it forks are the same Node 22.
    env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '');
    return Object.assign(env, mappedGitEnv(), extra || {});
}

function run(cmd, args, cwd, env, input) {
    const res = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
        timeout: GATE_TIMEOUT_MS, input: input === undefined ? '' : input });
    const out = String(res.stdout || '') + String(res.stderr || '');
    return { status: res.status, signal: res.signal, error: res.error ? String(res.error.message) : null,
        out, tail: out.split('\n').slice(-60).join('\n') };
}

function headOf(dir) {
    const res = run('git', ['-C', dir, 'rev-parse', 'HEAD'], dir, gateEnv());
    return res.status === 0 ? res.out.trim() : null;
}

// Prefer the gate's authoritative aggregate because successful dispatches return its
// compact PASS line rather than the venue's full mocha output.
function tallies(out) {
    const plain = out.replace(/\u001b\[[0-9;]*m/g, '');
    const gate = /^ci-gate: PASS\s+.*?\s+(\d+) pass \/ (\d+) fail(?:\s|$)/m.exec(plain);
    if (gate) return { passing: Number(gate[1]), failing: Number(gate[2]), pending: 0 };
    const count = (re) => [...plain.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
    return { passing: count(/^\s*(\d+) passing/gm), failing: count(/^\s*(\d+) failing/gm),
        pending: count(/^\s*(\d+) pending/gm) };
}

function ciVenueHosts(spec) {
    return new Set(String(spec || '').trim().split(/\s+/).filter(Boolean).map((entry) => entry.split(':')[0]));
}

function configuredCiVenues(dispatcherText, override) {
    if (override) return override;
    const configured = /^VENUES="\$\{CI_VENUES:-(.+)\}"$/m.exec(dispatcherText);
    return configured ? configured[1] : '';
}

function greenVerdictRecord(out, head, venueSpec) {
    const plain = out.replace(/\u001b\[[0-9;]*m/g, '');
    const skip = /^pre-push: SKIPPING the gate: commit ([0-9a-f]{8,40}) passed this exact gate \d+s ago on (.+)\.$/m.exec(plain);
    if (!skip) return { accepted: false, reason: 'the dispatcher output names no cached exact-gate verdict' };
    if (!head.startsWith(skip[1])) return { accepted: false, reason: 'the cached verdict names commit ' + skip[1] + ', not ' + head };
    const store = /^pre-push:\s+doing it .* Verdict store: (.+)$/m.exec(plain);
    if (!store) return { accepted: false, reason: 'the dispatcher output names no verdict store' };
    const body = Buffer.from('xchain-e2e-test\0' + head + '\0' + CI_GATE_COMMAND);
    const key = crypto.createHash('sha1').update('blob ' + body.length + '\0').update(body).digest('hex');
    const file = path.join(store[1].trim(), 'xchain-e2e-test-' + head.slice(0, 12) + '-' + key.slice(0, 8) + '.green');
    let verdict;
    try { verdict = fs.readFileSync(file, 'utf8'); } catch (e) {
        return { accepted: false, reason: 'the cached GREEN verdict file is missing: ' + file };
    }
    const fields = Object.fromEntries(verdict.trim().split('\n').map((line) => {
        const at = line.indexOf('=');
        return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
    }));
    const venues = ciVenueHosts(venueSpec);
    if (fields.repo !== 'xchain-e2e-test' || fields.sha !== head)
        return { accepted: false, reason: 'the cached GREEN verdict does not record this repository and full commit' };
    if (!fields.venue || fields.venue !== skip[2] || !venues.has(fields.venue))
        return { accepted: false, reason: 'the cached GREEN verdict venue is not the named configured CI venue' };
    return { accepted: true, commit: fields.sha, venue: fields.venue };
}

function runDirectCiGate() {
    const venue = os.hostname();
    const res = run('npm', ['run', 'ci:full'], E2E_ROOT,
        gateEnv({ CI_TIER: 'full', [ENCLOSING_CI_VENUE_ENV]: venue }));
    const counts = tallies(res.out);
    at9.ordinaryCi = { command: CI_GATE_COMMAND, cwd: E2E_ROOT, venue,
        transport: 'direct', exit: res.status, signal: res.signal, counts,
        cachedVerdict: null, failureTail: res.status === 0 ? null : res.tail };
    assert.strictEqual(res.status, 0, 'the full CI gate is red on venue ' + venue + ' (exit ' + res.status +
        (res.signal ? ', signal ' + res.signal : '') + (res.error ? ', ' + res.error : '') + '):\n' + res.tail);
    assert.match(res.out, /^ci:full: all tiers green /m,
        'the direct gate exited 0 without its all-tiers GREEN verdict on venue ' + venue + ':\n' + res.tail);
    assert.ok(counts.passing > 0, 'the full CI gate exited 0 having run no mocha case on venue ' + venue + ':\n' + res.tail);
    assert.strictEqual(counts.failing, 0, 'the full CI gate reported failing cases on venue ' + venue + ':\n' + res.tail);
}

function recordEnclosingDirectCiGate() {
    const venue = process.env[ENCLOSING_CI_VENUE_ENV];
    if (!venue) return false;
    assert.strictEqual(venue, os.hostname(), 'the enclosing full CI gate names venue ' + venue +
        ', but token AT9 is running on ' + os.hostname());
    at9.ordinaryCi = { command: CI_GATE_COMMAND, cwd: E2E_ROOT, venue,
        transport: 'enclosing-direct', exit: null, signal: null, counts: null,
        cachedVerdict: null, failureTail: null };
    return true;
}

function driveTests(root) {
    const outer = root.suites.find((s) => s.title === TOKEN_DRIVE.outerTitle);
    assert.ok(outer, 'the token drive registered no outer suite: the legs were not in this run');
    const tests = [];
    (function walk(suite) {
        for (const t of suite.tests) tests.push(t);
        for (const s of suite.suites) walk(s);
    })(outer);
    return { outer, tests };
}

describe('token AT9: the gates, and the dated acceptance record', function () {
    after(function () {
        if (gitShim) fs.rmSync(gitShim.dir, { recursive: true, force: true });
    });

    before(function () {
        if (!state.evidence.drivePrepared) this.skip();
        assert.ok(state.evidence.preflight && state.evidence.preflight.ready,
            'token AT9 requires a completed healthy full-drive preflight');
        const major = Number(process.versions.node.split('.')[0]);
        assert.strictEqual(major, 22, 'AT9 is judged on Node 22 and this process is ' + process.version);
        const child = run('node', ['-p', 'process.versions.node'], E2E_ROOT, gateEnv());
        assert.ok(child.status === 0 && /^22\./.test(child.out.trim()),
            'the gate child does not resolve Node 22 first on PATH: ' + child.tail);
        at9.record = { date: new Date().toISOString().slice(0, 10), node: process.version,
            platformRoot: PLATFORM_ROOT, e2eHead: headOf(E2E_ROOT), indexerHead: headOf(INDEXER_ROOT) };
    });

    it('the drive ran AT1 to AT8 in this file\'s order and every drivable case passed', function () {
        const { outer, tests } = driveTests(this.test.parent.parent);
        const labels = [];
        for (const suite of outer.suites) {
            const m = /token (T0|AT\d)/.exec(suite.title);
            assert.ok(m, 'a drive part carries no token AT label: ' + suite.title);
            if (labels[labels.length - 1] !== m[1]) labels.push(m[1]);
        }
        const verdicts = tests.map((t) => ({ title: t.title, state: t.state || 'unfinished' }));
        at9.drive = { order: labels, passed: verdicts.filter((v) => v.state === 'passed').length,
            notDrivableOnRegtest: [...NOT_DRIVABLE_ON_REGTEST], cases: verdicts };
        assert.strictEqual(state.blocked, null, 'the drive never ran its federated cases: ' + state.blocked);
        assert.deepStrictEqual(labels, DRIVE_ORDER, 'the drive parts did not run in the documented order');
        const declared = (t) => [...NOT_DRIVABLE_ON_REGTEST].find((n) => t === n || t.startsWith(n + '. '));
        const wrong = verdicts.filter((v) => v.state !== (declared(v.title) ? 'pending' : 'passed'));
        assert.deepStrictEqual(wrong, [], 'drive cases that did not end as required: ' + JSON.stringify(wrong));
        for (const title of NOT_DRIVABLE_ON_REGTEST)
            assert.ok(verdicts.some((v) => declared(v.title) === title), 'the declared not-drivable case is gone: ' + title);
    });

    it('token AT9: this repository\'s full CI gate is green on the CI venue', function () {
        this.timeout(0);
        if (recordEnclosingDirectCiGate()) return;
        const dispatcher = path.join(os.homedir(), '.claude', 'bin', 'ci-dispatch.sh');
        if (!fs.existsSync(dispatcher)) return runDirectCiGate();
        const dispatcherText = fs.readFileSync(dispatcher, 'utf8');
        assert.ok(SIBLING_BRANCH_RULE.test(dispatcherText), 'the dispatcher at ' + dispatcher + ' has no sibling-branch rule, so a develop pre-push line would\n' +
            'still ship every sibling at master and the parity guards would grade this tree against stale twins; refresh the dispatcher on this host first');
        const binDir = path.dirname(dispatcher);
        const gateText = fs.existsSync(path.join(binDir, 'ci-gate.sh')) ? fs.readFileSync(path.join(binDir, 'ci-gate.sh'), 'utf8') : '';
        assert.ok(GATE_BASE_HANDLER.test(gateText), 'the venue gate script beside the dispatcher (' + path.join(binDir, 'ci-gate.sh') +
            ') has no --base handler, and the dispatcher ships that file to the CI venue on every run, so the gate would exit 2 on an unknown\n' +
            'argument before testing anything; refresh the gate script on this host first');
        assert.ok(fs.existsSync(path.join(binDir, 'lib', 'ci_tier.sh')), 'the dispatcher sources ' + path.join(binDir, 'lib', 'ci_tier.sh') +
            ' and it is missing on this host; refresh the dispatcher tooling first');
        const venueSpec = configuredCiVenues(dispatcherText, process.env.CI_VENUES);
        assert.ok(venueSpec, 'token AT9 found neither a CI_VENUES override nor a default venue pool in the dispatcher');
        const head = headOf(E2E_ROOT);
        assert.match(head || '', /^[0-9a-f]{40}$/, 'token AT9 cannot resolve the head it grades: ' + head);
        // One pre-push line naming develop as the remote ref, so every sibling resolves at develop.
        const prePush = 'refs/heads/develop ' + head + ' refs/heads/develop ' + '0'.repeat(40) + '\n';
        const venues = process.env.CI_VENUES ? { CI_VENUES: process.env.CI_VENUES } : {};
        const res = run(dispatcher, ['--repo', 'xchain-e2e-test', '--src', E2E_ROOT,
            '--cmd', CI_GATE_COMMAND], E2E_ROOT, gateEnv(Object.assign({ CI_TIER: 'full' }, venues)), prePush);
        const counts = tallies(res.out);
        const freshGreen = /CI gate GREEN on\s+([^;\s]+)/.exec(res.out);
        const cachedGreen = greenVerdictRecord(res.out, head, venueSpec);
        at9.ordinaryCi = { command: dispatcher + ' --repo xchain-e2e-test --src ' + E2E_ROOT +
            ' --cmd "' + CI_GATE_COMMAND + '" (pre-push stdin: develop)', cwd: E2E_ROOT,
            venue: freshGreen ? freshGreen[1] : cachedGreen.venue || null, transport: 'dispatcher',
            exit: res.status, signal: res.signal, counts,
            cachedVerdict: cachedGreen.accepted ? { commit: cachedGreen.commit, venue: cachedGreen.venue } : null,
            failureTail: res.status === 0 ? null : res.tail };
        assert.ok(!GATE_DID_NOT_RUN_EXITS.has(res.status), 'the CI gate did not run (exit ' + res.status +
            '):\n' + res.tail);
        assert.strictEqual(res.status, 0, 'the full CI gate is red (exit ' + res.status +
            (res.signal ? ', signal ' + res.signal : '') + (res.error ? ', ' + res.error : '') + '):\n' + res.tail);
        assert.ok(freshGreen || cachedGreen.accepted, 'the dispatcher exited 0 without a fresh or verified cached GREEN gate: ' +
            cachedGreen.reason + '\n' + res.tail);
        assert.ok(cachedGreen.accepted || counts.passing > 0, 'the full CI gate exited 0 having run no mocha case:\n' + res.tail);
        assert.strictEqual(counts.failing, 0, 'the full CI gate reported failing cases:\n' + res.tail);
    });

    it('token AT9: the activation constants parity test passes with the TOKEN_BRIDGE >= XCHAIN_BRIDGE ordering', function () {
        this.timeout(0);
        const mocha = path.join(INDEXER_ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js');
        const report = path.join(os.tmpdir(), 'at9-parity-' + process.pid + '-' + Date.now() + '.json');
        const res = run(process.execPath, [mocha, '--no-config', '--no-package', '--require', './test/helpers/setup.js',
            '--timeout', '30000', '--exit', '--reporter', 'json', '--reporter-option', 'output=' + report,
            ...PARITY_FILES], INDEXER_ROOT, gateEnv({ XCHAIN_REQUIRE_SIBLINGS: '1' }));
        let json = null;
        try { json = JSON.parse(fs.readFileSync(report, 'utf8')); } catch (e) { json = null; }
        try { fs.unlinkSync(report); } catch (e) { /* never written */ }
        assert.ok(json && json.stats, 'the parity run wrote no mocha report (exit ' + res.status + '):\n' + res.tail);
        const parityFailureTitles = json.failures.map((t) => t.fullTitle);
        const ordering = json.passes.filter((t) => t.title === PARITY_ORDERING_TITLE).length;
        at9.parity = { files: PARITY_FILES, cwd: INDEXER_ROOT, exit: res.status,
            counts: { passing: json.stats.passes, failing: json.stats.failures, pending: json.stats.pending },
            orderingCasesPassed: ordering, failureTitles: parityFailureTitles };
        assert.strictEqual(res.status, 0, 'the parity test is red (exit ' + res.status + '):\n' + res.tail +
            '\nparity failures: ' + JSON.stringify(parityFailureTitles));
        assert.strictEqual(json.stats.failures, 0, 'parity failures: ' + JSON.stringify(parityFailureTitles));
        assert.strictEqual(json.stats.pending, 0, 'parity cases skipped, so they compared nothing: ' +
            JSON.stringify(json.pending.map((t) => t.fullTitle)));
        assert.ok(json.stats.passes > 0, 'the parity run passed no case');
        assert.ok(ordering >= 1, 'the parity run never passed "' + PARITY_ORDERING_TITLE + '"');
    });

    it('prints the dated acceptance record', function () {
        assert.ok(at9.record, 'AT9 took no record header');
        const record = Object.assign({ rail: 'BTC/DOGE regtest', drive: at9.drive,
            ordinaryCi: at9.ordinaryCi, activationConstantsParity: at9.parity }, at9.record);
        console.log('\n=== token bridge acceptance record ' + record.date + ' ===\n' +
            JSON.stringify(record, null, 2) + '\n');
        journalCase({ suite: TOKEN_DRIVE.journalSuite, title: '=== acceptance record ===', state: 'evidence',
            evidence: record });
        for (const part of ['drive', 'ordinaryCi', 'activationConstantsParity'])
            assert.ok(record[part], 'the record has no ' + part + ' reading: its case failed before measuring');
    });
});
