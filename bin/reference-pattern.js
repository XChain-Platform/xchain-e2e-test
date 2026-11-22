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

const CLOSING_QUOTE = '["\'`]'

function escapeEre(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function referencePattern(relPath) {
    const parts = relPath.split('/')
    const basename = parts.pop()
    const stem = basename.endsWith('.js') ? basename.slice(0, -3) : basename
    const alternatives = [
        `/${escapeEre(stem)}(\\.js)?${CLOSING_QUOTE}`,
        `/${escapeEre(basename)}([^[:alnum:]_]|$)`,
    ]

    if (basename === 'index.js' && parts.length > 0) {
        alternatives.push(`/${escapeEre(parts[parts.length - 1])}/?${CLOSING_QUOTE}`)
    }

    return `(${alternatives.join('|')})`
}

module.exports = { referencePattern }
