/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

const fs = require('fs')

function readBaseline(filePath, displayPath = filePath) {
    let parsed
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (error) {
        return { ok: false, error: displayPath + ' is not valid JSON: ' + error.message }
    }

    const count = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed.count : undefined
    if (!Number.isInteger(count) || count < 0) {
        return { ok: false, error: displayPath + ' has no valid non-negative integer "count"; ' +
            'regenerate it with: node bin/check-sleep-flake.js --write-baseline' }
    }
    return { ok: true, count }
}

module.exports = { readBaseline }
