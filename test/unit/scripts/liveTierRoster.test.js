'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The live integration tier ran in no CI lane, so a product change in a
// sibling repo turned one of its suites red for ten days unheard. The lane is
// scripts/run-live-tier.js; these are the guards that keep the lane honest, and
// they live in the HERMETIC unit tier on purpose - the roster check needs no
// venue, no database and no siblings, so a live suite that nobody wired is
// caught on the machine that added it rather than on a venue days later.
//
// The two failure shapes tested here are the two the item found, generalised:
//
//  - ROSTER DRIFT: a new *.integration.test.js that no roster entry mentions.
//    A bare glob would have absorbed it silently, which is how a tier grows
//    coverage nobody decided to run.
//  - SILENT SKIP: a suite that reports success having run nothing, because
//    these suites skip themselves when a service is absent. Mocha's exit code
//    cannot tell that from a real pass; classify() can, and must.

const assert = require('assert')
const fs     = require('fs')
const path   = require('path')
const lane   = require('../../../scripts/run-live-tier')

describe('live integration tier roster', () => {

    describe('the committed roster describes the committed tree', () => {

        it('every live suite on disk is declared, and every declaration exists', () => {
            const problems = lane.auditRoster(lane.discoverSuites(), lane.readRoster())
            assert.deepStrictEqual(problems, [],
                'test/integration/live-tier.json has drifted from test/integration/:\n  '
                + problems.join('\n  '))
        })

        it('runs at least one suite, or the lane proves nothing', () => {
            assert.ok(lane.suitesToRun(lane.readRoster()).length > 0)
        })

        it('every excluded suite states why, in prose a reader can act on', () => {
            for (const entry of lane.suitesExcluded(lane.readRoster())) {
                assert.strictEqual(typeof entry.why, 'string', entry.file + ' needs a why')
                assert.ok(entry.why.trim().length >= 20,
                    entry.file + ': "' + entry.why + '" is too terse to be a reason')
            }
        })

        it('is valid JSON with a timeout the slowest declared suite can survive', () => {
            const roster = lane.readRoster()
            // The mirror suite alone measured 54s on one venue (2026-08-09), most
            // of it the disposable MariaDB container coming up, so a per-test
            // budget under a minute would fail the venue rather than the code.
            assert.ok(roster.timeoutMs >= 120000, 'timeoutMs is too small for a live suite')
        })
    })

    describe('auditRoster refuses the drift a glob would swallow', () => {

        const entry = (file, run, why) => ({ file, run, why })

        it('names an undeclared suite', () => {
            const problems = lane.auditRoster(
                ['test/integration/a.integration.test.js', 'test/integration/b.integration.test.js'],
                { suites: [entry('test/integration/a.integration.test.js', true)] })
            assert.strictEqual(problems.length, 1)
            assert.match(problems[0], /b\.integration\.test\.js.*NOT in test\/integration\/live-tier\.json/)
        })

        it('names a declaration whose file is gone', () => {
            const problems = lane.auditRoster(
                ['test/integration/a.integration.test.js'],
                { suites: [entry('test/integration/a.integration.test.js', true),
                           entry('test/integration/gone.integration.test.js', true)] })
            assert.strictEqual(problems.length, 1)
            assert.match(problems[0], /gone\.integration\.test\.js.*no such file/)
        })

        it('refuses an exclusion with no reason, and accepts one with a reason', () => {
            const bare = lane.auditRoster(['test/integration/a.integration.test.js'],
                { suites: [entry('test/integration/a.integration.test.js', false)] })
            assert.match(bare[0], /no `why`/)

            const reasoned = lane.auditRoster(['test/integration/a.integration.test.js'],
                { suites: [entry('test/integration/a.integration.test.js', false, 'needs a full regtest stack')] })
            assert.deepStrictEqual(reasoned, [])
        })

        it('refuses a whitespace-only reason, which reads as documented but is not', () => {
            const problems = lane.auditRoster(['test/integration/a.integration.test.js'],
                { suites: [entry('test/integration/a.integration.test.js', false, '   ')] })
            assert.match(problems[0], /no `why`/)
        })

        it('refuses a duplicate entry, which could otherwise hide a second verdict', () => {
            const problems = lane.auditRoster(['test/integration/a.integration.test.js'],
                { suites: [entry('test/integration/a.integration.test.js', true),
                           entry('test/integration/a.integration.test.js', false, 'a contradicting second opinion')] })
            assert.match(problems[0], /listed twice/)
        })

        it('refuses a non-boolean run flag rather than coercing it', () => {
            const problems = lane.auditRoster(['test/integration/a.integration.test.js'],
                { suites: [{ file: 'test/integration/a.integration.test.js', run: 'yes' }] })
            assert.match(problems[0], /`run` must be true or false/)
        })

        it('refuses a roster with no suites array at all', () => {
            assert.match(lane.auditRoster([], {})[0], /no `suites` array/)
        })
    })

    describe('classify catches the green-having-run-nothing lane', () => {

        const FILE = 'test/integration/a.integration.test.js'
        const tally = counts => new Map([[FILE, counts]])

        it('passes a suite whose cases all ran and passed', () => {
            assert.deepStrictEqual(lane.classify([FILE], tally({ passing: 10, failing: 0, pending: 0 })), [])
        })

        it('fails a suite that reported nothing at all', () => {
            // The shape a root-hook this.skip() produces: mocha exits 0 and the
            // file contributes no test of any kind. Measured for three
            // suites in this tier on 2026-08-09.
            const [p] = lane.classify([FILE], new Map())
            assert.strictEqual(p.kind, 'ran-nothing')
        })

        it('fails a suite whose cases are all pending', () => {
            const [p] = lane.classify([FILE], tally({ passing: 0, failing: 0, pending: 4 }))
            assert.strictEqual(p.kind, 'ran-nothing')
        })

        it('fails a suite that ran but left a case pending', () => {
            const [p] = lane.classify([FILE], tally({ passing: 3, failing: 0, pending: 1 }))
            assert.strictEqual(p.kind, 'pending')
        })

        it('reports a real failure as a failure, not as a skip', () => {
            const [p] = lane.classify([FILE], tally({ passing: 3, failing: 2, pending: 1 }))
            assert.strictEqual(p.kind, 'failing')
            assert.match(p.detail, /2 failing/)
        })
    })

    describe('tallyByFile folds a mocha report onto roster paths', () => {

        it('keys on the repo-relative path mocha reports absolutely', () => {
            const root = '/ci/work/xchain-e2e-test'
            const abs  = root + '/test/integration/a.integration.test.js'
            const t = lane.tallyByFile({
                passes:   [{ file: abs }, { file: abs }],
                failures: [{ file: abs }],
                pending:  [{ file: abs }]
            }, root)
            assert.deepStrictEqual(t.get('test/integration/a.integration.test.js'),
                { passing: 2, failing: 1, pending: 1 })
        })

        it('tolerates a report with missing sections', () => {
            assert.strictEqual(lane.tallyByFile({}, '/x').size, 0)
        })
    })

    describe('a host that cannot run the tier is not the commit\'s fault', () => {

        it('accepts a pre-provisioned database without consulting docker', () => {
            assert.strictEqual(lane.liveTierBlocker({ HUB_DB_USER: 'u', HUB_DB_PASS: 'p' }), null)
        })

        it('reports 95, the shared gate\'s VENUE code, not a red-commit code', () => {
            // 1 would send the pusher to fix a commit that was never evaluated,
            // and the dispatcher's 1-arm offers PREPUSH_SKIP. 95 says the venue
            // could not run it and refuses the bypass.
            assert.strictEqual(lane.VENUE_EXIT, 95)
        })

        it('names the missing prerequisite when there is neither DB nor docker', function () {
            // Only assertable where docker is genuinely absent; where it exists
            // the null answer above is the whole contract.
            const blocker = lane.liveTierBlocker({})
            if (blocker === null) return this.skip()
            assert.match(blocker, /HUB_DB_USER/)
        })
    })

    describe('the lane is actually wired into the gate', () => {

        // The whole item is that a suite existed and no lane ran it. A roster
        // that nothing invokes would be the same defect with more ceremony, so
        // assert the wiring itself rather than trusting the script's presence.
        const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'))

        it('npm run ci calls the live lane', () => {
            assert.match(pkg.scripts.ci, /ci:live/,
                'the `ci` script is what every venue gate, ci-all.sh sweep and workflow runs;'
                + ' a live tier outside it is a tier in no lane')
        })

        it('ci:live runs this runner rather than a bare glob', () => {
            assert.match(pkg.scripts['ci:live'], /run-live-tier/)
        })

        it('the base ci step does not also run a lane suite directly', () => {
            // Double-running a live suite wastes the gate's slowest minutes and,
            // worse, splits its verdict across two places.
            for (const file of lane.suitesToRun(lane.readRoster()))
                assert.ok(!pkg.scripts.ci.includes(path.basename(file)),
                    path.basename(file) + ' is run twice: once by the roster and once inline in `ci`')
        })
    })
})
