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

const MESSAGE_LIMIT = 4000

function caseJournalEntry(test, suite, blocked){
    const source = test || {}
    const err = source.err || null
    const state = String(source.state || 'unfinished')
    const blockedCase = state === 'pending' && typeof blocked === 'string' && blocked !== ''
    return {
        suite,
        title: String(source.title || ''),
        state,
        durationMs: Number(source.duration || 0),
        error: err ? String(err.message).slice(0, MESSAGE_LIMIT) : null,
        skipReason: blockedCase ? String(blocked).slice(0, MESSAGE_LIMIT) : null,
    }
}

module.exports = { caseJournalEntry }
