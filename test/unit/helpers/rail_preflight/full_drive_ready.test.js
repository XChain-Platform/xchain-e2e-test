'use strict'

const assert = require('assert')
const Module = require('module')
const path = require('path')

const railDriveScript = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'rail_leg_drive.js')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (request === '../test/helpers/bridge_rail_legs' && parent && parent.filename === railDriveScript) {
        return { RAIL_DRIVES: {} }
    }
    return originalLoad.call(this, request, parent, isMain)
}
let checkFullDriveReady
try {
    ({ checkFullDriveReady } = require('../../../helpers/rail_preflight/full_drive_ready'))
} finally {
    Module._load = originalLoad
}

const healthyPing = JSON.stringify({ result: { status: 'healthy' } })
const competingDrive = ' 101 node ./node_modules/.bin/mocha test/integration/bridge_rail_token.test.js'

function check (overrides = {}) {
    return checkFullDriveReady({
        pingStatusCode: 200,
        pingBodyText: healthyPing,
        psText: '',
        ownPids: [],
        ...overrides,
    })
}

describe('checkFullDriveReady', function () {
    it('is ready when the hub is healthy and no other rail drive is running', function () {
        assert.deepStrictEqual(check(), { ready: true, reason: null })
    })

    it('names the hub when only its ping is not ok', function () {
        assert.deepStrictEqual(check({ pingStatusCode: 503 }), { ready: false, reason: 'hub' })
    })

    it('names the other drive when only a competing rail drive is running', function () {
        assert.deepStrictEqual(check({ psText: competingDrive }), {
            ready: false,
            reason: 'other-drive',
        })
    })

    it('names both blockers when the hub is not ok and another rail drive is running', function () {
        assert.deepStrictEqual(check({ pingBodyText: 'not json', psText: competingDrive }), {
            ready: false,
            reason: 'hub+other-drive',
        })
    })
})
