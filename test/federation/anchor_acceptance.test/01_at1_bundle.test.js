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
const zlib   = require('zlib');

const anchorVersions = require('../../helpers/anchorVersionHelper');
const { S, sleep, indexerQuery, archiveWrapperLedgerHash } = require('./support/state');
const {
    mirrorIndexerCapabilities, seedSyntheticCheckpoints, insertSyntheticMatch, mirrorHubCapabilities
} = require('./support/seed');

// The engine-cut DOGE checkpoint the tick produced, with its SPV roots.
async function tickDogeCheckpoint(){
    await S.hub.stateCheckpoints.tick();
    const cps = await S.hub.db.doQuery(
        "SELECT * FROM state_checkpoints WHERE chain = 'DOGE' AND network = 'regtest' ORDER BY checkpoint_seq DESC LIMIT 1");
    assert.strictEqual(cps.length, 1, 'hub holds a DOGE checkpoint after the tick');
    const cp = cps[0];
    assert.match(String(cp.ledger_hash), /^[0-9a-f]{64}$/);
    // A v0 section is root-bearing by construction. Regtest arms
    // CHECKPOINT_COMMITMENT at genesis, so a real engine-cut row without roots
    // means the SPV leg is broken, not that the anchor should fall back.
    assert.ok(anchorVersions.checkpointCarriesRoots(cp),
        'the engine-cut DOGE checkpoint carries its SPV roots; a rootless row is SKIPPED, never anchored rootless');
    console.log('    checkpoint: DOGE@' + cp.block_index + ' ledger ' + String(cp.ledger_hash).slice(0, 16) + '... snapshot_block ' + cp.snapshot_block);
    return cp;
}

// Neither leg has a version to derive: the checkpoint leg is v0 and nothing
// else, the archive leg v1 and nothing else. Both helpers still report
// `rewardActive`/`rootBearing` off the flag-days at the resolved
// snapshot_block, which is what `describe` below is showing.
function expectedAnchors(cp){
    const cpExpect  = anchorVersions.expectedCheckpointAnchor(cp);
    const arcExpect = anchorVersions.expectedArchiveAnchor(cp);
    console.log('    expecting ' + cpExpect.describe + ' + ' + arcExpect.describe);
    return arcExpect;
}

function wireVersions(){
    return JSON.stringify(S.broadcasts.map(b => anchorVersions.anchorPayloadVersion(b.payload)));
}

// ONE v0 for the network, carrying all three chains. Three separate
// checkpoint transactions is exactly the shape the bundle replaced.
function assertBundleShape(v0, snapBlock){
    assert.strictEqual(v0.bundle.section_count, 3, 'three sections: BTC, DOGE, LTC');
    assert.deepStrictEqual(v0.bundle.chains, ['BTC', 'DOGE', 'LTC'], 'sections ride CHAIN ascending');
    assert.strictEqual(v0.bundle.network, 'regtest', 'the wire NETWORK on regtest is the literal "regtest"');
    assert.strictEqual(v0.bundle.snapshot_block, snapBlock, 'header SNAPSHOT_BLOCK is the MAX over sections');
    for (const s of v0.bundle.sections)
        assert.ok(s.state_root && s.block_merkle_root, s.chain + ': the section carries its roots');
}

// Pick the one bundle and the archive off the broadcasts a flush produced.
function pickWires(arcExpect){
    assert.ok(S.broadcasts.length >= 2,
        'expected a bundle + archive broadcast, got ' + S.broadcasts.length);
    const bundleWires = anchorVersions.bundleBroadcasts(S.broadcasts);
    assert.strictEqual(bundleWires.length, 1,
        'exactly one ANCHOR v0 bundle, got ' + bundleWires.length + '; saw versions ' + wireVersions());
    const v0 = bundleWires[0];
    const v1 = anchorVersions.findAnchorBroadcast(S.broadcasts, arcExpect.accepted);
    assert.ok(v0.txid, 'the bundle published with a real txid');
    assert.ok(v1 && v1.txid, arcExpect.describe + ' published with a real txid; saw versions ' + wireVersions());
    return { v0, v1 };
}

// The two-phase property a walletSign-only hook would hide: each
// publish must produce a DISTINCT phase-1 funding tx and phase-2
// reveal tx (the decodable one). A single-tx publish here means the
// reveal leg silently vanished, which is exactly the production bug class.
function assertTwoPhase(wires){
    for (const b of wires) {
        assert.ok(b.phase1_txid, 'publish went two-phase (phase-1 txid present)');
        assert.notStrictEqual(b.phase1_txid, b.txid, 'phase-2 reveal txid differs from phase-1');
    }
}

// The flush summary (the anchorflush RPC surface) reports ONE entry per
// SECTION, all naming the one bundle transaction.
function assertFlushSummary(summary, v0){
    assert.strictEqual(summary.anchored.length, 3, 'flush summary names all three anchored sections');
    for (const a of summary.anchored)
        assert.strictEqual(a.txid, v0.txid, a.chain + ': every section names the one bundle txid');
    assert.strictEqual(summary.archive, 'published');
}

// Flush once and check everything the publisher side can show. Returns the wires
// and the archive's own wrapper identity.
async function flushAndCheckPublisher(cp, snapBlock){
    const arcExpect = expectedAnchors(cp);
    const summary = await S.hub.stateAnchorPublisher.flush();
    const { v0, v1 } = pickWires(arcExpect);
    assertBundleShape(v0, snapBlock);
    assertTwoPhase([v0, v1]);
    assertFlushSummary(summary, v0);
    const arcVersion = anchorVersions.anchorPayloadVersion(v1.payload);
    // The archive's own wrapper identity, off the wire it actually published (see
    // archiveWrapperLedgerHash): the wrapper checkpoint the archive rides is
    // elected over every chain's state_checkpoints row for this network and can
    // land on BTC or LTC rather than the DOGE row `cp` names, so `cp.ledger_hash`
    // is the wrong key to read this row back by.
    const arcLedgerHash = archiveWrapperLedgerHash(v1.payload);
    S.bundleTxid = v0.txid;
    console.log('    on-chain: bundle v0 [' + v0.bundle.chains.join(',') + '] ' + v0.txid +
                ' (' + v0.bundle.attest_sig_count + ' attesting sig(s)) / archive v' + arcVersion +
                ' ' + v1.txid + ' (phase-1: ' + v0.phase1_txid + ' / ' + v1.phase1_txid + ')');
    return { v0, arcVersion, arcLedgerHash };
}

// Confirm + let decoder/indexer catch up. A dirty chain may carry anchors
// from prior runs, so match on content rather than position.
async function waitForIndexedAnchors(cp, arcVersion, arcLedgerHash){
    await regtestMinerConnector.generateBlocks(3);
    let sections = [], r1 = null;
    for (let i = 0; i < 60 && (sections.length !== 3 || !r1); i++) {
        const rows = await indexerQuery(
            `SELECT a.*, s.status FROM anchor_actions a
             LEFT JOIN index_statuses s ON s.id = a.status_id
             ORDER BY a.action_index ASC, a.section_index ASC`);
        // Seeded off OUR DOGE section's ledger_hash, so a prior run's bundle on
        // this dirty chain cannot satisfy the assert.
        sections = anchorVersions.findBundleSectionRows(rows, cp.ledger_hash);
        // Seeded off the archive's OWN wrapper ledger_hash (arcLedgerHash), never
        // off `cp.ledger_hash`: the wrapper checkpoint the archive names is elected
        // over every chain in play, not pinned to the chain the test happens to tick.
        r1 = anchorVersions.findAnchorRow(rows, [arcVersion], arcLedgerHash);
        if (sections.length !== 3 || !r1) await sleep(2000);
    }
    assert.strictEqual(sections.length, 3, 'the indexer stored three section rows for our bundle');
    assert.ok(r1, 'archive v' + arcVersion + ' row for our archive present');
    return { sections, r1 };
}

// The core evidence: ONE action_index, section_index 0..2, all valid.
function assertSectionRows(sections){
    const actionIndex = String(sections[0].action_index);
    for (const s of sections)
        assert.strictEqual(String(s.action_index), actionIndex, 'all three sections share one action_index');
    assert.deepStrictEqual(sections.map(s => Number(s.section_index)), [0, 1, 2],
        'section_index runs 0..2 in wire order');
    for (const s of sections)
        assert.strictEqual(String(s.status), 'valid',
            s.chain + ' section verified against the mirrored oracle_publish set (got ' + s.status + ')');
    assert.deepStrictEqual(sections.map(s => String(s.chain)), ['BTC', 'DOGE', 'LTC']);
    // Every section row carries its OWN per-chain identity and the BUNDLE's
    // network (rebuilt from the header), which is what keeps
    // idx_anchor_checkpoint and every per-chain reader working unchanged.
    for (const s of sections) {
        assert.strictEqual(String(s.network), 'regtest', s.chain + ': header NETWORK written onto the section row');
        assert.ok(s.state_root && s.block_merkle_root, s.chain + ': section row carries its roots');
        assert.ok(String(s.validator_signatures || '').length > 2, s.chain + ': section row carries its signatures');
    }
    return actionIndex;
}

// Checkpoint leg: the on-chain DOGE section equals what the hub signed over
// the REAL indexer hashes (the full circle: indexer -> hub -> chain -> indexer).
function assertDogeSection(sections, cp){
    const doge = sections.find(s => String(s.chain) === 'DOGE');
    assert.strictEqual(Number(doge.block_index), Number(cp.block_index));
    assert.strictEqual(String(doge.ledger_hash), String(cp.ledger_hash));
    assert.strictEqual(String(doge.actions_hash), String(cp.actions_hash));
    assert.strictEqual(String(doge.contract_hash), String(cp.contract_hash));
}

// Archive leg: decompresses to the synthetic match + both capability sets.
function assertArchiveRow(r1, arcVersion){
    assert.strictEqual(String(r1.status), 'valid',
        'archive v' + arcVersion + ' verified against the mirrored oracle_publish set');
    const archive = JSON.parse(zlib.gunzipSync(Buffer.from(String(r1.archive_b64), 'base64url')).toString('utf8'));
    assert.strictEqual(archive.matches.length, 1);
    assert.strictEqual(archive.matches[0].match_id, S.matchId);
    assert.ok(archive.capability_snapshots.some(s => s.capability === 'cross_chain'));
    assert.ok(archive.capability_snapshots.some(s => s.capability === 'oracle_publish'));
}

async function runAt1(){
    const cp = await tickDogeCheckpoint();
    // The REAL snapshot block resolved by the hub at tick time; everything
    // downstream (capability mirror rows, the synthetic match) keys on it.
    const snapBlock = Number(cp.snapshot_block);
    await mirrorIndexerCapabilities(snapBlock);
    await seedSyntheticCheckpoints(snapBlock);
    await insertSyntheticMatch(snapBlock);
    await mirrorHubCapabilities(snapBlock);

    const { v0, arcVersion, arcLedgerHash } = await flushAndCheckPublisher(cp, snapBlock);

    // The three checkpoint rows the bundle carried, for the AT4 read-back.
    S.bundleSections = await S.hub.db.doQuery(
        'SELECT * FROM state_checkpoints WHERE network = ? AND snapshot_block = ? AND anchor_txid = ? ORDER BY chain ASC',
        ['regtest', snapBlock, v0.txid]);
    assert.strictEqual(S.bundleSections.length, 3,
        'every section row is stamped with the bundle txid on the publisher');

    const { sections, r1 } = await waitForIndexedAnchors(cp, arcVersion, arcLedgerHash);
    const actionIndex = assertSectionRows(sections);
    assertDogeSection(sections, cp);
    console.log('    indexed: action_index ' + actionIndex + ', sections ' +
                sections.map(s => s.section_index + ':' + s.chain + '=' + s.status).join(' '));
    assertArchiveRow(r1, arcVersion);
    console.log('    parsed: bundle v0 + archive v' + arcVersion +
                ' valid, archive carries match ' + S.matchId.slice(0, 16) + '...');
}

function register(){
    it('AT1: checkpoints REAL indexer state and lands ONE quorum-signed v0 bundle with three sections on the DOGE chain', async function () {
        await runAt1();
    });
}

module.exports = { register };
