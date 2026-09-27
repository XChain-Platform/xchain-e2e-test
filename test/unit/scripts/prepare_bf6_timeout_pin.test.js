'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const SOURCE_PATH = path.join(__dirname, 'prepare_bf6_mixed_hub.test.js')

describe('BF6 mixed hub timeout pin', function () {
    it('keeps the real-checkout suite timeout at or above 240 seconds', function () {
        const source = fs.readFileSync(SOURCE_PATH, 'utf8')
        const suiteStart = source.indexOf("describe('BF6 mixed hub checkout preparer'")
        const firstCase = source.indexOf('\n    it(', suiteStart)
        const suiteSetup = source.slice(suiteStart, firstCase)
        const timeout = suiteSetup.match(/this\.timeout\(\s*(\d+)\s*(?:\*\s*(\d+)\s*)?\)/)

        assert.ok(suiteStart >= 0, 'BF6 mixed hub checkout preparer describe block is missing')
        assert.ok(firstCase >= 0, 'BF6 mixed hub checkout preparer has no cases')
        assert.ok(timeout, 'BF6 mixed hub checkout preparer timeout is missing')
        assert.ok(Number(timeout[1]) * Number(timeout[2] || 1) >= 240000,
            'BF6 mixed hub checkout preparer timeout must be at least 240000 ms')
    })
})
