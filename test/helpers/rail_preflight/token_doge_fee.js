'use strict'

const { dogeFeeSchedule } = require('./policy_at2_at4')

const dogeFeeScheduleWaits = new WeakMap()

async function waitForDogeFeeSchedule(state, timeoutMs, everyMs){
    let decision = dogeFeeSchedule(null)
    await state.venue.waitUntil('the DOGE fee schedule to name its destination', async () => {
        try {
            decision = dogeFeeSchedule(await state.venue.indexerRpc('DOGE', 'feeschedule', {}))
        } catch (error) {
            decision = dogeFeeSchedule(null)
        }
        return decision.ready
    }, { timeoutMs, everyMs })
    state.dogeRail.env.FEE_DESTINATION = decision.destination
    return decision.destination
}

async function ensureDogeFeeSchedule(state, timeoutMs, everyMs){
    let pending = dogeFeeScheduleWaits.get(state)
    if (!pending) {
        pending = waitForDogeFeeSchedule(state, timeoutMs, everyMs)
        dogeFeeScheduleWaits.set(state, pending)
    }
    try {
        return await pending
    } catch (error) {
        if (dogeFeeScheduleWaits.get(state) === pending) dogeFeeScheduleWaits.delete(state)
        throw error
    }
}

function withDogeFeeSchedule(T, state, { timeoutMs = 2 * 60 * 1000, everyMs = 2000 } = {}){
    const wrapped = Object.assign({}, T)
    wrapped.fundDoge = async (...args) => {
        await ensureDogeFeeSchedule(state, timeoutMs, everyMs)
        return T.fundDoge(...args)
    }
    wrapped.dogeAction = async (...args) => {
        await ensureDogeFeeSchedule(state, timeoutMs, everyMs)
        return T.dogeAction(...args)
    }
    return wrapped
}

module.exports = { withDogeFeeSchedule }
