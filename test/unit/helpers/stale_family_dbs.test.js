'use strict'

const assert = require('assert')
const Module = require('module')
const { DB_PREFIX, staleStampedDbs } = require('../../attestMirror/helpers/stale_family_dbs')

function venueDbPrefix() {
    const venuePath = require.resolve('../../helpers/attestMirrorVenue')
    const originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
        if (!parent || parent.filename !== venuePath || Module.builtinModules.includes(request))
            return originalLoad.call(this, request, parent, isMain)
        if (request.endsWith('/hub_db_sync.js')) return { HUB_SYNC_WATERMARK_GRACE_S: {} }
        return {}
    }
    try {
        return require(venuePath).DB_PREFIX
    } finally {
        Module._load = originalLoad
        delete require.cache[venuePath]
    }
}

describe('stale family databases', function () {
    it('separates the latest stamp from stale and reusable databases', function () {
        const names = [
            DB_PREFIX + 'bf5_31_100_Rpl_Ixr0',
            DB_PREFIX + 'bf5_31_100_Hub0',
            DB_PREFIX + 'bf5_20_100_Mirror0',
            DB_PREFIX + 'bf5_20_100_Hub0',
            DB_PREFIX + 'bf5_10_zz_Mirror0',
            DB_PREFIX + 'bf5_10_zz_Hub0',
            DB_PREFIX + 'bf5_Mirror0',
            DB_PREFIX + 'bf5_Ixr0',
            DB_PREFIX + 'bf5mix_99_zzz_Hub0',
            DB_PREFIX + 'bf5x_99_zzz_Mirror0',
            DB_PREFIX + 'bf6_99_zzz_Hub0'
        ]

        assert.deepStrictEqual(staleStampedDbs(names, 'bf5'), {
            latestStamp: '31_100',
            stale: [
                DB_PREFIX + 'bf5_10_zz_Hub0',
                DB_PREFIX + 'bf5_10_zz_Mirror0',
                DB_PREFIX + 'bf5_20_100_Hub0',
                DB_PREFIX + 'bf5_20_100_Mirror0'
            ],
            current: [
                DB_PREFIX + 'bf5_31_100_Hub0',
                DB_PREFIX + 'bf5_31_100_Rpl_Ixr0'
            ],
            unstamped: [DB_PREFIX + 'bf5_Ixr0', DB_PREFIX + 'bf5_Mirror0']
        })
    })

    it('returns empty lists when the label has no databases', function () {
        assert.deepStrictEqual(staleStampedDbs([DB_PREFIX + 'bf6_1_a_Hub0'], 'bf5'), {
            latestStamp: null,
            stale: [],
            current: [],
            unstamped: []
        })
    })

    it('shares the mirror venue database prefix', function () {
        assert.strictEqual(DB_PREFIX, venueDbPrefix())
    })
})
