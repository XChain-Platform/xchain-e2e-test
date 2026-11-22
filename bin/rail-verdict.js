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

const fs = require('fs')

const [reportPath, ...driveFiles] = process.argv.slice(2)

function fail(message) {
    console.log('RAIL VERDICT FAIL ' + message)
    process.exitCode = 1
}

function readReport(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
        return null
    }
}

function normalise(file) {
    return String(file || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
}

function isDriveEntry(entry, files) {
    const entryFile = normalise(entry.file)
    return files.some((file) => entryFile.endsWith(file))
}

function firstLine(value) {
    return String(value || '').split(/\r?\n/, 1)[0]
}

function failureDetail(failure) {
    const title = firstLine(failure.title)
    const message = firstLine(failure.err && failure.err.message)
    return title + ': ' + message
}

const report = readReport(reportPath)
if (!report) {
    fail('no readable mocha JSON report at ' + reportPath)
} else {
    const failures = Array.isArray(report.failures) ? report.failures : []
    const pending = Array.isArray(report.pending) ? report.pending : []
    const passes = Array.isArray(report.passes) ? report.passes : []
    const files = driveFiles.map(normalise)

    console.log(JSON.stringify(report.stats))

    if (failures.length > 0) {
        fail(failures.length + ' failing: ' + failures.slice(0, 10).map(failureDetail).join('; '))
    } else {
        const drivePending = pending.filter((entry) => isDriveEntry(entry, files))
        if (drivePending.length > 0) {
            fail(drivePending.length + ' skipped in a drive file: ' +
                drivePending.map((entry) => firstLine(entry.title)).join('; '))
        } else {
            const missing = files.find((file) =>
                !passes.some((entry) => normalise(entry.file).endsWith(file)))
            if (missing) {
                fail('no passing case in ' + missing)
            } else {
                console.log('RAIL VERDICT PASS ' + report.stats.passes +
                    ' passing, 0 failing, 0 skipped across ' + files.length +
                    ' drive file(s): ' + files.join(', '))
            }
        }
    }
}
