/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const anchorVersions = require('../../helpers/anchorVersionHelper');
const { ValidatorIdentity } = require('../../helpers/multiValidatorHubHelper');
const { N, S, allHubs } = require('./support/state');
const { waitForArchiveFinalized, waitForTip } = require('./support/waits');

// Identical finalized match on every hub, signed by 3/4 validators
// (the followers' cryptographic check needs 2f+1 over XMATCH).
async function insertMatchEverywhere(block){
    const identities = S.mvh.identities.map(id => new ValidatorIdentity(id.privkeyHex));
    const m = {
        match_id: crypto.createHash('sha256').update('anchor-election-' + Date.now()).digest('hex'),
        snapshot_block: block, network: 'regtest',
        a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'election_payout_a',
        b_chain: 'LTC', b_action_index: 22, b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'election_payout_b',
        effective_time: Math.floor(Date.now() / 1000)
    };
    const canonical = S.mvh.hubs[0].getCrossChainDex().canonicalMatch(m);
    const sigs = JSON.stringify(identities.slice(0, 3).map(id =>
        ({ pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canonical) })));
    await allHubs(
        `INSERT INTO cross_chain_matches
            (match_id, snapshot_block, network, a_chain, a_action_index, a_kind, a_tick, a_amount,
             a_filled_before, a_ownership, a_payout_addr, b_chain, b_action_index, b_kind, b_tick,
             b_amount, b_filled_before, b_ownership, b_payout_addr, effective_time,
             validator_signatures, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'finalized')`,
        [m.match_id, m.snapshot_block, m.network, m.a_chain, m.a_action_index, m.a_kind, m.a_tick,
         m.a_amount, m.a_filled_before, m.a_ownership, m.a_payout_addr, m.b_chain, m.b_action_index,
         m.b_kind, m.b_tick, m.b_amount, m.b_filled_before, m.b_ownership, m.b_payout_addr,
         m.effective_time, sigs]);
    return m;
}

// Elect the leader EXACTLY as startArchiveRound does: hash-order over the
// oracle_publish set keyed on archiveElectionKey(wrapperCp, nextBatchSeq).
// The wrapper is the BTC-preferred latest checkpoint; batchSeq is a
// non-consuming MAX+1 read, identical on every hub. The archive leg is
// one head per network per cycle, untouched by the bundle.
async function electArchiveLeader(){
    const sap0 = S.mvh.hubs[0].stateAnchorPublisher;
    const cpRow = (await S.mvh.hubs[0].db.doQuery(
        "SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC, id DESC LIMIT 1"))[0];
    const batchSeq = await sap0.getNextBatchSeq();
    const archiveKey = sap0.archiveElectionKey(
        { chain: cpRow.chain, network: cpRow.network, checkpoint_seq: cpRow.checkpoint_seq }, batchSeq);
    const archiveOrder = S.SAP.hashOrder(archiveKey, S.pubkeys);
    return {
        cpRow,
        leader:    S.pubkeys.indexOf(archiveOrder[0]),
        nonLeader: S.pubkeys.indexOf(archiveOrder[archiveOrder.length - 1])
    };
}

async function flushLeaderAndNonLeader({ leader, nonLeader }){
    const sNon = await S.mvh.hubs[nonLeader].stateAnchorPublisher.flush();
    assert.strictEqual(sNon.archive, 'none', 'a non-leader refuses to start the archive round');

    const sLead = await S.mvh.hubs[leader].stateAnchorPublisher.flush();
    assert.ok(sLead.archive === 'round_started' || sLead.archive === 'published',
        'leader started the round (got ' + sLead.archive + ')');
}

// The archive leg has exactly one accepted version: v1, with the publisher tail
// ALWAYS appended, whether or not archive-reward derivation is armed at the
// checkpoint's snapshot_block. There is no tail-less wire to fall back to.
function assertArchivePublished({ cpRow, leader }){
    const arcVersions = anchorVersions.expectedArchiveAnchor(cpRow).accepted;
    const v1s = S.published.filter(p => arcVersions.includes(anchorVersions.anchorPayloadVersion(p.payload)));
    assert.strictEqual(v1s.length, 1, 'exactly one archive anchor published');
    assert.strictEqual(v1s[0].hub, leader, 'published by the elected archive leader');
    assert.strictEqual(v1s[0].from, S.wallets[leader].address, 'paid from the leader\'s wallet');

    const sigCount = Number(v1s[0].payload.split('|')[16]);
    assert.ok(sigCount >= 3, 'the archive anchor carries 2f+1 live co-signatures (got ' + sigCount + ')');
    assert.ok(S.rewards.some(r => r.hub === leader && r.type === 'anchor_archive'),
        'archive reward credited to the leader');
    return { sigCount, txid: v1s[0].txid };
}

async function assertEveryHubFinalized(matchId){
    for (let i = 0; i < N; i++) {
        const r = await S.mvh.hubs[i].db.doQuery(
            'SELECT batch_seq, archived_status FROM cross_chain_matches WHERE match_id = ?', [matchId]);
        assert.ok(r.length === 1 && r[0].batch_seq != null && String(r[0].archived_status) === 'finalized',
            'hub ' + i + ' back-filled batch metadata via XANC_FINALIZED');
    }
}

async function runArchiveRound(){
    const m = await insertMatchEverywhere(await waitForTip(0));
    await waitForTip(0);
    // The failover test mutated electionToleranceBlocks to 2; reset to a wide
    // window so only rank 0 (the leader) is unlocked and every other hub
    // refuses (deterministic single-leader election).
    for (const hub of S.mvh.hubs) hub.stateAnchorPublisher.electionToleranceBlocks = 100000;

    const election = await electArchiveLeader();
    await flushLeaderAndNonLeader(election);
    // SIGN round + publish + FINALIZED: wait for the finalized back-fill to
    // reach every hub rather than a fixed window.
    await waitForArchiveFinalized(m.match_id, S.mvh.hubs, 60000);

    const { sigCount, txid } = assertArchivePublished(election);
    await assertEveryHubFinalized(m.match_id);
    console.log('    archive: leader hub' + election.leader + ', ' + sigCount + ' sigs, txid ' + txid);
}

function register(){
    it('archive: the per-block leader collects 2f+1 live co-signatures and XANC_FINALIZED back-fills every hub', async function () {
        await runArchiveRound();
    });
}

module.exports = { register };
