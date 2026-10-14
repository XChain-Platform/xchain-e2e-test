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
 *
 * STAKE/UNSTAKE helpers keyed on the signing pubkey, and the cross_chain unwind.
 ********************************************************************/

'use strict';

const assert = require('assert');
const transactionHelper = require('../../helpers/core/transactionHelper');
const stakeTeardown     = require('../../helpers/stakeTeardown');
const chainRail         = require('../../helpers/chainRail');
const { railQuery, resilientSend, pumpUntil, capabilityWeights, waitForIndexedHeight } = require('./rail');

// STAKE/UNSTAKE broadcast + a DB wait keyed on the SIGNING PUBKEY.
//
// stakeHelper's own wait is keyed on the broadcast txid with a 60s budget, and
// both halves of that are wrong for this drill: a STAKE v1 carrying a 64-hex
// signing key is 87 bytes of payload, so the encoder always picks the two-phase
// P2SH path, and on a busy indexer the row can surface well after the budget.
// The failure mode is the expensive one - the stake IS on-chain and valid, the
// harness just gave up on it, and every later step then runs against a snapshot
// block that was never computed. Keying on the pubkey and polling until the row
// appears removes both.
async function stakeKeyFrom(rail, addressInfo, amount, pubkey, label) {
    await resilientSend(label, rail, () =>
        transactionHelper.createAndSendTransaction(addressInfo, 'STAKE|1|' + amount + '|' + pubkey));
    const row = await pumpUntil(label + ' row', rail, async () => {
        const rows = await railQuery(rail,
            'SELECT s.action_index, s.amount, s.activation_block, st.status ' +
            'FROM stakes s JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id ' +
            'LEFT JOIN index_statuses st ON st.id = s.status_id ' +
            'WHERE ip.pubkey = ? ORDER BY s.action_index DESC LIMIT 1', [String(pubkey).toLowerCase()]);
        return rows.length ? rows[0] : null;
    }, 300000);
    assert.strictEqual(String(row.status), 'valid', label + ' indexed ' + row.status);
    // Book the debt with the run's release ledger. The drill unwinds its
    // cross_chain stake by hand (it has to: the relay leg needs the majority
    // gone mid-run), while an unbooked attestation stake stays in the venue's
    // capability set for good, which is the accumulation this ledger prevents.
    // Only stakes on the BOOTSTRAPPED rail are booked: the root
    // afterAll sweeps through the globals initialCheck set, so a stake on the
    // origin rail would be swept against the wrong chain.
    if (rail && rail.code === global.COIN_CODE)
        stakeTeardown.registerStake({ addressInfo: addressInfo, signingPubkey: pubkey, amount: amount });
    return row;
}

async function unstakeKeyFrom(rail, addressInfo, pubkey, label) {
    await resilientSend(label, rail, () =>
        transactionHelper.createAndSendTransaction(addressInfo, 'UNSTAKE|0|' + pubkey));
    // Discharged here, so the root sweep does not broadcast a second UNSTAKE
    // that can only index invalid.
    stakeTeardown.noteUnstake({ signingPubkey: pubkey });
    return pumpUntil(label + ' row', rail, async () => {
        const rows = await railQuery(rail,
            'SELECT s.deactivation_block FROM stakes s JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id ' +
            'WHERE ip.pubkey = ? ORDER BY s.action_index DESC LIMIT 1', [String(pubkey).toLowerCase()]);
        return (rows.length && rows[0].deactivation_block != null) ? rows[0] : null;
    }, 300000);
}

// Mine to the UNSTAKE's deactivation height and CHECK the key stopped counting.
async function confirmUnwound(ctx, row) {
    // UNSTAKE schedules the deactivation a few blocks out, so the stake is
    // still counted until that height. On a venue whose idle miner is
    // paused nothing would ever reach it, and the drill would leave the
    // live federation in the stake minority it created. Mine to it and
    // CHECK, rather than declaring the venue restored on the broadcast.
    const deactivateAt = Number(row.deactivation_block);
    let tip = await global.nodeConnector.getBlockCount();
    if (Number.isFinite(deactivateAt) && tip < deactivateAt)
        await global.regtestMinerConnector.generateBlocks(deactivateAt - tip + 1);
    tip = await global.nodeConnector.getBlockCount();
    await waitForIndexedHeight(ctx.homeRail, tip);
    const still = (await capabilityWeights(ctx.homeRail, 'cross_chain', tip))
        .some(v => String(v.pubkey).toLowerCase() === ctx.relaySigner.pubkey);
    assert(!still, 'the drill cross_chain key still qualifies at ' + tip + ' after UNSTAKE');
}

// Give the venue its cross_chain weights back. Safe to call twice: an UNSTAKE
// for a key with no active stake simply indexes invalid and is logged.
async function unwindRelayStake(ctx, where) {
    if (ctx.relayStakeUnwound || !ctx.relayStakeSource || !ctx.relaySigner) return;
    ctx.relayStakeUnwound = true;
    try {
        await chainRail.withRail(ctx.homeRail, async () => {
            const row = await unstakeKeyFrom(ctx.homeRail, ctx.relayStakeSource, ctx.relaySigner.pubkey, 'cross_chain unstake');
            await confirmUnwound(ctx, row);
        });
        console.log('    [relay-loop] cross_chain stake unwound (' + where + ')');
    } catch (e) {
        console.error('    [relay-loop] WARNING: could not unwind the drill cross_chain stake (' + where +
                      '): ' + e.message + '. UNSTAKE ' + ctx.relaySigner.pubkey + ' from ' +
                      ctx.relayStakeSource.address + ' before leaving the venue to another session.');
    }
}

module.exports = { stakeKeyFrom, unstakeKeyFrom, unwindRelayStake };
