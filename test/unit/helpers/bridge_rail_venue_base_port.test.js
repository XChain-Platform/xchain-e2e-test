// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict'

const assert = require('assert')
const {
    resolveRailVenueBasePort,
    checkStatusHasIndexerBlock,
    VENUE_BASE_PORT_ENV
} = require('../../helpers/attestMirrorVenue')

describe('bridge rail venue base port', () => {
    it('keeps the drive base when the env is unset or blank', () => {
        assert.strictEqual(resolveRailVenueBasePort(45000, {}), 45000)
        assert.strictEqual(resolveRailVenueBasePort(47000, { [VENUE_BASE_PORT_ENV]: '  ' }), 47000)
    })
    it('takes AB_VENUE_BASE_PORT when set', () => {
        assert.strictEqual(resolveRailVenueBasePort(45000, { AB_VENUE_BASE_PORT: '52000' }), 52000)
    })
    it('throws on an unusable value rather than falling back', () => {
        assert.throws(() => resolveRailVenueBasePort(45000, { AB_VENUE_BASE_PORT: 'abc' }), /not a usable probe base/)
        assert.throws(() => resolveRailVenueBasePort(45000, { AB_VENUE_BASE_PORT: '80' }), /not a usable probe base/)
    })
})

describe('venue bring-up /status shape', () => {
    it('accepts indexerBlock including 0', () => {
        assert.strictEqual(checkStatusHasIndexerBlock({ indexerBlock: 0 }).ok, true)
        assert.strictEqual(checkStatusHasIndexerBlock({ indexerBlock: 120, stallReason: 'x' }).ok, true)
    })
    it('rejects an answer lacking indexerBlock', () => {
        for (const body of [{}, { indexerBlock: null }, null, 'html', undefined]) {
            const r = checkStatusHasIndexerBlock(body)
            assert.strictEqual(r.ok, false)
            assert.ok(r.reason)
        }
    })
})
