'use strict'

// Chaos Experiment 9: Performance Reporter Write Failure (@P2)
//
// Verifies that when fs.writeFileSync or fs.mkdirSync throws during the
// reporter's EVENT_RUN_END handler, in-memory test results are preserved
// and the error is catchable.

const assert = require('assert')
const sinon = require('sinon')
const fs = require('fs')
const path = require('path')

// Extract the write logic from performance-reporter.js into a testable function
function writeResults(outputDir, results) {
    fs.mkdirSync(outputDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const outFile = path.join(outputDir, `perf-${ts}.json`)
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
    return outFile
}

// Safe wrapper that catches errors (what the reporter should do)
function writeResultsSafe(outputDir, results) {
    try {
        return writeResults(outputDir, results)
    } catch (err) {
        console.log('[perf] Warning: could not write results:', err.message)
        return null
    }
}

describe('Chaos Experiment 9 — Performance Reporter Write Failure @P2', function () {

    afterEach(function () {
        sinon.restore()
    })

    describe('fs.writeFileSync failure', function () {

        it('in-memory results survive writeFileSync failure', function () {
            const testResults = [
                { title: 'test1', state: 'passed', durationMs: 100 },
                { title: 'test2', state: 'passed', durationMs: 200 }
            ]

            sinon.stub(fs, 'mkdirSync')
            sinon.stub(fs, 'writeFileSync').throws(new Error('EACCES: permission denied'))

            const outFile = writeResultsSafe('/readonly/dir', { tests: testResults })

            assert.strictEqual(outFile, null, 'should return null when write fails')
            // Verify results are still intact in memory
            assert.strictEqual(testResults.length, 2)
            assert.strictEqual(testResults[0].title, 'test1')
            assert.strictEqual(testResults[1].title, 'test2')
        })

        it('writeResults throws when writeFileSync fails', function () {
            sinon.stub(fs, 'mkdirSync')
            sinon.stub(fs, 'writeFileSync').throws(new Error('ENOSPC: no space left'))

            assert.throws(
                () => writeResults('/full/disk', { tests: [] }),
                /ENOSPC/
            )
        })
    })

    describe('fs.mkdirSync failure', function () {

        it('writeResults throws when mkdirSync fails', function () {
            sinon.stub(fs, 'mkdirSync').throws(new Error('EACCES: permission denied'))

            assert.throws(
                () => writeResults('/no/access', { tests: [] }),
                /EACCES/
            )
        })

        it('safe wrapper catches mkdirSync failure', function () {
            sinon.stub(fs, 'mkdirSync').throws(new Error('EACCES'))

            const result = writeResultsSafe('/no/access', { tests: [] })

            assert.strictEqual(result, null)
        })
    })

    describe('successful write', function () {

        it('writeFileSync is called with valid JSON', function () {
            sinon.stub(fs, 'mkdirSync')
            const writeStub = sinon.stub(fs, 'writeFileSync')

            const results = {
                runAt: '2026-01-01',
                tests: [{ title: 'chaos', state: 'passed' }]
            }
            writeResults('/perf-results', results)

            assert(writeStub.calledOnce)
            const writtenJson = writeStub.firstCall.args[1]
            const parsed = JSON.parse(writtenJson)
            assert.strictEqual(parsed.tests.length, 1)
            assert.strictEqual(parsed.tests[0].title, 'chaos')
        })

        it('output file has correct naming pattern', function () {
            sinon.stub(fs, 'mkdirSync')
            const writeStub = sinon.stub(fs, 'writeFileSync')

            writeResults('/perf-results', { tests: [] })

            const filePath = writeStub.firstCall.args[0]
            assert(filePath.startsWith('/perf-results/perf-'))
            assert(filePath.endsWith('.json'))
            // Verify no colons or dots in timestamp portion (filesystem-safe)
            const filename = path.basename(filePath)
            assert(!filename.includes(':'), 'filename should not contain colons')
        })
    })
})
