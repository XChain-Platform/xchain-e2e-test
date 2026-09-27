'use strict'

const assert = require('assert')

const { limitSchedule, parseGraceMinutes } = require('../../../scripts/rail_leg_limit')

describe('rail leg limit schedule', function () {
    it('uses a 45 minute limit and the default 20 minute grace', function () {
        const schedule = limitSchedule(45)

        assert.strictEqual(schedule.termAtMs, 45 * 60 * 1000)
        assert.strictEqual(schedule.killAtMs - schedule.termAtMs, 20 * 60 * 1000)
    })

    it('allows a five minute grace after the limit', function () {
        const schedule = limitSchedule(45, 5)

        assert.strictEqual(schedule.termAtMs, 45 * 60 * 1000)
        assert.strictEqual(schedule.killAtMs - schedule.termAtMs, 5 * 60 * 1000)
    })
})

describe('rail leg teardown grace parser', function () {
    it('accepts a positive finite minute value', function () {
        assert.strictEqual(parseGraceMinutes('20'), 20)
    })

    for (const value of ['0', '-1', 'x']) {
        it('rejects ' + value + ' and names the value', function () {
            assert.throws(() => parseGraceMinutes(value), new RegExp(value.replace('-', '\\-')))
        })
    }
})
