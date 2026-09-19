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
function requireRow(row, what){
    if (row) return row
    throw new Error(what + ' never landed; the GAVE UP line above, from the '
        + 'matching check* poll, says whether the row is absent or landed with '
        + 'another status - read the indexer verdict for this tx')
}

// Keep the two-argument contract above synchronous and unchanged. Callers that
// opt into a give-up probe use this companion: a diagnostic failure is folded
// into the original failure instead of replacing it.
requireRow.withProbe = async function withProbe(row, what, probe, probeContext){
    if (row) return row

    let verdict
    try {
        verdict = await probe()
    } catch (err) {
        verdict = 'UNREACHABLE: ' + probeContext + '; query failed: ' + safeErrorText(err)
    }

    throw new Error(what + ' never landed; indexer verdict: ' + verdict)
}

requireRow.bridgeCreditEvidence = function bridgeCreditEvidence(
    {lockTxHash, destCoin, destAddress, tick, amount}
){
    return 'lock tx ' + lockTxHash + ', destination ' + destCoin + ', address '
        + destAddress + ', tick ' + tick + ', expected amount ' + amount
}

// Read once after waitForCredit gives up, without its amount filter. That makes
// an existing row with the wrong amount visible instead of looking absent.
// Credit rows are valid ledger effects by definition; older database accessors
// do not project a status column, so an omitted status is reported as valid.
requireRow.bridgeCreditAttribution = async function bridgeCreditAttribution(database, expected){
    const evidence = requireRow.bridgeCreditEvidence(expected)
    const row = await database.checkCredit({
        address: expected.destAddress,
        tick: expected.tick
    })

    if (!row) return 'ABSENT: ' + evidence + '; destination credit row not found'

    const foundStatus = row.status == null ? 'valid' : String(row.status)
    const foundAmount = row.amount == null ? 'unknown' : String(row.amount)
    if (foundStatus !== 'valid' || !sameDecimalAmount(foundAmount, expected.amount)) {
        return 'WRONG STATUS: ' + evidence + '; found status ' + foundStatus
            + ', amount ' + foundAmount + '; expected status valid, amount ' + expected.amount
    }

    return 'WRONG STATUS: ' + evidence + '; the row appeared only after the wait gave up; '
        + 'found status valid, amount ' + foundAmount + '; expected status valid, amount '
        + expected.amount
}

function sameDecimalAmount(left, right){
    return canonicalDecimal(left) === canonicalDecimal(right)
}

function canonicalDecimal(value){
    const text = String(value).trim()
    const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(text)
    if (!match) return text
    const whole = match[2].replace(/^0+(?=\d)/, '')
    const fraction = (match[3] || '').replace(/0+$/, '')
    const zero = whole === '0' && fraction === ''
    return (match[1] === '-' && !zero ? '-' : '') + whole + (fraction ? '.' + fraction : '')
}

// Error messages are useful evidence, but connection errors can include a DSN
// or key/value configuration. Preserve the cause while removing secret values.
function safeErrorText(err){
    return String(err && err.message ? err.message : err)
        .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
        .replace(/(\b[\w.-]*(?:pass(?:word)?|pwd|secret|token)[\w.-]*\b\s*[:=]\s*)([^\s,;]+)/gi,
            '$1[REDACTED]')
}

module.exports = requireRow
