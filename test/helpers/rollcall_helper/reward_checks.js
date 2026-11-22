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

const { internalResolveSibling } = require('./sibling_resolution')

async function rollcallRewards(ctx, epoch){
    return await ctx.idxQuery(
        `SELECT vr.amount, vr.block_index, vr.derive_block_index, vr.round_reference, vr.round_qualifier,
                ia.address AS source, ip.pubkey AS signing_pubkey
           FROM validator_rewards vr
           JOIN index_addresses ia ON ia.id = vr.source_id
           JOIN index_pubkeys   ip ON ip.id = vr.signing_pubkey_id
          WHERE vr.reward_type = 'rollcall_publish' AND vr.round_reference = ?`, [epoch])
}

// The exact arithmetic the COLLECT handler gates on (db.js getUnclaimedRewardTotal):
// everything minted for the source, less every VALID claim against it.
async function unclaimedRewardTotal(ctx, source, blockIndex){
    const rows = await ctx.idxQuery(
        `SELECT
            (SELECT COALESCE(SUM(CAST(vr.amount AS DECIMAL(65,18))), 0)
               FROM validator_rewards vr
               JOIN index_addresses a ON a.id = vr.source_id
              WHERE a.address = ? AND vr.block_index <= ?) AS minted,
            (SELECT COALESCE(SUM(CAST(rc.amount AS DECIMAL(65,18))), 0)
               FROM reward_claims rc
               JOIN index_addresses a2 ON a2.id = rc.source_id
               JOIN index_statuses  s  ON s.id  = rc.status_id
              WHERE a2.address = ? AND s.status = 'valid' AND rc.block_index <= ?) AS claimed`,
        [source, blockIndex, source, blockIndex])
    return Number(rows[0].minted) - Number(rows[0].claimed)
}

/**
 * The protocol REWARD address for the chain under test, read from the indexer's
 * own per-chain role map rather than pinned here.
 *
 * COLLECT debits this address, so a drill that funds it must fund exactly the
 * one the handler will read: the roles are encoded per chain, and a BTC address
 * is not the LTC or DOGE one.
 */
async function protocolRewardAddress(ctx){
    const coin = (global.COIN_CODE || 'BTC');
    const net  = (global.NETWORK || 'regtest');
    // One adapter for every chain: the per-coin config shims are gone, and the
    // coin bundle is now the source the indexer itself reads through.
    const rel  = 'src/coins/to_indexer_config.js';

    // ABSENCE MAY SKIP, PRESENT-BUT-BROKEN MUST BE RED, which is why the
    // resolve and the require are separated. Wrapping the require in a
    // try/catch swallows a sibling that is present and throws, and the caller
    // then reads null as "no reward address configured" and quietly declines to
    // fund the pool: the drill goes green having tested nothing.
    // UNGUARDED, matching rca() and eqh() above. A sibling that is present and
    // throws must be RED: swallowing it would hand the caller null, which reads
    // as "no reward address configured", and the drill would then decline to
    // fund the pool and pass having tested nothing.
    const cfg = require(internalResolveSibling('xchain-indexer', rel));
    const c   = (cfg && typeof cfg.toIndexerConfig === 'function') ? cfg.toIndexerConfig(coin, net) : null;
    if(c && c.ADDRESS && c.ADDRESS.REWARD) return String(c.ADDRESS.REWARD);
    return null;
}

/**
 * One address's balance for one tick, as a Number, or null when it cannot be read.
 *
 * NULL RATHER THAN ZERO on a failed read, deliberately: zero is a balance a
 * caller would act on, and funding decisions made from an unreadable balance
 * are how a drill spends real coin for no reason.
 */
async function addressTickBalance(ctx, address, tick){
    if(!address) return null;
    // THE TICK TABLE IS `index_tickers`, and the name is load-bearing rather
    // than cosmetic. This read named `index_ticks`, which does not exist in the
    // indexer schema, so every call threw 1146 and the catch below turned it
    // into null - and AT10's caller read null as "no funding needed" and drove a
    // COLLECT into an unfunded pool twice, each time failing with the handler's
    // `insufficient reward pool` and nothing in the drill's own log about the
    // pool at all. Measured 2026-09-04: the pool held 2 XCHAIN against a 120
    // claim while the leader held 5,200.
    // `ctx.idxQuery`, not `indexerDatabase.query`: that module exposes named
    // waiters and `getConnection()`, and has no bare `query`. The old call threw
    // TypeError on every invocation, which the catch turned into the same silent
    // null as the wrong table name did.
    const rows = await ctx.idxQuery(
        'SELECT b.amount AS amount FROM balances b ' +
        'JOIN index_addresses a ON a.id = b.address_id ' +
        'JOIN index_tickers t ON t.id = b.tick_id ' +
        'WHERE a.address = ? AND t.tick = ? LIMIT 1', [String(address), String(tick)]);
    // An address with no row for this tick holds none of it, which is a real
    // zero. A query that THROWS is an instrument fault and propagates: swallowing
    // it here is what hid the wrong table name for two runs.
    if(!rows || rows.length === 0) return 0;
    return Number(rows[0].amount);
}

module.exports = {
    protocolRewardAddress,
    addressTickBalance,
    rollcallRewards,
    unclaimedRewardTotal,
}
