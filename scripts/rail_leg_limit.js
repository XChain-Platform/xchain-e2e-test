'use strict'

const MS_PER_MINUTE = 60 * 1000

function limitSchedule (limitMinutes, graceMinutes = 20) {
    return {
        termAtMs: limitMinutes * MS_PER_MINUTE,
        killAtMs: limitMinutes * MS_PER_MINUTE + graceMinutes * MS_PER_MINUTE,
    }
}

function parseGraceMinutes (value) {
    const minutes = Number(value)
    if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error('teardown grace minutes must be a positive finite number: ' + String(value))
    }
    return minutes
}

module.exports = { limitSchedule, parseGraceMinutes }
