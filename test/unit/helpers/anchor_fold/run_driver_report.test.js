'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
    runMochaDriver,
    assertDriverGreen,
    driverSkipReason,
} = require('../../../helpers/anchor_fold/run_driver_report')

describe('child Mocha driver report helpers', function () {
    this.timeout(60000)
    let scratchDir
    let passingDriver
    let failingDriver

    before(function () {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-fold-driver-test-'))
        passingDriver = path.join(scratchDir, 'passing.test.js')
        failingDriver = path.join(scratchDir, 'failing.test.js')
        const expectedCwd = path.resolve(__dirname, '..', '..', '..')
        fs.writeFileSync(passingDriver, "const assert = require('assert')\n" +
            "it('passes', function () { assert.strictEqual(process.cwd(), " + JSON.stringify(expectedCwd) + ") })\n")
        fs.writeFileSync(failingDriver, "it('fails', function () { throw new Error('distinctive driver failure') })\n")
    })

    after(function () {
        fs.rmSync(scratchDir, { recursive: true, force: true })
    })

    it('returns one passing test from a green driver', function () {
        const run = runMochaDriver(passingDriver)

        assert.strictEqual(run.report.stats.failures, 0)
        assert.strictEqual(run.report.stats.passes, 1)
        assert.doesNotThrow(() => assertDriverGreen(run))
    })

    it('returns one failure and rejects a red driver', function () {
        const run = runMochaDriver(failingDriver)

        assert.strictEqual(run.report.stats.failures, 1)
        assert.throws(() => assertDriverGreen(run), /distinctive driver failure/)
    })

    it('extracts a skip reason with the caller pattern', function () {
        const run = {
            child: { status: 0, stdout: 'Skipping selected driver: unavailable\n' },
            report: { stats: { failures: 0, pending: 1 } },
        }

        assert.strictEqual(driverSkipReason(run, /Skipping selected driver:[^\r\n]*/),
            'Skipping selected driver: unavailable')
    })
})
