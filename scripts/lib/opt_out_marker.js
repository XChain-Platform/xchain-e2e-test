/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Shared opt-out marker check for the scripts/check-*.js lint gates.
 *
 * A gate lets a site opt out with `// <name>: <reason>`, and every gate's
 * header says the reason is a sentence, not a pragma. This module is where
 * that rule is enforced: a marker counts only with a real reason after it.
 *
 ********************************************************************/

'use strict'

// Require a reason of at least this many words on the marker's own line.
const MIN_REASON_WORDS = 3

// Count a token as a word only when it holds a letter, so punctuation is not a reason.
function reasonWords (text) {
    return text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length
}

// Build a predicate for `// <name>: <reason>` in a source line, or for `<name>: <reason>`
// at the start of comment text (commentText: true) when a parser has already stripped the slashes.
function optOutMarker (name, { commentText = false } = {}) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const marker = new RegExp((commentText ? '^\\s*' : '\\/\\/\\s*') + escaped + ':(.*)$')
    return (text) => {
        const m = marker.exec(text || '')
        return !!m && reasonWords(m[1]) >= MIN_REASON_WORDS
    }
}

module.exports = { MIN_REASON_WORDS, optOutMarker, reasonWords }
