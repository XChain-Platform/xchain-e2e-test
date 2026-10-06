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
 * L2 integration: state checkpoints + ANCHOR archive across a real
 * multi-validator hub federation.
 *
 * Boots N=4 in-process XChainHub validators (MultiValidatorHub, real
 * PeerManager WebSocket P2P) and drives the REAL rounds end to end over
 * live transport:
 *
 *   1. Checkpoint round (StateCheckpointEngine: XCHK_SIGN_REQ → XCHK_SIGN →
 *      XCHK_FINALIZED): the cadence leader proposes a per-chain hash triple,
 *      every follower independently re-fetches the SAME block from its own
 *      (stubbed) indexer and co-signs only on byte-identical state; the
 *      finalized row lands in EVERY hub's state_checkpoints with 2f+1
 *      verifying signatures.
 *   2. A cross-chain DEX match finalizes (the existing PBFT path), giving
 *      the archive something to carry.
 *   3. Anchor flush (StateAnchorPublisher: XANC_SIGN_REQ → XANC_SIGN →
 *      XANC_FINALIZED): the elected publisher proposes the match archive,
 *      followers verify it against their OWN cross_chain_matches before
 *      co-signing, and the leader "publishes" the checkpoint anchor (ANCHOR
 *      v3 post-flag-day, carrying the signed SPV light-client roots; v0 is the
 *      legacy rootless form) + the v1 archive payload via
 *      a captured broadcast hook (no chain in this harness; the on-chain
 *      leg is the regtest e2e's job). Back-fill propagates to every hub.
 *
 * This is the federation counterpart to StateCheckpointEngine.test.js /
 * StateAnchorPublisher.test.js (mock-bus algorithm tests), running the same
 * rounds over real hubs, real P2P, real per-hub MariaDB.
 *
 * Runs on a disposable Docker MariaDB; skips cleanly when neither an
 * env-provisioned DB nor Docker is available.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const zlib   = require('zlib');
const { MultiValidatorHub, ValidatorIdentity } = require('../helpers/multiValidatorHubHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const { seedStakeSnapshot }    = require('../helpers/seededStakeSnapshot');
const { MockCrossChainOfferBook, makeOrder } = require('../helpers/mockCrossChainOfferBook');
const { waitForMesh, waitFor } = require('../helpers/consensusWait');
const eq = require('../../../xchain-hub/src/consensus/equivocation_header.js');
const { foldArchiveCanonical } = require('../../../xchain-hub/src/anchor/publisher/canonical_forms.js');
const { parseAnchorV3 } = require('../helpers/anchor_fold/parse_anchor_v3');

const COUNT        = 4;        // quorum 2f+1 = 3
// Deadlines, not settles: the mesh, the checkpoint rows and the finalized match are
// each observable, so their waits poll and return on the first passing poll.
const PEER_WAIT_MS = 60_000;
const SETTLE_MS    = 60_000;
const BLOCK_INDEX  = 100;      // seeded BTC anchor (election + snapshot block)

// Identical "indexer" state on every hub: the checkpoint engine's stubbed
// getblockhashes view of the BTC chain at height 500, hashes chained upstream.
const TIP = {
    coin: 'BTC', network: 'regtest', block_index: 500, block_time: 1700000000,
    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    // SPV Phase 2 (xchain-hub 08228c8): post-flag-day the checkpoint canonical signs
    // the indexer's light-client roots, and StateCheckpointEngine refuses to finalize
    // a checkpoint whose getblockhashes response lacks them. regtest's commitment
    // flag-day is genesis (block 0), so the stubbed indexer view must carry them.
    state_root: 'd4'.repeat(32), state_root_version: 1,
    block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1
};

// Mirror StateCheckpointEngine.checkpointRootSuffix: the post-flag-day SPV root
// suffix appended to the raw v0 checkpoint canonical BEFORE the EQUIV wrap.
const ROOT_SUFFIX = '|' + [TIP.state_root.toLowerCase(), String(TIP.state_root_version),
                           TIP.block_merkle_root.toLowerCase(), String(TIP.block_merkle_version)].join('|');

function makeSeededOrder(args) {
    return Object.assign(makeOrder(args), { give_decimals: 8 });
}

function crossingPair({ ltcIdx, dogeIdx }){
    return {
        LTC: [ makeSeededOrder({
            action_index: ltcIdx,
            give: { coin: 'LTC',  tick: 'TOKA', amount: '90' },
            get:  { coin: 'DOGE', tick: 'TOKB', amount: '90' },
            get_address: 'addr_ltc_order_' + ltcIdx + '_on_doge',
            block_index: BLOCK_INDEX
        }) ],
        DOGE: [ makeSeededOrder({
            action_index: dogeIdx,
            give: { coin: 'DOGE', tick: 'TOKB', amount: '40' },
            get:  { coin: 'LTC',  tick: 'TOKA', amount: '40' },
            get_address: 'addr_doge_order_' + dogeIdx + '_on_ltc',
            block_index: BLOCK_INDEX
        }) ]
    };
}

// The DOGE indexer's answer for a captured broadcast: the row it would serve once the
// anchor is mined and buried, built from the wire that was broadcast. Anything not
// broadcast here is reported absent, so the verifier still decides every verdict.
function servedAnchorAction(published, coin, method, params) {
    if (coin !== 'DOGE' || method !== 'getanchoraction') return { exists: false };
    const hit = published.find(p => p.txid === params.txid);
    const parsed = hit && parseAnchorV3(hit.payload);
    const section = parsed && parsed.sections.find(x => x.chain === params.chain
        && x.block_index === params.block_index && x.checkpoint_seq === params.checkpoint_seq);
    if (!section || parsed.network !== params.network) return { exists: false };
    return {
        exists: true, status: 'valid', confirmations: 1000, txid: hit.txid, version: 3,
        block_hash: section.block_hash, ledger_hash: section.ledger_hash,
        actions_hash: section.actions_hash, contract_hash: section.contract_hash
    };
}

describe('MultiValidatorHub: state checkpoints + ANCHOR archive (L2)', function () {
    this.timeout(180_000);

    let db, mvh, seed, seedCount, book;
    const published = [];          // [{ hubIndex, payload }] captured "on-chain" anchors

    before(async function () {
        db = await startDisposableHubDb();
        if (!db) {
            console.log('Skipping state-anchor federation L2: no env DB and Docker unavailable');
            this.skip();
        }

        book = new MockCrossChainOfferBook();
        await book.start();
        book.setBook('shared', { network: 'regtest', latestBlockIndex: BLOCK_INDEX,
                                 ordersByCoin: crossingPair({ ltcIdx: 11, dogeIdx: 21 }) });

        mvh = new MultiValidatorHub({
            count:            COUNT,
            basePort:         33000,
            startCrossChain:  true,
            startAttestation: false,
            crossChainIndexerUrls: {
                LTC:  book.urlFor('shared', 'LTC'),
                DOGE: book.urlFor('shared', 'DOGE')
            }
        });
        await mvh.start();
        await waitForMesh(mvh, { timeoutMs: PEER_WAIT_MS });

        // Deterministic oracle_publish/cross_chain sets + BTC anchor block.
        // Weighted (source-keyed) snapshot: regtest activates STAKE_WEIGHTED_QUORUM
        // at genesis, so the count-mode seed leaves each round with a single leader
        // self-sign (1 sig < 2f+1) and nothing finalizes. seedWeightSnapshot stubs
        // the weighted path (getActiveWeightSnapshot/getWeightSnapshot) the engine
        // actually consults; default is one source per booted hub, equal weight.
        seed = seedWeightSnapshot(mvh, { blockIndex: BLOCK_INDEX });
        // The anchor publisher elects its leader from the oracle_publish MEMBER set
        // via capabilitySnapshot.getSnapshot('oracle_publish') (count method, the
        // eligible set for hash-order election), which seedWeightSnapshot does not
        // stub. Without it the election sees an empty set and fails closed (#543b720),
        // so also seed the count snapshot. The two stub disjoint methods.
        seedCount = seedStakeSnapshot(mvh, { blockIndex: BLOCK_INDEX });

        // Per hub: pin the BTC tip (election + snapshot block), stub the
        // checkpoint engine's indexer view to the SHARED state, scope to BTC,
        // and capture every "on-chain" anchor broadcast instead of hitting DOGE.
        mvh.hubs.forEach((hub, i) => {
            hub.resolveBtcLatestBlock = async () => BLOCK_INDEX;
            const cps = hub.stateCheckpoints;
            cps.network = 'regtest';   // engine cached '' at construction (pre-seed)
            cps.chains = ['BTC'];
            cps.confirmations = 0;
            cps.indexers.BTC = { url: 'http://stubbed', key: '' };
            cps.indexerCall = async () => Object.assign({}, TIP);
            const publisher = hub.stateAnchorPublisher;
            publisher.setBroadcastHook(async (payload) => {
                const txid = 'e2e-txid-' + (published.length + 1);
                published.push({ hubIndex: i, payload, txid });
                return { txid };
            });
            hub.capabilityRegistry = Object.assign(hub.capabilityRegistry || {}, {
                getActiveValidators: async () => mvh.identities.map(id => id.pubkeyHex)
            });
            publisher.indexers.DOGE = { url: 'http://stubbed', key: '' };
            publisher.indexerCall = async (coin, method, params) => servedAnchorAction(published, coin, method, params);
        });
    });

    after(async function () {
        if (seed) seed.restore();
        if (seedCount) seedCount.restore();
        if (book) await book.stop();
        if (mvh)  { await mvh.stop(); await mvh.dropDatabases(); }
        if (db)   { await db.stop(); }
    });

    it('checkpoint round: every hub stores the same 2f+1-signed checkpoint', async function () {
        // Drive one cadence tick on every hub. Only the elected leader initiates;
        // followers co-sign over real P2P and adopt the XCHK_FINALIZED row.
        await Promise.all(mvh.hubs.map(h => h.stateCheckpoints.tick()));
        // Each hub's own state_checkpoints row is the post-condition asserted next.
        await waitFor(async () => {
            let held = 0;
            for (const hub of mvh.hubs) {
                try {
                    const r = await hub.db.doQuery(
                        'SELECT checkpoint_seq FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
                        ['BTC', 'regtest', TIP.block_index]);
                    if (r.length >= 1) held++;
                } catch (internal) { /* a hub that cannot be read has not stored it */ }
            }
            return { ok: held === mvh.hubs.length, held: held };
        }, { timeoutMs: SETTLE_MS });

        const rows = [];
        for (const hub of mvh.hubs) {
            const r = await hub.db.doQuery(
                'SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ?',
                ['BTC', 'regtest', TIP.block_index]);
            assert.strictEqual(r.length, 1, 'every hub must hold exactly one checkpoint row');
            rows.push(r[0]);
        }

        // Identical content + quorum signatures that verify over the canonical.
        // At/above the EQUIV flag-day (regtest activates at genesis → always on here)
        // the signed bytes are the v0 raw canonical wrapped in the uniform header
        // (TAG=XCHECKPOINT, v0 round id chain|network|block_index|checkpoint_seq,
        // VIEW=0); below it, the bare raw bytes. Gate keys on the snapshot_block.
        const raw = ['XCHECKPOINT', 'BTC', 'regtest', String(TIP.block_index), TIP.block_hash,
                   TIP.ledger_hash, TIP.actions_hash, TIP.contract_hash,
                   String(rows[0].checkpoint_seq), String(BLOCK_INDEX)].join('|') + ROOT_SUFFIX;
        const canonical = eq.isEquivHeaderActive(BLOCK_INDEX, 'regtest')
            ? eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT,
                'BTC|regtest|' + TIP.block_index + '|' + rows[0].checkpoint_seq, 0, raw)
            : raw;
        for (const row of rows) {
            assert.strictEqual(row.ledger_hash, TIP.ledger_hash);
            const sigs = JSON.parse(row.validator_signatures);
            const verifying = new Set();
            for (const s of sigs)
                if (ValidatorIdentity.verify(canonical, s.sig, s.pubkey)) verifying.add(s.pubkey);
            assert.ok(verifying.size >= 3, 'expected >= 2f+1 = 3 verifying sigs, got ' + verifying.size);
        }
        const distinct = new Set(rows.map(r => r.ledger_hash + '|' + r.checkpoint_seq));
        assert.strictEqual(distinct.size, 1, 'all hubs hold the identical checkpoint');
    });

    it('anchor flush: leader publishes v3 checkpoint anchor + quorum-signed v1 archive; back-fill reaches every hub', async function () {
        // A finalized cross-chain match gives the archive something to carry.
        const dexes = mvh.getCrossChainDexes();
        await Promise.all(dexes.map(d => d.discoverAndMatch().catch(() => {})));
        // The finalized match on every hub is the precondition the loop below
        // asserts, so wait for it rather than for a fixed window.
        await waitFor(async () => {
            let held = 0;
            for (const hub of mvh.hubs) {
                try {
                    const m = await hub.db.doQuery("SELECT match_id FROM cross_chain_matches WHERE status = 'finalized'");
                    if (m.length >= 1) held++;
                } catch (internal) { /* a hub that cannot be read has not stored it */ }
            }
            return { ok: held === mvh.hubs.length, held: held };
        }, { timeoutMs: SETTLE_MS });
        for (const hub of mvh.hubs) {
            const m = await hub.db.doQuery("SELECT * FROM cross_chain_matches WHERE status = 'finalized'");
            assert.ok(m.length >= 1, 'every hub must hold the finalized match before anchoring');
        }

        // Every hub flushes; only the elected publisher proceeds. Followers
        // verify the proposed archive against their own DB and co-sign over P2P.
        // The archive round starts on match finalization, so it can publish before this
        // flush; the capture list is kept whole so that publish still counts.
        await Promise.all(mvh.hubs.map(h => h.stateAnchorPublisher.flush()));
        // The archive round gathers a co-sign quorum over P2P before the bundle publishes,
        // and the XANC_FINALIZED back-fill lands behind it. Both are observable (a captured v3
        // publish; a batch_seq on every hub's match rows) and both are asserted
        // below, so poll for them instead of betting 500ms that the tail of the
        // round finished. Polling also anchors the "exactly one v3" count on the
        // round having completed rather than on a clock reading.
        await waitFor(async () => {
            const bundle = published.find(p => p.payload.split('|')[1] === '3');
            if (!bundle) return { ok: false, stage: 'v3 checkpoint anchor' };
            if (parseAnchorV3(bundle.payload).archiveCount < 1) return { ok: false, stage: 'folded archive in the v3 bundle' };
            for (const hub of mvh.hubs) {
                try {
                    const m = await hub.db.doQuery('SELECT batch_seq FROM cross_chain_matches WHERE batch_seq IS NOT NULL');
                    if (m.length < 1) return { ok: false, stage: 'XANC_FINALIZED back-fill' };
                } catch (internal) { return { ok: false, stage: 'XANC_FINALIZED back-fill (hub read failed)' }; }
            }
            return { ok: true };
        }, { timeoutMs: 30000, intervalMs: 250 });

        // SPV Phase 2 (xchain-hub 08228c8): the checkpoint anchor is published as
        // ANCHOR v3 (not legacy v0) whenever the checkpoint carries the signed
        // light-client roots. TIP seeds those roots and regtest's commitment
        // flag-day is genesis, so every post-flag-day checkpoint here is v3.
        const v3s = published.filter(p => p.payload.split('|')[1] === '3');
        const v1s = published.filter(p => p.payload.split('|')[1] === '1');
        // The safety invariant is PER-ARTIFACT, not "one hub does everything": the
        // checkpoint anchor (v3, elected per checkpoint row via _v0ElectionKey) and
        // the archive (v1, elected per election block via archiveElectionKey) run
        // INDEPENDENT hash-order elections, so they are routinely paid by two
        // DIFFERENT hubs (distributed DOGE cost, not a double-anchor). What must
        // hold is that each artifact publishes exactly once. (A prior
        // `publishers.size === 1` assumed a single publisher for both and flaked
        // ~half the time, whenever the two elections landed on different hubs.)
        assert.strictEqual(v3s.length, 1, 'exactly one v3 checkpoint anchor publishes (SPV roots present, no double-anchor)');
        // Anchor fold is active on regtest from genesis: the archive rides inside the one
        // v3 bundle instead of a separate v1 head, so no legacy v1 publishes.
        assert.strictEqual(v1s.length, 0, 'no separate v1 archive publishes once the archive is folded into the v3 bundle');

        // Folded archive: the wrapper section's quorum sigs cover the extended canonical
        // that binds the batch seq, count, crc and chunk total; the archive decompresses
        // to the match.
        const parsed = parseAnchorV3(v3s[0].payload);
        assert.strictEqual(parsed.archiveCount, 1, 'the v3 bundle carries the folded archive');
        const wrapper = parsed.sections[parsed.archive.wrapperSectionIndex];
        const canonical = foldArchiveCanonical({
            chain: wrapper.chain, network: parsed.network, block_index: wrapper.block_index,
            block_hash: wrapper.block_hash, ledger_hash: wrapper.ledger_hash,
            actions_hash: wrapper.actions_hash, contract_hash: wrapper.contract_hash,
            checkpoint_seq: wrapper.checkpoint_seq, snapshot_block: wrapper.section_snapshot_block,
            state_root: wrapper.state_root, state_root_version: wrapper.state_root_version,
            block_merkle_root: wrapper.block_merkle_root, block_merkle_version: wrapper.block_merkle_version
        }, parsed.archive.matchBatchSeq, parsed.archive.matchCount, parsed.archive.batchCrc32, parsed.archive.totalChunks);
        assert.ok(wrapper.sigs.length >= 3, 'the wrapper section carries >= 2f+1 = 3 sigs, got ' + wrapper.sigs.length);
        const verifying = new Set();
        for (const s of wrapper.sigs)
            if (ValidatorIdentity.verify(canonical, s.sig, s.pubkey)) verifying.add(s.pubkey);
        assert.ok(verifying.size >= 3, 'wrapper sigs must verify over the folded archive canonical');

        const archive = JSON.parse(zlib.gunzipSync(Buffer.from(parsed.archive.archiveB64, 'base64')).toString('utf8'));
        assert.ok(archive.matches.length >= 1);
        assert.ok(archive.capability_snapshots.some(s => s.capability === 'cross_chain'));
        assert.ok(archive.capability_snapshots.some(s => s.capability === 'oracle_publish'));

        // XANC_FINALIZED back-fill: every hub's match rows carry the batch metadata.
        for (const hub of mvh.hubs) {
            const m = await hub.db.doQuery('SELECT batch_seq, archived_status FROM cross_chain_matches WHERE batch_seq IS NOT NULL');
            assert.ok(m.length >= 1, 'back-fill must reach every hub');
            assert.strictEqual(String(m[0].archived_status), 'finalized');
        }
    });
});
