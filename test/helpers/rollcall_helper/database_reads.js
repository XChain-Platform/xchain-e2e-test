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
 ********************************************************************/

'use strict'

const assert = require('assert')
const chainRail = require('../chainRail')

async function onChainSigners(...args){ return require('./chain_driving').onChainSigners(...args) }

// A venue whose BTC chain was reset while DOGE was not still carries the OLD
// chain's ROLLCALL rows keyed by the same epoch heights, and the peer read is
// first-seen per (epoch, pubkey): at such a height a fresh signature is
// shadowed and dropped on ledger_hash, so the epoch stays unrolled (silently
// wasting a drive) or, with only some keys shadowed, ROLLS with a bogus
// absence on a SIGNING key that the K-streak then counts. None of the epochs a
// suite is about to drive has happened on this chain yet, so ANY row at those
// heights is foreign. Measured 2026-09-08: 44 such heights after a BTC-only
// reset, epoch 4470 dropped all three engines. The remedy is to mine the BTC
// chain past the last such height, which is why this fails loud instead of
// skipping: a skipped epoch reads as a slow drive, not as a venue fact.
async function assertEpochsUnshadowed(ctx, epochs){
    const keys = ctx.roster.map(r => r.pubkey)
    const shadowed = []
    for (const E of epochs){
        const have = await onChainSigners(ctx, E, keys)
        if (have.size) shadowed.push({ epoch: E, keys: Array.from(have).map(k => k.slice(0, 8)) })
    }
    assert.deepStrictEqual(shadowed, [],
        'ROLLCALL precondition FAILED: the DOGE side already holds signer rows for epoch(s) the BTC chain has not ' +
        'reached: ' + shadowed.map(s => s.epoch + ' (' + s.keys.join(',') + ')').join(', ') + '. These are rows from ' +
        'a pre-reset chain; a fresh signature from the same key would be shadowed (first-seen per epoch and pubkey) ' +
        'and dropped on ledger_hash, so these epochs cannot roll cleanly. Mine the BTC chain past the last such ' +
        'height (tmp/zc-probe/probe-doge-legacy-epochs.js lists them) or reset the DOGE chain too, then re-run.')
    return epochs
}

// ── BTC-side reads, straight against the real tables ─────────────────────────
//
// There is no JSON-RPC read for stakes, unstakes, delegations or validator
// rewards on origin/develop, so these go to the indexer database the suite is
// already connected to. That is also the stronger choice: a mocked database
// cannot fail on a wrong column name, and two such bugs shipped green this week.

async function rollcallRow(ctx, epoch){
    const rows = await ctx.idxQuery(
        'SELECT epoch_height, snapshot_block, close_block, rolled, responsible_set_json FROM rollcalls WHERE epoch_height = ?',
        [epoch])
    return rows.length ? rows[0] : null
}

async function absenceRows(ctx, epoch){
    return await ctx.idxQuery(
        `SELECT ra.epoch_height, ia.address AS source, ra.close_block, ra.evicted
           FROM rollcall_absences ra
           JOIN index_addresses ia ON ia.id = ra.source_id
          WHERE ra.epoch_height = ?
          ORDER BY ia.address ASC`, [epoch])
}

// The BTC-side gate lists an epoch's close recorded, one row per VERIFIED signer
// of a ROLLED v1 epoch. This is the only artifact the rules-aware attestation
// filter reads, so a drill asserts on it directly rather than inferring it from
// the filter's own answer: an empty table and a filter that never ran produce the
// same capability set, and only one of them is correct.
//
// gates_json is stored as a JSON array; parsed here so a caller compares lists
// rather than string spellings.
async function rollcallGatesRows(ctx, epoch){
    const rows = await ctx.idxQuery(
        'SELECT epoch_height, pubkey, close_block, gates_json FROM rollcall_gates ' +
        'WHERE epoch_height = ? ORDER BY pubkey ASC', [epoch])
    return rows.map(r => {
        let gates = null
        // A row this harness cannot parse is reported as null rather than as [],
        // because [] is what the FILTER reads a malformed row as ("knows no gate",
        // so dropped) and a drill must be able to tell the two apart.
        try { const p = JSON.parse(String(r.gates_json)); if (Array.isArray(p)) gates = p.map(String) } catch (e) { gates = null }
        return { epoch_height: Number(r.epoch_height), pubkey: String(r.pubkey).toLowerCase(),
                 close_block: Number(r.close_block), gates }
    })
}

// The synthetic UNSTAKE rows an eviction mints: one per (source, signing key)
// with a sweepable balance, marked by action_format = 3.
async function evictionUnstakes(ctx, source){
    return await ctx.idxQuery(
        `SELECT u.action_index, u.cooldown_end_block, u.amount, u.block_index,
                p.pubkey  AS signing_pubkey, a.address AS source, st.status AS status
           FROM unstakes u
           JOIN actions       act ON act.action_index = u.action_index
           JOIN index_pubkeys    p ON p.id  = u.signing_pubkey_id
           JOIN index_addresses  a ON a.id  = u.source_id
           JOIN index_statuses  st ON st.id = u.status_id
          WHERE act.action_format = 3 AND a.address = ?
          ORDER BY u.action_index ASC`, [source])
}

async function stakeDeactivations(ctx, source){
    return await ctx.idxQuery(
        `SELECT p.pubkey AS signing_pubkey, s.deactivation_block AS deactivation_block, st.status AS status
           FROM stakes s
           JOIN index_addresses a ON a.id  = s.source_id
           JOIN index_pubkeys   p ON p.id  = s.signing_pubkey_id
           JOIN index_statuses st ON st.id = s.status_id
          WHERE a.address = ?
          ORDER BY s.action_index ASC`, [source])
}

async function delegationDeactivations(ctx, source){
    return await ctx.idxQuery(
        `SELECT d.action_index, d.deactivation_block AS deactivation_block
           FROM delegations d
           JOIN index_addresses a ON a.id = d.source_id
          WHERE a.address = ? ORDER BY d.action_index ASC`, [source])
}

// The DOGE-side record of who was counted for an epoch: the raw signed material
// the BTC close re-verifies. Read from the DOGE indexer's own database so a
// column-name drift cannot pass.
async function dogeSigners(ctx, epoch){
    return await chainRail.withRail(ctx.dogeRail, async () => {
        const conn = await indexerDatabase.getConnection()
        try {
            return await conn.query(
                'SELECT pubkey, publisher, action_index, block_index, ledger_hash FROM rollcall_signers ' +
                'WHERE epoch_height = ? ORDER BY action_index ASC, pubkey ASC', [epoch])
        } finally { await conn.release() }
    })
}

module.exports = {
    rollcallRow,
    absenceRows,
    rollcallGatesRows,
    evictionUnstakes,
    stakeDeactivations,
    delegationDeactivations,
    dogeSigners,
    assertEpochsUnshadowed,
}
