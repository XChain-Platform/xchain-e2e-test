'use strict'

// Chaos Experiment 10: Unhandled Promise Rejection (@P2)
//
// Verifies that Node.js detects unhandled promise rejections via
// the 'unhandledRejection' event, and that properly caught rejections
// do NOT trigger the event.

const assert = require('assert')

describe('Chaos Experiment 10 — Unhandled Promise Rejection @P2', function () {

    it('Node.js fires unhandledRejection for uncaught rejected promise', function (done) {
        const marker = 'chaos-unhandled-' + Date.now() + '-' + Math.random()
        const chaosError = new Error(marker)
        let finished = false

        const handler = (reason) => {
            if (finished) return
            if (reason === chaosError) {
                finished = true
                process.removeListener('unhandledRejection', handler)
                done()
            }
        }

        process.on('unhandledRejection', handler)

        // Create a rejected promise that we intentionally don't catch
        const p = Promise.reject(chaosError)

        // Schedule cleanup: catch the promise later to prevent Node warnings
        setTimeout(() => {
            p.catch(() => {})
            if (!finished) {
                process.removeListener('unhandledRejection', handler)
            }
        }, 200)
    })

    it('caught rejection does NOT fire unhandledRejection', function (done) {
        const marker = 'chaos-caught-' + Date.now()
        let handlerFired = false

        const handler = (reason) => {
            if (reason && reason.message === marker) {
                handlerFired = true
            }
        }
        process.on('unhandledRejection', handler)

        // This rejection is caught — should NOT trigger the event
        Promise.reject(new Error(marker)).catch(() => {
            // Intentionally caught
        })

        // Wait briefly then verify handler was NOT fired
        setTimeout(() => {
            process.removeListener('unhandledRejection', handler)
            assert.strictEqual(handlerFired, false, 'handler should not fire for caught rejections')
            done()
        }, 50)
    })

    it('rejection in async function is detectable when not awaited', function (done) {
        const marker = 'chaos-connector-' + Date.now() + '-' + Math.random()
        const connError = new Error(marker)
        let finished = false

        const handler = (reason) => {
            if (finished) return
            if (reason === connError) {
                finished = true
                process.removeListener('unhandledRejection', handler)
                done()
            }
        }
        process.on('unhandledRejection', handler)

        // Simulate a connector method that rejects without being awaited
        const fakeConnector = {
            ping: async () => { throw connError }
        }

        // Call without await or .catch — simulates a real bug
        const p = fakeConnector.ping()

        setTimeout(() => {
            p.catch(() => {})
            if (!finished) {
                process.removeListener('unhandledRejection', handler)
            }
        }, 200)
    })
})
