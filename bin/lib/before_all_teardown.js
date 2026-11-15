// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const TEARDOWN_FAILURE = Symbol('teardownFailure')

function recordTeardownFailure (setupError, teardownError) {
    setupError.message += '; teardown after failed setup also failed: ' + teardownError.message
    Object.defineProperty(setupError, TEARDOWN_FAILURE, {
        value: teardownError,
        enumerable: false,
        writable: true,
    })
}

function withTeardownOnFailure (setup, teardown) {
    return async function () {
        try {
            return await setup.call(this)
        } catch (setupError) {
            try {
                await teardown.call(this)
            } catch (teardownError) {
                recordTeardownFailure(setupError, teardownError)
            }
            throw setupError
        }
    }
}

function teardownOutcome (err) {
    const failed = err && Object.prototype.hasOwnProperty.call(err, TEARDOWN_FAILURE)
    return failed ? 'teardown-failed' : 'clean'
}

module.exports = { withTeardownOnFailure, teardownOutcome }
