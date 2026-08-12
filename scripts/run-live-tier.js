#!/usr/bin/env node
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
 * Live integration tier runner.
 *
 * `test/integration/*.integration.test.js` ran in no CI lane at all, so
 * xchain-indexer 521edf2 turned one of its suites red on 2026-07-16 and nobody
 * heard about it for ten days. This script is the lane: `npm run ci` calls it,
 * so every venue gate run, every ci-all.sh sweep and every workflow that runs
 * the repo's own gate exercises the tier.
 *
 * WHY A RUNNER RATHER THAN ONE MORE GLOB ON THE MOCHA LINE. The rot that
 * started this item was not a red suite, it was a red suite NOBODY SAW, and a
 * bare glob reproduces that failure one level up in two ways this script
 * closes:
 *
 *   ROSTER DRIFT. A glob silently absorbs a new `*.integration.test.js`, so a
 *   suite can join the tier without anyone deciding whether the lane can
 *   actually run it - and a suite that cannot run here goes green by skipping.
 *   Every live suite is declared in test/integration/live-tier.json with
 *   `run: true|false` and, when false, a `why`. An undeclared file is a hard
 *   failure, in this lane AND in the hermetic unit tier
 *   (test/unit/scripts/liveTierRoster.test.js), so the drift is caught on a
 *   laptop before it ever reaches a venue.
 *
 *   SILENT SKIP. Mocha's exit code cannot tell "10 passed" from "0 ran,
 *   everything pending". These suites skip themselves on a missing service by
 *   design (`Skipping MultiValidatorHub smoke (HUB_DB_USER/HUB_DB_PASS not
 *   set)`, `Skipping hub-DB WS mirror: no env DB and Docker unavailable`),
 *   which is right for a laptop and lethal for a gate: the lane reports green
 *   having proved nothing. Measured on a bare three-repo checkout on 2026-08-09,
 *   three of the declared suites skipped exactly that way.
 *   So a `run: true` suite that contributes no passing test, or that leaves any
 *   case pending, FAILS the lane and says which file and why.
 *
 * The same reasoning is why the excluded roster is printed on every run
 * including a green one: an exclusion that stops being read is the rot coming
 * back with a config file in front of it.
 *
 * COST, because it is the reason this was not wired years ago. Measured on
 * 2026-08-09: the 20-suite roster is ~700s, and `npm run ci` end to end
 * is ~12.5 min. That is longer than the ~10 min after which GitHub tends to drop
 * an idle push connection, so a pre-push gate run can outlive the push it is
 * gating. The consequence is one failed push, not a lost gate: ci-dispatch banks
 * a green verdict per (repo, sha, command) for an hour, so the immediate retry
 * skips the gate and goes straight through. Slow is survivable here; a tier in
 * no lane at all was not.
 *
 * Usage:
 *   node scripts/run-live-tier.js            run the lane
 *   node scripts/run-live-tier.js --list     print the roster and exit
 *
 * Exit: 0 green; 1 red (roster drift, a failing case, or a suite that ran
 * nothing); 95 when the HOST cannot run the tier truthfully, which the shared
 * gate reports as "not your commit" rather than as a red one. Those three are
 * the attribution this lane exists to provide: a lane whose failures cannot be
 * pinned on anything is worse than no lane at all.
 *
 ********************************************************************/

'use strict'

const fs    = require('fs')
const path  = require('path')
const os    = require('os')
const { spawnSync } = require('child_process')

const REPO_ROOT   = path.resolve(__dirname, '..')
const LIVE_DIR    = path.join(REPO_ROOT, 'test', 'integration')
const ROSTER_FILE = path.join(LIVE_DIR, 'live-tier.json')
const SUITE_RE    = /\.integration\.test\.js$/

// Files present on disk, sorted, relative to the repo root so they read the
// same way in the roster, in the failure text and on a mocha command line.
function discoverSuites(dir = LIVE_DIR) {
    return fs.readdirSync(dir)
        .filter(f => SUITE_RE.test(f))
        .sort()
        .map(f => path.posix.join('test', 'integration', f))
}

function readRoster(file = ROSTER_FILE) {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Compare the declared roster against the directory. Returns a list of English
// problems; empty means the roster describes reality.
//
// Both directions matter and for different reasons: an UNDECLARED file is a
// suite nobody decided about (the drift this lane exists to stop), and a
// DECLARED-BUT-ABSENT file is a lane still claiming to cover something that was
// renamed or deleted, which is the same lie in the other direction.
function auditRoster(files, roster) {
    const problems = []
    const declared = new Map()

    if (!roster || !Array.isArray(roster.suites))
        return ['live-tier.json has no `suites` array']

    for (const entry of roster.suites) {
        if (!entry || typeof entry.file !== 'string' || entry.file === '') {
            problems.push('a roster entry has no `file`')
            continue
        }
        if (declared.has(entry.file)) {
            problems.push(entry.file + ': listed twice in the roster')
            continue
        }
        declared.set(entry.file, entry)
        if (typeof entry.run !== 'boolean')
            problems.push(entry.file + ': `run` must be true or false')
        // An exclusion with no stated reason is how a lane quietly shrinks back
        // to covering nothing, so the reason is structurally required rather
        // than a documentation nicety.
        if (entry.run === false && (typeof entry.why !== 'string' || entry.why.trim() === ''))
            problems.push(entry.file + ': excluded from the lane with no `why`')
    }

    for (const file of files)
        if (!declared.has(file))
            problems.push(file + ': is a live suite but is NOT in test/integration/live-tier.json'
                + ' - add it with run:true, or run:false plus a `why`')

    for (const file of declared.keys())
        if (!files.includes(file))
            problems.push(file + ': is in the roster but no such file exists')

    return problems
}

function suitesToRun(roster) {
    return roster.suites.filter(s => s.run === true).map(s => s.file)
}

function suitesExcluded(roster) {
    return roster.suites.filter(s => s.run !== true)
}

// Fold mocha's json report into per-file counts. Mocha reports a test's file as
// an absolute path; key on the repo-relative path so it matches the roster.
function tallyByFile(report, repoRoot = REPO_ROOT) {
    const tally = new Map()
    const bump = (file, field) => {
        const rel = path.relative(repoRoot, file).split(path.sep).join('/')
        if (!tally.has(rel)) tally.set(rel, { passing: 0, failing: 0, pending: 0 })
        tally.get(rel)[field]++
    }
    for (const t of report.passes  || []) bump(t.file, 'passing')
    for (const t of report.failures || []) bump(t.file, 'failing')
    for (const t of report.pending || []) bump(t.file, 'pending')
    return tally
}

// The lane's verdict. `expected` is the list of files the roster said to run;
// everything here is derived from what mocha actually reported about them.
function classify(expected, tally) {
    const problems = []
    for (const file of expected) {
        const t = tally.get(file) || { passing: 0, failing: 0, pending: 0 }
        if (t.failing > 0) {
            problems.push({ file, kind: 'failing', detail: t.failing + ' failing case(s)' })
            continue
        }
        // A suite that skipped itself for want of a service reports 0 passing
        // and (usually) 0 pending, because `this.skip()` in a root `before`
        // aborts the suite rather than marking its cases. Both shapes are the
        // same defect: the lane cannot vouch for this file.
        if (t.passing === 0)
            problems.push({ file, kind: 'ran-nothing',
                detail: 'no case ran (the suite skipped itself, or died before its first test).'
                    + ' A lane that reports green having run nothing is the defect this runner exists to stop' })
        else if (t.pending > 0)
            problems.push({ file, kind: 'pending',
                detail: t.pending + ' case(s) skipped. Every case in a lane suite must run here,'
                    + ' or the suite belongs in the roster as run:false with a reason' })
    }
    return problems
}

function formatTally(expected, tally) {
    const lines = []
    for (const file of expected) {
        const t = tally.get(file) || { passing: 0, failing: 0, pending: 0 }
        lines.push('  ' + file.replace('test/integration/', '').padEnd(52)
            + t.passing + ' pass  ' + t.failing + ' fail  ' + t.pending + ' pending')
    }
    return lines
}

// ---- the lane ------------------------------------------------------------

// Can this host run the tier at all? The suites obtain a database one of two
// ways (test/helpers/disposableHubDb.js): a pre-provisioned HUB_DB_*, or a
// throwaway MariaDB container. With neither, every one of them calls this.skip()
// and the lane would report a tally of zeroes.
//
// That case exits 95, the shared gate's VENUE code, rather than 1. The
// dispatcher's 95 arm tells the pusher in terms that the commit was never
// evaluated and refuses to offer the bypass, which is the truth here: a venue
// with no container runtime says nothing about the code. Reporting it as a red
// commit is the misattribution the exit contract exists to prevent.
const VENUE_EXIT = 95

function liveTierBlocker(env = process.env) {
    if (env.HUB_DB_USER && env.HUB_DB_PASS) return null
    const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
    if (probe.error || probe.status !== 0)
        return 'no container runtime and no HUB_DB_USER/HUB_DB_PASS, so every live suite would skip itself'
    return null
}

// Remove disposable-MariaDB containers a previous run left behind.
//
// test/helpers/disposableHubDb.js binds a FIXED host port (13307) and names the
// container after the mocha pid, so a run that was killed (a cancelled push, a
// venue reboot, an operator ^C) leaves a container holding the port under a name
// the next run will never reuse. The next run then dies in a before-all hook
// with `Command failed: docker run -d --name xchain-mvh-testdb-<pid> ...` and
// nothing in that message says the cause is a corpse from yesterday - the gate
// reports it against the commit being pushed. Observed on a venue on 2026-08-09.
//
// Scoped twice, because the venues are shared and somebody else's hand-run suite
// must survive this: only containers with this fixture's own name prefix, and of
// those only the ones that are stopped or older than STALE_MS. A healthy
// container belongs to ONE suite and lives under a minute, so nothing in a live
// run is ever old enough to be reaped by a parallel one.
const STALE_MS = 10 * 60 * 1000

function reapStaleFixtureContainers(now = Date.now()) {
    const ps = spawnSync('docker', ['ps', '-aq', '--filter', 'name=xchain-mvh-testdb-'], { encoding: 'utf8' })
    if (ps.error || ps.status !== 0) return 0            // no docker here: the suites skip on their own
    const ids = String(ps.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
    const stale = ids.filter(id => {
        const info = spawnSync('docker', ['inspect', '-f', '{{.State.Running}} {{.Created}}', id], { encoding: 'utf8' })
        if (info.error || info.status !== 0) return false
        const [running, created] = String(info.stdout || '').trim().split(/\s+/)
        if (running !== 'true') return true
        const age = now - Date.parse(created)
        return Number.isFinite(age) && age > STALE_MS
    })
    if (!stale.length) return 0
    spawnSync('docker', ['rm', '-f', ...stale], { stdio: 'ignore' })
    return stale.length
}

function runMocha(files, roster) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xc714-live-')), 'report.json')
    const bin = path.join(REPO_ROOT, 'node_modules', '.bin', 'mocha')
    const args = [
        '--no-config',
        '--timeout', String(roster.timeoutMs || 300000),
        '--exit',
        '--reporter', 'json',
        // Send the report to a FILE, never to stdout: these suites log heavily
        // (hub bring-up, WS reconnects), and a json reporter sharing stdout with
        // console.log emits a document nothing can parse.
        '--reporter-option', 'output=' + out,
        ...files
    ]
    const res = spawnSync(bin, args, { cwd: REPO_ROOT, stdio: 'inherit' })
    return { out, status: res.status, error: res.error }
}

function main(argv) {
    const roster = readRoster()
    const files  = discoverSuites()

    const drift = auditRoster(files, roster)
    if (drift.length) {
        console.error('\nlive tier: the roster does not match test/integration/:')
        for (const d of drift) console.error('  - ' + d)
        console.error('\nlive tier: refusing to run. A lane whose roster has drifted cannot say')
        console.error('           what it covers, which is exactly how this tier rotted.\n')
        return 1
    }

    const expected = suitesToRun(roster)
    const excluded = suitesExcluded(roster)

    if (argv.includes('--list')) {
        console.log('live tier roster (' + expected.length + ' run, ' + excluded.length + ' excluded)')
        for (const f of expected) console.log('  run      ' + f)
        for (const e of excluded) console.log('  excluded ' + e.file + '  -- ' + e.why)
        return 0
    }

    if (!expected.length) {
        console.error('live tier: every suite is excluded, so this lane proves nothing. Refusing.')
        return 1
    }

    const blocker = liveTierBlocker()
    if (blocker) {
        console.error('live tier: this host cannot run the tier truthfully: ' + blocker + '.')
        console.error('live tier: the commit was NOT evaluated. Run the lane on a venue with Docker,')
        console.error('           or export HUB_DB_HOST/PORT/USER/PASS for a database it may create schemas in.')
        return VENUE_EXIT
    }

    const reaped = reapStaleFixtureContainers()
    if (reaped) console.log('live tier: removed ' + reaped + ' stale disposable-MariaDB container(s) from an earlier run')

    console.log('live tier: running ' + expected.length + ' suite(s) on ' + os.hostname())
    const { out, status, error } = runMocha(expected, roster)
    if (error) {
        console.error('live tier: could not start mocha: ' + error.message)
        return 1
    }

    let report
    try {
        report = JSON.parse(fs.readFileSync(out, 'utf8'))
    } catch (e) {
        // No parseable report means the run died before the reporter wrote one.
        // Say that, rather than inferring a verdict from the exit code alone.
        console.error('live tier: mocha exited ' + status + ' and wrote no readable report ('
            + e.message + ').')
        console.error('live tier: the tier was NOT evaluated; read the output above for the cause.')
        return 1
    }

    const tally    = tallyByFile(report)
    const problems = classify(expected, tally)

    console.log('\nlive tier: per-suite tally')
    for (const line of formatTally(expected, tally)) console.log(line)
    if (excluded.length) {
        // Printed on green runs too, deliberately: this is the list of things
        // the lane does NOT cover, and it is only honest while it is read.
        console.log('\nlive tier: NOT covered by this lane (' + excluded.length + '):')
        for (const e of excluded) console.log('  ' + e.file.replace('test/integration/', '') + ': ' + e.why)
    }

    if (problems.length) {
        console.error('\nlive tier: FAILED')
        for (const p of problems) console.error('  ' + p.file + ': ' + p.detail)
        for (const f of report.failures || [])
            console.error('  ' + path.relative(REPO_ROOT, f.file) + ' :: ' + f.fullTitle
                + '\n      ' + String((f.err && f.err.message) || '').split('\n')[0])
        console.error('')
        return 1
    }

    console.log('\nlive tier: GREEN (' + (report.stats && report.stats.passes) + ' passing in '
        + expected.length + ' suite(s))\n')
    return 0
}

module.exports = { discoverSuites, readRoster, auditRoster, suitesToRun, suitesExcluded, tallyByFile, classify,
    liveTierBlocker, VENUE_EXIT, ROSTER_FILE, LIVE_DIR }

if (require.main === module) process.exit(main(process.argv.slice(2)))
