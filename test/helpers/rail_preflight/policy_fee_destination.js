'use strict'

const NOT_READY_MESSAGE = 'feeschedule not ready: empty fee destination'

function resolveDogeFeeDestination(schedule){
    if (schedule && schedule.nativeFeeEnabled === true &&
        typeof schedule.feeDestination === 'string' && schedule.feeDestination.length > 0) {
        return schedule.feeDestination
    }
    throw new Error(NOT_READY_MESSAGE)
}

module.exports = { resolveDogeFeeDestination }
