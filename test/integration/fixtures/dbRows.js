'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Mock database rows matching the shapes returned by db.js check* methods.
// Field names use the SQL aliases (tick, not tick_id; status, not status_id).

module.exports = {
    issueRow: (overrides = {}) => ({
        action_index: 1,
        tick: 'MYTOKEN',
        tx_hash: 'abc123',
        source: 'addr1',
        max_supply: '1000',
        max_mint: '100',
        decimals: 8,
        description: 'Test token',
        mint_supply: '50',
        status: 'valid',
        ...overrides
    }),

    sendRow: (overrides = {}) => ({
        action_index: 2,
        tick: 'MYTOKEN',
        tx_hash: 'def456',
        source: 'addr1',
        destination: 'addr2',
        amount: '100',
        memo: 'test memo',
        status: 'valid',
        ...overrides
    }),

    creditRow: (overrides = {}) => ({
        block_index: 100,
        tx_hash: 'abc123',
        tick: 'MYTOKEN',
        address: 'addr1',
        amount: '50',
        ...overrides
    }),

    debitRow: (overrides = {}) => ({
        block_index: 100,
        tx_hash: 'def456',
        tick: 'MYTOKEN',
        address: 'addr1',
        amount: '100',
        ...overrides
    }),

    dispenserRow: (overrides = {}) => ({
        action_index: 3,
        source: 'addr1',
        tx_hash: 'ghi789',
        give_coin: '',
        give_tick: 'MYTOKEN',
        give_amount: '10',
        give_escrow: '100',
        get_coin: 'BTC',
        get_tick: '',
        get_amount: '1000',
        status: 'valid',
        ...overrides
    }),

    batchRow: (overrides = {}) => ({
        action_index: 4,
        tx_hash: 'jkl012',
        source: 'addr1',
        status: 'valid',
        ...overrides
    }),
}
