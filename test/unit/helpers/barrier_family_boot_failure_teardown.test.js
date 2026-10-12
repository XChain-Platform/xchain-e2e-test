'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************
 * bootFamilyVenue returns no handle when the boot fails, so it must stop the
 * half-built venue itself: otherwise its XChain_AM_* databases leak.
 ********************************************************************/

const assert = require('assert')
const Module = require('module')
const path = require('path')

const drivePath = require.resolve('../../attestMirror/helpers/barrierFamilyDrive')

describe('bootFamilyVenue failed-boot teardown', function () {
    let origLoad, drive, state

    beforeEach(function () {
        state = { stops: 0, released: 0, startResult: true, stopThrows: false, venue: null, schemas: [], queries: [] }
        const rail = { globals: { nodeConnector: { getBlockCount: async () => 100 } } }
        // The drive's collaborators reach into sibling repos this unit does not need: stub them per request.
        const stubs = {
            '../../helpers/chainRail': { createRail: async () => rail, withRail: async () => {} },
            './mirrorDrillWaits': { untilOrClearDogeStall: async (fn) => fn(), venueTipProbe: () => async () => null },
            '../../../src/XChainIndexerConnector.js': function () {},
            './barrierFamilyFixture': {
                buildFamilyVenue: () => ({ evidence: {}, venue: state.venue }),
                crossingArmHeight: () => 0,
                legacyEraBlock: () => null,
                stallSnapshot: () => ({}),
            },
            './barrierFamilyRows': {},
            '../../helpers/attestMirrorVenue': { resolveVenueBasePort: () => 0 },
            './attestMirrorVenue': { claimLegIsolation: () => ({ release: () => { state.released++ } }), claimOfflineSuite: () => {}, PORT_WINDOW_SPAN: 1 },
        }
        origLoad = Module._load
        Module._load = function (request, parent, isMain) {
            if (parent && parent.filename === drivePath && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request]
            return origLoad.apply(this, arguments)
        }
        delete require.cache[drivePath]
        drive = require(drivePath)
        state.venue = {
            label: 'stub',
            unavailable: 'boom',
            hubs: [],
            indexers: [],
            start: async () => state.startResult,
            stop: async () => { state.stops++; if (state.stopThrows) throw new Error('stop failed') },
            statusOf: async () => ({ body: { indexerBlock: 10, decoderBlock: 10 } }),
            ['_conn']: {
                query: async (sql, params) => {
                    state.queries.push({ sql, params })
                    if (sql.includes('information_schema.SCHEMATA')) return state.schemas.map((name) => ({ SCHEMA_NAME: name }))
                    return []
                },
            },
        }
    })

    afterEach(function () {
        Module._load = origLoad
        delete require.cache[drivePath]
    })

    it('stops the venue and releases the claim when start reports unavailable', async function () {
        state.startResult = false
        await assert.rejects(drive.bootFamilyVenue({ repoRoot: path.resolve('.'), label: 'bf5' }), /did not come up/)
        assert.strictEqual(state.stops, 1)
        assert.ok(state.released >= 1)
    })

    it('stops the venue when start throws', async function () {
        state.venue.start = async () => { throw new Error('spawn failed') }
        await assert.rejects(drive.bootFamilyVenue({ repoRoot: path.resolve('.'), label: 'bf5' }), /spawn failed/)
        assert.strictEqual(state.stops, 1)
    })

    it('drops historical BF5 databases when start throws after connecting', async function () {
        state.venue.label = 'bf5'
        state.schemas = Array.from({ length: 29 }, (_, i) => 'XChain_AM_MVH_bf5_failed' + i + '_Hub0')
        state.venue.start = async () => { throw new Error('spawn failed') }
        await assert.rejects(drive.bootFamilyVenue({ repoRoot: path.resolve('.'), label: 'bf5' }), /spawn failed/)
        assert.strictEqual(state.queries.filter((q) => q.sql.startsWith('DROP DATABASE')).length, 29)
        assert.strictEqual(state.stops, 1)
    })

    it('still surfaces the boot error when the teardown itself fails', async function () {
        state.startResult = false
        state.stopThrows = true
        await assert.rejects(drive.bootFamilyVenue({ repoRoot: path.resolve('.'), label: 'bf5' }), /did not come up/)
        assert.strictEqual(state.stops, 1)
        assert.ok(state.released >= 1)
    })

    it('drops the 29 historical BF5 databases without dropping the live venue schemas', async function () {
        state.venue.label = 'bf5'
        const leaked = Array.from({ length: 29 }, (_, i) => 'XChain_AM_MVH_bf5_old' + i + '_Hub0')
        const live = [
            'XChain_AM_MVH_bf5_live_Hub0',
            'XChain_AM_MVH_bf5_live_Ixr0',
            'XChain_AM_MVH_bf5_live_Mirror0',
        ]
        state.venue.hubs = [{ dbName: live[0] }]
        state.venue.indexers = [{ indexerDbName: live[1], mirrorDbName: live[2] }]
        state.schemas = leaked.concat(live, ['XChain_AM_MVH_bf50_foreign'])

        const up = await drive.bootFamilyVenue({ repoRoot: path.resolve('.'), label: 'bf5' })
        const dropped = state.queries.filter((q) => q.sql.startsWith('DROP DATABASE')).map((q) => q.sql)
        assert.strictEqual(dropped.length, 29)
        for (const name of leaked) assert.ok(dropped.includes('DROP DATABASE IF EXISTS `' + name + '`'))
        for (const name of live) assert.ok(!dropped.some((sql) => sql.includes('`' + name + '`')))
        assert.ok(!dropped.some((sql) => sql.includes('bf50_foreign')))
        await up.venue.stop()
    })
})
