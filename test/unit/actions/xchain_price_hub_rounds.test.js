/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict'

// Offline guard for the hub-published supersession drill. The root hook's fee
// seeds share the price_snapshots table the hub's snapshot route serves, at rounds
// above SEED_ROUND_FLOOR, so an unfiltered read sorted them last and the drill took
// a seed (XCHAIN/USD 2.00000000, round 888100011) as the hub's carry-forward on the
// 2026-10-25 rail drive.

const assert = require('assert')

const venue = require('../../actions/xchain_price_derivation.test/helpers/venue.test')
const steps = require('../../actions/xchain_price_derivation.test/helpers/supersession.test')

const row = (id, round, pair, price, status = 'finalized') =>
    ({ id, round_number: String(round), coin_pair: pair, price, status })

// The shape the rail hub served that drive: real rounds, then seed rows above them.
const RAIL_ROWS = [
    row(1, 131935, 'XCHAIN/USD', '1.60461811'),
    row(2, 131935, 'BTC/USD', '80512.70000000'),
    row(3, 131936, 'XCHAIN/USD', '1.60445668'),
    row(4, 131936, 'BTC/USD', '80504.60000000'),
    row(5, 131937, 'XCHAIN/USD', '1.60445668', 'pending'),
    row(6, 888100002, 'XCHAIN/USD', '2.00000000'),
    row(7, 888100002, 'BTC/USD', '100000.00000000'),
    row(8, 888100011, 'XCHAIN/USD', '2.00000000'),
    row(9, 888100011, 'BTC/USD', '100000.00000000'),
]

function stubFetch(pages) {
    const calls = []
    const impl = async (url) => {
        calls.push(url)
        return { ok: true, json: async () => ({ rows: pages.shift() || [] }) }
    }
    return { impl, calls }
}

describe('xchain price derivation: hub rounds exclude seeded fixtures', function () {
    it('drops every row at or above SEED_ROUND_FLOOR and every unfinalized row', function () {
        const kept = venue.hubRounds(RAIL_ROWS)
        assert.deepStrictEqual(kept.map(r => r.id), [1, 2, 3, 4])
        assert(kept.every(r => Number(r.round_number) < venue.SEED_ROUND_FLOOR))
    })

    it('hubPriceSnapshots serves the newest pair rows from hub rounds, never a seed', async function () {
        const { impl, calls } = stubFetch([RAIL_ROWS])
        const rows = await venue.hubPriceSnapshots(impl)
        assert.strictEqual(calls.length, 1)
        assert.match(calls[0], /\/hub-db\/snapshot\/price_snapshots\?since_id=0&limit=5000$/)
        assert.strictEqual(venue.pairRows(rows, 'XCHAIN/USD').slice(-1)[0].price, '1.60445668')
        assert.strictEqual(venue.pairRows(rows, 'BTC/USD').slice(-1)[0].price, '80504.60000000')
    })

    it('a venue holding only seeds reads as not publishing XCHAIN/USD', async function () {
        const { impl } = stubFetch([RAIL_ROWS.filter(r => Number(r.round_number) > 888000000)])
        const rows = await venue.hubPriceSnapshots(impl)
        assert.strictEqual(venue.pairRows(rows, 'XCHAIN/USD').length, 0)
    })
})

describe('xchain price derivation: the frozen window names a missing drill leg', function () {
    it('lists the held fills and the drill leg that is not among them', function () {
        const selection = {
            ok: true,
            window: { fromBlockExclusive: 9000, toBlockInclusive: 10000 },
            fills: [{ venue: 'dex', actionIndex: 812, blockIndex: 9990 }],
        }
        const text = steps.describeFrozenWindow(selection, 10006, { dispenseActionIndex: '805', matchActionIndex: 812 })
        assert.match(text, /got 1 at tip 10006/)
        assert.match(text, /held \[dex#812@9990\]/)
        assert.match(text, /drill legs missing \[dispense#805\]/)
    })
})
