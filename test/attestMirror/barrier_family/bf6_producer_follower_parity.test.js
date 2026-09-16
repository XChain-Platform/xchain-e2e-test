'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * BF6 (family section 7): producer precondition, follower bound, parity and
 * drift, driven as PROCESSES against the isolated build root rather than
 * re-asserted here by hand. Each case spawns the real suite or the real check in
 * the repo that owns it, with the environment the venue would give it, and reads
 * the mocha JSON reporter: zero failing, ZERO PENDING, and the named cases
 * present and passing. A suite that skips its armed arm reads green through the
 * exact gap this leg exists to watch, which is why pending is a failure here.
 *
 *   producer precondition   xchain-hub admission_height.test.js, ARMED: a hub whose
 *                           admission tip for a chain in the read set is stale or
 *                           absent refuses to finalize and names the chain
 *   follower bound          xchain-hub follower_admission_bound(.consensus).test.js:
 *                           a proposal outside [own + 1, own + ADMIT_MAX_FUTURE_BLOCKS(c)]
 *                           on any chain, or omitting a read-set chain, is refused
 *   parity                  xchain-indexer activation_constants_parity.test.js under
 *                           XCHAIN_REQUIRE_SIBLINGS=1: the constants, both maps and
 *                           the regtest resolver deepStrictEqual across the indexer,
 *                           the hub twin and the documentation canon, GATES floor held
 *   digest                  both consensus_rules_digest suites: the new gate in
 *                           SHARED_GATES in both repos, digest equal across the pair
 *   twins                   xchain-indexer/bin/sync-hub-mirror-client.sh --check:
 *                           the explorer's vendored copies byte-identical (cmp -s)
 *
 * THE MIXED-VERSION PAIR is the second describe (row 10), built on the venue's
 * per-hub code root (`hubRepoRoots`): hub 1 runs from the OTHER upgrade state's
 * tree, named by BF6_MIXED_HUB_ROOT (the orchestrator supplies it; this leg never
 * cuts a checkout), hub 0 from the build root. A v7 indexer following the older
 * hub PARKS its mirror on the schema-version handshake rather than serving partial
 * rows, the v7 hub names the CONSENSUS-RULE MISMATCH with the peer and both
 * digests, and both hubs stay up: a clean refusal, not an exit. The precondition
 * case (offline) proves the supplied root really is a different upgrade state.
 *
 * The first describe needs no venue and no rail; the mixed pair needs the rail's
 * disposable MariaDB and FAILS, never skips, without the root or the rail.
 ********************************************************************/

const assert = require('assert')
const path = require('path')
const fs = require('fs')
const { spawnSync } = require('child_process')

const fixture = require('../helpers/barrierFamilyFixture')
const drive = require('../helpers/barrierFamilyDrive')
const { until } = require('../mirrorDrillWaits')

const BUILD_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const HUB = path.join(BUILD_ROOT, 'xchain-hub')
const INDEXER = path.join(BUILD_ROOT, 'xchain-indexer')
const { HUB_SCHEMA_VERSION } = require(path.join(INDEXER, 'src', 'hub', 'hub_schema_version.js'))

const MIXED_ROOT_ENV = 'BF6_MIXED_HUB_ROOT'
// Hub 0 and indexer 0 are the build root's; hub 1 is the other upgrade state's, followed by indexer 1.
const NEW = 0
const OLD = 1

// One mocha run in `repo`, through that repo's own mocha with its config disabled so a
// spec list in a .mocharc cannot widen a targeted run into the whole suite.
function runSuite (repo, files, env, requires) {
    const mocha = path.join(repo, 'node_modules', '.bin', 'mocha')
    assert.ok(fs.existsSync(mocha), 'no mocha in ' + repo + ': the build root lacks that repo\'s node_modules')
    const args = ['--no-config', '--no-package', '--timeout', '60000', '--exit', '--reporter', 'json']
    for (const r of requires || []) args.push('--require', r)
    const res = spawnSync(mocha, args.concat(files), { cwd: repo, env: Object.assign({}, process.env, env || {}), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    let report = null
    try { report = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))) } catch (_) { report = null }
    assert.ok(report && report.stats, repo + ' ' + files.join(' ') + ' produced no mocha JSON (exit ' + res.status + '):\n' + res.stdout.slice(-2000) + res.stderr.slice(-2000))
    return { stats: report.stats, tests: report.tests, failures: report.failures || [], status: res.status, stderr: res.stderr }
}

// Zero failing, zero pending, and every named case present and passing.
function assertGreen (run, label, named) {
    // Hook failures (a sibling guard refusing in a before) land in `failures`, not `tests`.
    const failed = run.failures.map((t) => t.fullTitle + ': ' + ((t.err && t.err.message) || ''))
    assert.deepStrictEqual(failed, [], label + ' has failures')
    assert.strictEqual(run.stats.pending, 0, label + ' has ' + run.stats.pending + ' pending case(s); a skipped arm is not a pass')
    assert.strictEqual(run.stats.failures, 0, label + ' reports ' + run.stats.failures + ' failures')
    assert.ok(run.stats.passes > 0, label + ' ran nothing')
    for (const re of named || []) {
        const hit = run.tests.filter((t) => re.test(t.fullTitle))
        assert.ok(hit.length > 0, label + ' has no case matching ' + re)
        for (const t of hit) assert.ok(!t.err || Object.keys(t.err).length === 0, label + ': ' + t.fullTitle + ' failed')
    }
    console.log('BF6 ' + label + ': ' + run.stats.passes + ' passing, ' + run.stats.failures + ' failing, ' + run.stats.pending + ' pending')
    return run.stats
}

describe('BF6: producer precondition, follower bound, parity and drift, as processes on the build root', function () {
    this.timeout(15 * 60 * 1000)

    const evidence = { repoRoot: BUILD_ROOT, shas: {}, stats: {} }

    before(function () {
        for (const r of ['xchain-hub', 'xchain-indexer', 'xchain-e2e-test']) evidence.shas[r] = fixture.headShaOf(path.join(BUILD_ROOT, r))
        console.log('BF EVIDENCE ' + JSON.stringify(evidence))
    })

    it('producer precondition: a hub with a stale or absent admission tip in the read set refuses to finalize, per chain', function () {
        const run = runSuite(HUB, ['test/unit/shared/admission/admission_height.test.js'], { [fixture.ARM_ENV]: fixture.ARM_VALUE }, ['./test/setup/index.js'])
        evidence.stats.producer = assertGreen(run, 'producer precondition (armed)', [
            /REFUSES when any chain in the read set has no fresh tip, and names the chain/,
            /REFUSES a proposal whose map omits a chain in the read set/,
        ])
    })

    it('follower bound: a proposal outside the per-chain window or omitting a read-set chain is refused', function () {
        const run = runSuite(HUB, ['test/unit/shared/admission/follower_admission_bound.test.js',
            'test/unit/shared/admission/follower_admission_bound_consensus.test.js'], {}, ['./test/setup/index.js'])
        evidence.stats.follower = assertGreen(run, 'follower bound', [
            /REFUSES a height past the chain's own forward window, per chain/,
            /REFUSES a height at or behind this follower's own tip/,
            /REFUSES a map that omits a chain in the read set/,
        ])
    })

    it('parity: the constants, both maps and the regtest resolver equal across indexer, hub twin and canon, GATES floor held', function () {
        const run = runSuite(INDEXER, ['test/unit/activations/activation_constants_parity.test.js'], { XCHAIN_REQUIRE_SIBLINGS: '1' }, ['./test/helpers/setup.js'])
        evidence.stats.parity = assertGreen(run, 'activation constants parity', [/GATES|gate/i])
    })

    it('digest: the gate is in SHARED_GATES in both repos and the digest is equal across the pair', function () {
        const ix = runSuite(INDEXER, ['test/unit/consensus/consensus_rules_digest.test.js'], { XCHAIN_REQUIRE_SIBLINGS: '1' }, ['./test/helpers/setup.js'])
        evidence.stats.digestIndexer = assertGreen(ix, 'consensus rules digest (indexer)', [/mirror_admission|SHARED_GATES|digest/i])
        const hub = runSuite(HUB, ['test/unit/consensus/consensus_rules_digest.test.js'], {}, ['./test/setup/index.js'])
        evidence.stats.digestHub = assertGreen(hub, 'consensus rules digest (hub)', [/digest/i])
    })

    it('twins: the explorer\'s vendored mirror client, version twin, activation module and SQL twins are byte-identical', function () {
        const res = spawnSync('bash', [path.join(INDEXER, 'bin', 'sync-hub-mirror-client.sh'), '--check'], { cwd: INDEXER, encoding: 'utf8' })
        console.log('BF6 sync-hub-mirror-client.sh --check exit ' + res.status + '\n' + String(res.stdout).slice(-1500) + String(res.stderr).slice(-1500))
        assert.strictEqual(res.status, 0, 'sync-hub-mirror-client.sh --check found drift (exit ' + res.status + ')')
        evidence.stats.twins = { exit: res.status }
    })

    after(function () {
        console.log('BF6 EVIDENCE ' + JSON.stringify(evidence))
    })
})

// ---- the mixed-version pair (row 10) ------------------------------------------

/** The orchestrator-supplied root of the OTHER upgrade state; a missing one is a failed drive. */
function mixedRoot () {
    const raw = process.env[MIXED_ROOT_ENV]
    assert.ok(raw, 'FAILED DRIVE (not a skip): ' + MIXED_ROOT_ENV + ' names the tree holding the other upgrade state\'s ' +
        'xchain-hub; it is the orchestrator\'s to supply, never a checkout this leg makes')
    const root = path.resolve(raw)
    assert.ok(fs.existsSync(path.join(root, 'xchain-hub', 'src', 'api.js')), root + ' has no xchain-hub/src/api.js')
    assert.ok(fs.existsSync(path.join(root, 'xchain-hub', 'node_modules')), root + '/xchain-hub has no node_modules; a hub child cannot boot from it')
    return root
}

/**
 * The upgrade state of the hub in `root`: its HUB_SCHEMA_VERSION (either file spelling) and
 * its consensus-rules digest, read in a CHILD process with the environment a venue hub gets
 * (no arming key: the regtest resolver's value enters GATES, so an armed process and an inert
 * one differ on the digest, and that would read as a code mismatch here).
 */
function hubUpgradeState (root) {
    const hub = path.join(root, 'xchain-hub')
    const script = [
        'const fs = require("fs");',
        'const v = ["./src/hub_schema_version.js", "./src/hub-schema-version.js"].find((f) => fs.existsSync(f));',
        'const d = require("./src/consensus_rules_digest.js").computeConsensusRulesDigest();',
        'process.stdout.write(JSON.stringify({ schemaVersion: v ? require(v).HUB_SCHEMA_VERSION : null, digest: d.digest, keys: Object.keys(d.gates || {}).length }));',
    ].join(' ')
    const res = spawnSync(process.execPath, ['-e', script], { cwd: hub, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' })
    assert.strictEqual(res.status, 0, 'could not read the upgrade state of ' + hub + ' (exit ' + res.status + '):\n' + String(res.stderr).slice(-1500))
    const out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf('{')))
    assert.ok(/^[0-9a-f]{64}$/.test(String(out.digest)), hub + ' computed no rules digest')
    return Object.assign({ root, sha: fixture.headShaOf(hub) }, out)
}

/** Poll a venue child's log tail for `re`; the match, or a failure showing the tail. */
async function untilLogMatches (venue, which, re, timeoutMs) {
    const got = await until(async () => {
        const m = re.exec(venue.logTail(which))
        return { ok: !!m, m }
    }, timeoutMs, 2000)
    assert.ok(got.ok, which + ' never logged ' + re + ' inside ' + timeoutMs + ' ms:\n' + venue.logTail(which).slice(-3000))
    return got.m
}

describe('BF6 mixed-version pair: a v7 mirror parks on an older hub, and the federation names the rules mismatch', function () {
    this.timeout(drive.LEG_FLOOR_MS)

    const ctx = { venue: null, states: null }

    after(async function () {
        if (ctx.venue) await ctx.venue.stop()
    })

    it('precondition: the supplied root is a DIFFERENT upgrade state from the build root, by schema version and by rules digest', function () {
        const root = mixedRoot()
        ctx.states = { new: hubUpgradeState(BUILD_ROOT), old: hubUpgradeState(root) }
        console.log('BF6 MIXED ' + JSON.stringify(ctx.states))
        assert.strictEqual(ctx.states.new.schemaVersion, HUB_SCHEMA_VERSION, 'the build root\'s hub and indexer disagree on HUB_SCHEMA_VERSION')
        assert.ok(Number.isInteger(ctx.states.old.schemaVersion), root + ' has no HUB_SCHEMA_VERSION; a hub that stamps no version cannot be refused')
        assert.notStrictEqual(ctx.states.old.schemaVersion, ctx.states.new.schemaVersion, root + ' is at the same schema version as the build root')
        assert.notStrictEqual(ctx.states.old.digest, ctx.states.new.digest, root + ' computes the same rules digest as the build root; the pair is not mixed')
    })

    it('live: indexer 1 (v7) behind the older hub PARKS its mirror on the version handshake while indexer 0 bootstraps', async function () {
        assert.ok(ctx.states, 'the precondition did not run')
        const built = fixture.buildFamilyVenue({
            repoRoot: BUILD_ROOT, label: 'bf6mix', hubRepoRoots: { [OLD]: ctx.states.old.root }, venue: { hubCount: 2, indexerCount: 2 },
        })
        ctx.venue = built.venue
        console.log('BF EVIDENCE ' + JSON.stringify(Object.assign(built.evidence, { states: ctx.states })))
        assert.strictEqual(ctx.venue.hubRepoRoot(OLD), ctx.states.old.root)
        assert.strictEqual(ctx.venue.hubRepoRoot(NEW), ctx.venue.repoRoot)
        const up = await ctx.venue.start()
        assert.ok(up, 'FAILED DRIVE (not a skip): the mixed-version venue did not come up: ' + String(ctx.venue.unavailable))
        assert.deepStrictEqual(ctx.venue.indexers.map((ix) => ix.followsHub), [NEW, OLD], 'indexer i must follow hub i')
        await assertMirrorParked(ctx)
    })

    it('live: the v7 hub names the CONSENSUS-RULE MISMATCH with the older hub and both digests, and both hubs stay up', async function () {
        assert.ok(ctx.venue, 'the venue did not come up')
        await assertMismatchNamed(ctx)
    })
})

/** Indexer 0 drains its bootstrap; indexer 1 logs the version refusal naming both versions and never drains. */
async function assertMirrorParked (ctx) {
    const bootstrapped = async (i) => {
        const s = await ctx.venue.statusOf(i)
        return !!(s.body && s.body.hubMirror && s.body.hubMirror.bootstrapped === true)
    }
    const ok0 = await until(async () => ({ ok: await bootstrapped(NEW) }), 10 * 60 * 1000, 3000)
    assert.ok(ok0.ok, 'indexer 0 never bootstrapped its mirror from the v7 hub:\n' + ctx.venue.logTail('indexer' + NEW).slice(-2000))
    const m = await untilLogMatches(ctx.venue, 'indexer' + OLD,
        /HubDbSync: hub (?:snapshot |catch-up )?schema_version (\d+) != local (\d+) for (\w+)/, 10 * 60 * 1000)
    assert.strictEqual(Number(m[1]), ctx.states.old.schemaVersion, 'the refusal names hub version ' + m[1])
    assert.strictEqual(Number(m[2]), HUB_SCHEMA_VERSION, 'the refusal names local version ' + m[2])
    // Parked means it STAYS un-drained, not that one page was refused: three reads, 20 s apart.
    for (let k = 0; k < 3; k++) {
        assert.strictEqual(await bootstrapped(OLD), false, 'indexer 1 drained a bootstrap from a hub at schema_version ' + m[1])
        await new Promise((r) => setTimeout(r, 20000))
    }
    console.log('BF6 MIXED indexer 1 parked: hub schema_version ' + m[1] + ' != local ' + m[2] + ' for ' + m[3] + '; indexer 0 bootstrapped')
}

/** The v7 hub's own log names the peer, its digest and ours; neither hub process has exited. */
async function assertMismatchNamed (ctx) {
    const m = await untilLogMatches(ctx.venue, 'hub' + NEW,
        /CONSENSUS-RULE MISMATCH with peer (\S+) .*peer=([0-9a-f]{16})\.\.\. ours=([0-9a-f]{16})\.\.\./, 5 * 60 * 1000)
    assert.strictEqual(m[1], ctx.venue.hubs[OLD].p2pAddr, 'the mismatch names peer ' + m[1] + ', not the older hub ' + ctx.venue.hubs[OLD].p2pAddr)
    assert.strictEqual(m[2], ctx.states.old.digest.slice(0, 16), 'the peer digest in the line is not the older root\'s')
    assert.strictEqual(m[3], ctx.states.new.digest.slice(0, 16), 'the "ours" digest in the line is not the build root\'s')
    for (const i of [NEW, OLD]) {
        assert.strictEqual(ctx.venue.hubs[i].proc.exitCode, null, 'hub ' + i + ' exited; the refusal was not clean:\n' + ctx.venue.logTail('hub' + i).slice(-2000))
        assert.ok(await ctx.venue.hubs[i].connector.ping(), 'hub ' + i + ' stopped answering')
    }
    console.log('BF6 MIXED hub 0 named the mismatch with ' + m[1] + ': peer=' + m[2] + ' ours=' + m[3] + '; both hubs up')
}
