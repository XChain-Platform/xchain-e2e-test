// SPDX-License-Identifier: AGPL-3.0-or-later

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
