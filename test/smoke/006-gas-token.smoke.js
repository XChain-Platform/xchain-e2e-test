// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')

describe('SMOKE: GAS Token', () => {
    it('should have the XCHAIN GAS token in the indexer database', async () => {
        const gasToken = await indexerDatabase.checkIssue({ tick: 'XCHAIN', status: 'valid' })
        assert(gasToken, 'GAS token (XCHAIN) should exist with status valid — bootstrap should have created it')
    })
})
