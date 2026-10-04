'use strict'

const TEARDOWN_FAILURE = Symbol('teardownFailure')

function recordTeardownFailure (setupError, teardownError) {
    setupError.message += '; teardown after failed setup also failed: ' + teardownError.message
    Object.defineProperty(setupError, TEARDOWN_FAILURE, {
        value: teardownError,
        enumerable: false,
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
