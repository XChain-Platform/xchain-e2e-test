// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Turn a give-up from a waitFor* poll into a failure AT THE WAIT.
//
// Database.waitForX returns null when it runs out of budget, which is right
// for a NEGATIVE poll: a test proving a row never lands needs the timeout to
// come back as data. It is exactly wrong inside a fixture builder, where the
// caller needs the row to exist. A null walking out of a builder is a silent
// swallow: it is stored in the returned fixture, the test walks on, and the
// failure surfaces several assertions later on the wrong rule. That is how a
// rejected parent ISSUE hid a DOGE caret root cause behind a "wrong rejection
// status" failure.
//
// The thrown message points at the GAVE UP line the poll already printed,
// because that line is what separates "the row is absent" from "the row
// landed with another status".
module.exports = function requireRow(row, what){
    if (row) return row
    throw new Error(what + ' never landed; the GAVE UP line above, from the '
        + 'matching check* poll, says whether the row is absent or landed with '
        + 'another status - read the indexer verdict for this tx')
}
