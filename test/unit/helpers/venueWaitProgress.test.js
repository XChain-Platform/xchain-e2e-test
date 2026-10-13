'use strict'

// Progress lines from the venue waits. waitForFinalizedTransfer says only elapsed and
// budget left (no row is quoted before one matches); waitForBridgeApplied adds the
// destination tip block_time and the AWAITED transfer's own effective_time.

const assert = require('assert')
const build = require('../../helpers/bridge_rail_venue/venue_transfer_reads')

function methods() {
    const d = build({ mariadb: {}, xchainPrice: {}, verdictOf: () => null })
    const o = {}
    Object.defineProperties(o, d)
    return o
}

describe('venue wait progress', function () {
    it('waitForFinalizedTransfer logs elapsed and budget left, quoting no row', async function () {
        const v = methods()
        v.hubs = [{ index: 0, dbName: 'h0' }]
        v.queryHubDb = async () => [{ id: 9, transfer_id: 'other', effective_time: 111111 }]
        const lines = []
        const got = await v.waitForFinalizedTransfer(() => false,
            { timeoutMs: 400, progressMs: 100, pollMs: 20, log: (l) => lines.push(l) })
        assert.strictEqual(got, null)
        assert.ok(lines.length >= 2, 'expected several progress lines, got ' + lines.length)
        for (const l of lines) {
            assert.ok(/elapsed \d+s, left \d+s/.test(l), l)
            assert.ok(!/111111|effective_time/.test(l), 'unrelated row leaked: ' + l)
        }
    })

    it('waitForBridgeApplied logs tip block_time and the awaited transfer effective_time', async function () {
        const v = methods()
        const mirrorSql = []
        v.queryIndexerDb = async (chain, sql) => /bridge_settlements/.test(sql) ? []
            : [{ block_index: 50, block_time: 1700000500 }]
        v.queryMirrorDb = async (chain, sql, params) => {
            mirrorSql.push([sql, params])
            // The newest row belongs to another transfer; only the id filter finds ours.
            const table = { other: 999, T1: 1700000900 }
            return params[0] in table ? [{ effective_time: table[params[0]] }] : []
        }
        const lines = []
        const got = await v.waitForBridgeApplied('DOGE', 'T1',
            { timeoutMs: 300, progressMs: 100, pollMs: 20, log: (l) => lines.push(l) })
        assert.strictEqual(got, null)
        assert.ok(lines.length >= 1)
        for (const l of lines) {
            assert.ok(/elapsed \d+s, left \d+s/.test(l), l)
            assert.ok(l.includes('block_time 1700000500'), l)
            assert.ok(l.includes('effective_time 1700000900'), l)
            assert.ok(!l.includes('999'), l)
        }
        assert.ok(mirrorSql.every(([sql, p]) => /WHERE transfer_id = \?/.test(sql) && p[0] === 'T1'))
    })

    it('waitForBridgeApplied reports unread rather than throwing when reads fail', async function () {
        const v = methods()
        v.queryIndexerDb = async (chain, sql) => { if (/bridge_settlements/.test(sql)) return []; throw new Error('x') }
        v.queryMirrorDb = async () => { throw new Error('y') }
        const lines = []
        await v.waitForBridgeApplied('BTC', 'T2', { timeoutMs: 250, progressMs: 100, pollMs: 20, log: (l) => lines.push(l) })
        assert.ok(lines.length >= 1 && /tip unread, transfer effective_time unread/.test(lines[0]), lines[0])
    })
})
