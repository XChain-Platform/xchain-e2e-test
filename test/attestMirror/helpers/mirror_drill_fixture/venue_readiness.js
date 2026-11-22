'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************/

const assert = require('assert')

const xchainPrice = require('../../../helpers/xchainPriceConstants')
const { queryVenueDb } = require('./database_reads')

const CANONICAL_COIN_USD = 100000
const PRICE_TOLERANCE = 10

async function waitForVenueIndexersAtTip (venue, opts) {
    const o = opts || {}
    const timeoutMs = Number(o.timeoutMs || 150 * 60 * 1000)
    const maxLag = Number.isFinite(Number(o.maxLag)) ? Number(o.maxLag) : 1
    const deadline = Date.now() + timeoutMs
    const started = Date.now()

    let last = null
    let announced = false
    let lastReport = Date.now()
    let lastWorst = null
    while (Date.now() < deadline) {
        const seen = []
        for (const ix of venue.indexers) {
            let s = null
            try { s = await venue.statusOf(ix.index) } catch (internal) { s = null }
            const b = (s && s.body) || {}
            seen.push({
                index: ix.index,
                height: Number.isFinite(Number(b.indexerBlock)) ? Number(b.indexerBlock) : null,
                decoder: Number.isFinite(Number(b.decoderBlock)) ? Number(b.decoderBlock) : null,
                reason: b.stallReason || null,
                klass: b.stallClass || null,
            })
        }
        last = seen

        const readable = seen.filter((s) => s.height !== null && s.decoder !== null)
        const caught = readable.length === seen.length &&
            readable.every((s) => (s.decoder - s.height) <= maxLag)
        if (caught) {
            await waitForVenuePrices(venue)
            console.log('mirrorDrillFixture: venue indexers caught the chain after ' +
                Math.round((Date.now() - started) / 1000) + 's at ' +
                seen.map((s) => s.index + '=' + s.height).join(', '))
            return seen
        }

        const worst = readable.reduce((a, s) => Math.max(a, s.decoder - s.height), 0)
        if (!announced) {
            announced = true
            console.log('mirrorDrillFixture: holding until the venue indexers catch the chain. ' +
                'Behind by up to ' + worst + ' block(s) (' +
                seen.map((s) => s.index + '=' + s.height + '/' + s.decoder).join(', ') +
                '). NOTHING IS MINED while this runs, deliberately: every mined block is one more ' +
                'for these nodes to chase. Progress is reported below; no duration is predicted ' +
                'because the replay rate varies by more than two orders of magnitude with chain ' +
                'content and host load.')
        } else if (Date.now() - lastReport >= 120000) {
            lastReport = Date.now()
            const moved = lastWorst === null ? null : (lastWorst - worst)
            console.log('mirrorDrillFixture: catching up, ' + worst + ' block(s) behind (' +
                seen.map((s) => s.index + '=' + s.height).join(', ') + ')' +
                (moved === null ? '' :
                    ', closed ' + moved + ' in the last 2 min' +
                    (moved <= 0 ? ' -- NOT ADVANCING, check host load before waiting further' : '')) +
                '.')
            lastWorst = worst
        }
        if (lastWorst === null) lastWorst = worst
        await new Promise((r) => setTimeout(r, 5000))
    }

    assert.fail('mirrorDrillFixture: the venue indexers did not catch the chain within ' +
        timeoutMs + 'ms: ' +
        (last || []).map((s) => 'indexer ' + s.index + ' at ' + s.height + ' of ' + s.decoder +
            (s.reason ? ' (' + s.klass + '/' + s.reason + ')' : '')).join('; ') +
        '. Making a request now would put it at a block these nodes have not reached, and the ' +
        'response would read as "not applied" when the node simply has not got there yet. If they ' +
        'are not advancing at all, check the stall reason above rather than extending this budget.')
}

async function waitForVenuePrices (venue, opts) {
    const o = opts || {}
    const timeoutMs = Number(o.timeoutMs || 20 * 60 * 1000)
    const deadline = Date.now() + timeoutMs
    const tick = String(global.COIN_CODE || 'BTC').toUpperCase()
    const pairs = [tick + '/USD', 'XCHAIN/USD']
    let last = ''
    let announced = false

    while (Date.now() < deadline) {
        const missing = []
        for (const ix of venue.indexers) {
            for (const pair of pairs) {
                let rows = []
                try {
                    rows = await queryVenueDb(venue, ix.mirrorDbName,
                        'SELECT price, round_number, reference_block, block_timestamp ' +
                        'FROM price_snapshots WHERE coin_pair = ? AND price IS NOT NULL ' +
                        "AND status = 'finalized' ORDER BY round_number DESC LIMIT 3", [pair])
                } catch (internal) { rows = [] }
                const px = (rows && rows.length) ? Number(rows[0].price) : null
                const want = pair === 'XCHAIN/USD'
                    ? Number(xchainPrice.BOOTSTRAP_XCHAIN_USD) : CANONICAL_COIN_USD
                const sane = px !== null && Number.isFinite(px) &&
                    px >= want / PRICE_TOLERANCE && px <= want * PRICE_TOLERANCE
                if (!sane) {
                    const detail = (rows || []).map((r) =>
                        Number(r.price) + '@round ' + r.round_number + '/ref ' + r.reference_block).join(', ')
                    missing.push(ix.index + ':' + pair +
                        (px === null ? ' (absent)' : ' (' + px + '; top rounds: ' + detail + ')'))
                }
            }
        }
        if (missing.length === 0) {
            console.log('mirrorDrillFixture: every venue indexer sees a finalized price for ' +
                pairs.join(' and ') + '.')
            return true
        }
        last = missing.join(', ')
        if (!announced) {
            announced = true
            console.log('mirrorDrillFixture: waiting for the venue hubs to publish their first oracle ' +
                'round. Missing ' + last + '. A priced action, which includes a contract deploy, is ' +
                'refused until both pairs are present, and that refusal surfaces much later as a ' +
                'mirror row that never applies.')
        }
        await new Promise((r) => setTimeout(r, 5000))
    }

    assert.fail('mirrorDrillFixture: the venue hubs never published a usable oracle price within ' +
        timeoutMs + 'ms; still missing ' + last + '. Deploying now would fail the constructor for a ' +
        'missing price and no attestation request would ever be emitted on the venue nodes.')
}

module.exports = { waitForVenueIndexersAtTip, waitForVenuePrices }
