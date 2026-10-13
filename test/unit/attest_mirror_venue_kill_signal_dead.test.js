const assert = require('assert')
const { EventEmitter } = require('events')

const { AttestMirrorVenue } = require('../helpers/attestMirrorVenue')

// A stand-in child process. It records the signals sent to it and emits 'exit'
// on SIGTERM only when `exitsOnTerm` is set.
function fakeProc({ exitCode = null, signalCode = null, exitsOnTerm = true } = {}) {
    const proc = new EventEmitter()
    proc.exitCode = exitCode
    proc.signalCode = signalCode
    proc.signals = []
    proc.kill = (sig) => {
        proc.signals.push(sig)
        if (sig === 'SIGTERM' && exitsOnTerm) setImmediate(() => proc.emit('exit', null, 'SIGTERM'))
        return true
    }
    return proc
}

const kill = (proc) => AttestMirrorVenue.prototype['_kill'].call({}, proc)

const within = (promise, ms) => Promise.race([
    promise.then(() => 'done'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), ms))
])

describe('AttestMirrorVenue._kill on an already-dead child', function () {
    it('returns at once for a child dead by a signal (exitCode null, signalCode set)', async function () {
        const proc = fakeProc({ signalCode: 'SIGKILL', exitsOnTerm: false })
        assert.strictEqual(await within(kill(proc), 500), 'done')
        assert.deepStrictEqual(proc.signals, [])
    })

    it('returns at once for a child that exited with a code', async function () {
        const proc = fakeProc({ exitCode: 0, exitsOnTerm: false })
        assert.strictEqual(await within(kill(proc), 500), 'done')
        assert.deepStrictEqual(proc.signals, [])
    })

    it('ignores a missing process', async function () {
        assert.strictEqual(await within(kill(null), 500), 'done')
    })

    it('still terminates a live child', async function () {
        const proc = fakeProc()
        assert.strictEqual(await within(kill(proc), 500), 'done')
        assert.deepStrictEqual(proc.signals, ['SIGCONT', 'SIGTERM'])
    })
})
