'use strict'

const assert = require('assert')

const { resolveDogeFeeDestination } = require('../../../helpers/rail_preflight/policy_fee_destination')

const NOT_READY_MESSAGE = 'feeschedule not ready: empty fee destination'

function assertNotReady(schedule){
    assert.throws(
        () => resolveDogeFeeDestination(schedule),
        (error) => error instanceof Error && error.message === NOT_READY_MESSAGE
    )
}

describe('resolveDogeFeeDestination', function () {
    it('returns a populated fee destination when native fees are enabled', function () {
        assert.strictEqual(
            resolveDogeFeeDestination({ nativeFeeEnabled: true, feeDestination: 'DFeeDestination111' }),
            'DFeeDestination111'
        )
    })

    it('rejects an empty fee destination', function () {
        assertNotReady({ nativeFeeEnabled: true, feeDestination: '' })
    })

    it('rejects a missing fee destination', function () {
        assertNotReady({ nativeFeeEnabled: true })
    })

    it('rejects a schedule with native fees disabled', function () {
        assertNotReady({ nativeFeeEnabled: false, feeDestination: 'DFeeDestination111' })
    })

    it('rejects an error schedule', function () {
        assertNotReady({ error: 'indexer not ready' })
    })

    it('rejects a null schedule', function () {
        assertNotReady(null)
    })

    it('rejects an undefined schedule', function () {
        assertNotReady(undefined)
    })
})
