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
 * E2E acceptance: the DEGRADED ARCHIVE ATTESTATION round on a LIVE DOGE
 * regtest chain, driven across TWO federated hubs.
 *
 * The sibling of anchorAcceptance.test.js: same venue, same env contract, same
 * production signer path, one validator more. What the single-hub suite cannot
 * reach is the branch that only exists when the archive publisher NEEDS a peer:
 * _runArchiveAttestationRound short-circuits `met: true` at snapCount <= 1
 * (StateAnchorPublisher.js), so a one-hub venue proves the ATTESTED path and
 * nothing about what happens when the co-signer goes quiet.
 *
 *   AT-F1 (attested baseline): one flush lands ONE ANCHOR v0 bundle (indexed
 *         `valid`) and ONE v1 archive head with ATTEST_SIG_COUNT >= 1 (indexed
 *         `valid`), and the anchor_archive reward record derives for that batch.
 *   AT-F2 (the round is REAL): the oracle_publish set resolved at the wrapper
 *         checkpoint's snapshot_block holds >= 2 DISTINCT SOURCES and contains
 *         the publisher, so the round cannot self-satisfy - and, positively, the
 *         co-signer OBSERVES an XANCARCHPUB_SIGN_REQ on the wire. Reading
 *         snapCount alone would not say which branch ran.
 *   AT-F3 (degraded): with the co-signer silenced ON THE ARCHIVE ATTESTATION
 *         ONLY, the publisher still lands a v1 with ATTEST_SIG_COUNT 0, indexed
 *         `valid`, deriving NO anchor_archive reward - while the SAME cycle's v0
 *         bundle is still `valid` with ATTEST_SIG_COUNT >= 1.
 *   AT-F4 (recovery): the co-signer returns and the NEXT archive batch carries a
 *         tail again and derives its reward.
 *
 * ONE FEDERATION PER TEST, AND WHY.
 *
 * The archive election key is _archiveElectionKey(wrapperCp, batchSeq), and
 * batchSeq is _getNextBatchSeq(): MAX+1 over that hub's OWN cross_chain_matches
 * / cross_chain_calls / validator_rewards. It is HUB-LOCAL. Two hubs agree on it
 * only while their tables are equal, which the XANC_FINALIZED back-fill of
 * batch_seq is what maintains. Once they are unequal the hubs compute DIFFERENT
 * keys, EACH can be rank 0 for its own key, and there is nothing to converge to:
 * the second live drive of this suite ended with hub0 at batch 27 and hub1 at
 * batch 28, each electing a different leader, after BOTH hubs had published an
 * archive (batch 26 with 2 matches, batch 27 with 1). Waiting longer does not
 * help, because the views are diverging rather than lagging.
 *
 * Tables are guaranteed equal at exactly one moment: BOOT, before anything has
 * published. So every test here gets its OWN two-hub federation, and the cycle
 * whose properties it asserts is that federation's FIRST. AT-F3 is silenced from
 * boot, so its first archive round IS the degraded one; no cross-cycle
 * dependency, no inherited divergence. AT-F4 is the only test that genuinely
 * needs two cycles in one federation (recovery is its whole point), so it gets a
 * federation of its own and drives its two cycles ARCHIVE-ONLY, flushing just the
 * elected leader, which keeps a single publisher and gives the back-fill the
 * cleanest run it can have. If AT-F4's second cycle still diverges, the barrier
 * below fails naming both hubs' views, and that is the honest result: a red AT-F4
 * carrying the evidence beats a green one measuring something easier.
 *
 * The election is therefore still resolved on EVERY hub through that hub's own
 * reads (archiveElectionView), and runCycle asserts the leader, the batch seq and
 * the leader's own _isRankZero BEFORE any flush, then asserts that leader's flush
 * actually returned round_started/published. A mis-election fails as "the elected
 * hubN started its archive round ... flush said archive=none" with every view
 * printed, never as a missing archive head minutes later.
 *
 * WHY NOT ANCHOR_ROUND_TIMEOUT_MS. It is the SHARED round timer: the v0 bundle
 * attestation round, the archive wrapper co-sign round and the archive
 * attestation round all read StateAnchorPublisher.roundTimeoutMs. The v0 bundle
 * tail REQUIRES ATTEST_SIG_COUNT >= 1 (xchain-indexer anchor.js throws on 0,
 * where the v1 archive tail accepts it), so a cycle degraded by the clock lands
 * `invalid: ATTEST_SIG_COUNT` on the bundle and proves the opposite of AT-F3's
 * last clause. The fault is therefore the narrow one -
 * byzantineFaults.silenceArchiveAttestor, which replaces only the co-signer's
 * _handleArchiveAttestSignReq - and roundTimeoutMs is lowered purely so the
 * degraded round SETTLES inside a test run. Lowering it degrades nothing: every
 * honest in-process round here answers over loopback gossip in milliseconds.
 *
 * VENUE CONTRACT, identical to anchorAcceptance.test.js (read its header for the
 * reasoning behind each): a disposable Docker MariaDB per run via
 * disposableHubDb forceDocker (the platform DB user cannot CREATE DATABASE);
 * seedWeightSnapshot for the oracle_publish/cross_chain resolution a DOGE-only
 * venue cannot answer live; XCHAIN_CONFIRMATIONS_DOGE set BEFORE hub
 * construction; the staged production HUB_SIGNER_MODULE signer driving the sdk
 * two-phase P2SH pipeline; a per-run snapshot block so a re-run cannot poison its
 * own stake tally through the persistent indexer DB. One MariaDB container serves
 * all three federations (each makes its own databases); the funded wallet and the
 * staged signer are also shared, since publishes are serialized throughout.
 *
 * Two deliberate departures from that suite, both for the two-hub shape:
 *
 *   - CHECKPOINTS ARE SYNTHETIC, as in anchorElection.test.js. Both hubs must
 *     hold byte-identical rows (a follower rebuilds the archive from its own copy
 *     and byte-compares, and re-SELECTs the wrapper before co-signing an
 *     attestation). Each row is signed by BOTH validators over the hub's OWN
 *     canonical (StateCheckpointEngine.canonicalCheckpoint), which is what makes
 *     'valid' a real verdict: the indexer's tally is stake-weighted at genesis on
 *     regtest and a single signature over a two-source set fails it closed. What
 *     this suite is about lives in the attestation round, not in the checkpoint
 *     cut - the real indexer-state cut is anchorAcceptance's AT1.
 *   - ONE funded publisher wallet, shared by both hubs. Publishes are serialized
 *     by the flush order below, and "paid from the winner's own wallet" is
 *     anchorElection's property, not one of AT-F1..F4.
 *
 * Pre-requisites (driven by the operator/runner, NOT this file): the same
 * dogecoin-regtest stack and env as anchorAcceptance.test.js.
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');

const fs = require('fs');
const { encode: wifEncode } = require('wif');

const cryptoHelper      = require('../cryptoHelper');
const CryptoNetworks    = require('../../src/CryptoNetworks');
const { MultiValidatorHub, ValidatorIdentity, loadHubModule, resolveHubFile } = require('../helpers/multiValidatorHubHelper');
const anchorVersions    = require('../helpers/anchorVersionHelper');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const { silenceArchiveAttestor } = require('../helpers/byzantineFaults');

const N = 2;                                       // publisher + the one co-signer AT-F3 silences

// Disposable Docker MariaDB, port/name derived from the pid so a concurrent
// session's own container cannot collide (see anchorAcceptance gap (a)).
const HUB_DB_PORT = 13700 + (process.pid % 300);
const HUB_DB_NAME = 'xchain-degraded-archive-hubdb-' + process.pid;

// Per-run base for the snapshot block. The INDEXER db is persistent across runs,
// so a second run's fresh validator pubkeys landing at the same snapshot_block
// would leave this run's signers a stake minority and every anchor would verify
// closed. Each federation then takes its own block off this base, so one
// federation's capability rows can never be tallied against another's keys.
const SNAPSHOT_BLOCK_BASE = Number(process.env.ANCHOR_DEGRADED_SNAPSHOT_BLOCK) || (900000 + (Date.now() % 600000));

// Bound for a round that will NOT be answered. Not the fault: it is what stops
// the degraded round holding the suite for the 120s production default. Honest
// rounds here settle over loopback in milliseconds.
const ROUND_TIMEOUT_MS = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('ANCHOR live acceptance: degraded ARCHIVE attestation across two validators (DOGE regtest)', function () {
    this.timeout(30 * 60 * 1000);

    // Venue-wide, booted once.
    let hubDb = null, SAP = null, SCE = null;
    let publisherAddr = null, signerDir = null, signerHooks = null;

    // Per-federation, rebuilt by bootFederation() and torn down by afterEach.
    let mvh = null, weightSeed = null, fault = null;
    let identities = [], pubkeys = [];
    let broadcasts = [];               // { hub, payload, txid, phase1_txid }
    // XANCARCHPUB_SIGN_REQ envelopes each hub saw on the wire, by hub index. Counted
    // ABOVE the injected handler (on _handleMessage), so a degraded cycle still
    // observes the request arriving even though the response is silenced - which is
    // what tells a degraded ROUND apart from a round that never ran.
    let archiveSignReqSeen = [];
    let snapshotBlock = 0;
    let federationCount = 0;

    async function indexerQuery(sql, params){
        let conn = await indexerDatabase.getConnection();
        try { return await conn.query(sql, params); }
        finally { await conn.release(); }
    }

    async function allHubs(sql, params){
        for (const hub of mvh.hubs) await hub.db.doQuery(sql, params);
    }

    // The staged production signer, exactly as anchorAcceptance stages it: the
    // module an operator installs in ~/hub-signer, loaded through the hub's REAL
    // signer-loader, driving the sdk two-phase P2SH pipeline. A walletSign-only
    // hook would skip the phase-2 reveal leg, which is where the 2026-06-11
    // mainnet shakedown bug hid. Staged once and reused by every federation.
    function stageProductionSigner(addressInfo){
        const examplePath = resolveHubFile('examples/doge-signer.example.js');
        // os.tmpdir(), never __dirname: the e2e tree may sit on a Parallels share
        // where symlink creation is unreliable.
        signerDir = path.join(require('os').tmpdir(), 'xchain-degraded-archive-signer-' + process.pid);
        fs.rmSync(signerDir, { recursive: true, force: true });
        fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true });
        fs.copyFileSync(examplePath, path.join(signerDir, 'signer.js'));
        for (const dep of ['xchain-sdk', 'dotenv']) {
            let target;
            try { target = path.dirname(require.resolve(dep + '/package.json')); }
            catch (e) {
                target = path.resolve(__dirname, '../../../', dep);            // monorepo sibling checkout
                if (!fs.existsSync(target)) throw new Error('cannot resolve ' + dep + ' for the staged signer');
            }
            fs.symlinkSync(target, path.join(signerDir, 'node_modules', dep), 'dir');
        }

        // The signer's .env contract via process env (dotenv never overrides an
        // existing var, no .env file is written, the WIF stays in memory).
        const network = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK);
        process.env.DOGE_NETWORK     = COIN + '-' + NETWORK;
        process.env.DOGE_ADDRESS     = addressInfo.address;
        process.env.DOGE_WIF         = wifEncode(network.wif, Buffer.from(addressInfo.privateKey), true);
        process.env.DOGE_ENCODER_URL = 'http://' + (process.env.ENCODER_URL || 'localhost') + ':' +
                                       (process.env.ENCODER_API_PORT || '3023');
        process.env.HUB_SIGNER_MODULE = path.join(signerDir, 'signer.js');

        const { loadSignerHooks } = loadHubModule('src/lib/signer-loader.js');
        const hooks = loadSignerHooks(process.env);
        assert.ok(hooks && hooks.broadcastFn, 'signer-loader wired the example signer\'s broadcast hook');
        return hooks;
    }

    // Peers a hub could actually DELIVER a broadcast to, counted with the SAME gate
    // PeerManager.broadcast applies (`peer.ws && readyState === OPEN`). Peer presence
    // in the map is not enough: an entry sitting in 'connecting' receives nothing, and
    // every round this suite drives is broadcast-then-wait.
    function deliverablePeers(hub){
        let n = 0;
        for (const [, peer] of (hub.peerManager && hub.peerManager.peers) || [])
            if (peer.ws && peer.ws.readyState === 1) n++;      // 1 = WebSocket.OPEN
        return n;
    }

    // Hubs holding an archive round that has not settled: one still collecting
    // signatures (_archiveRound) or one whose publish is still in flight
    // (_archivePublishing). Both are the guards _startArchiveRound reads on its very
    // first line, `if(this._archiveRound || this._archivePublishing) return
    // 'round_pending'`, so either one makes the next flush decline before it elects
    // anything at all.
    function busyArchiveRounds(){
        return mvh.hubs
            .map((h, i) => ({
                i,
                collecting: !!h.stateAnchorPublisher._archiveRound,
                publishing: !!h.stateAnchorPublisher._archivePublishing
            }))
            .filter(s => s.collecting || s.publishing);
    }

    // Wait for the whole federation to be free of an in-flight archive round.
    //
    // The two-hub round is ASYNCHRONOUS in both halves: the flush returns
    // 'round_started' and the v1 publishes later when the co-signature lands, and
    // even waitForArchiveHead returns while _publishArchive is still running (the
    // wire is recorded from inside the broadcast hook, ahead of the batch back-fill,
    // the intent settle and the reward defer). So a SECOND cycle in one federation
    // that flushes immediately gets 'round_pending' and measures nothing. The right
    // fix is to wait for the previous round rather than to accept its verdict: a
    // cycle-2 assertion satisfied by cycle 1's round is exactly the kind of green
    // that measures something easier than it claims. Polled on the publisher's own
    // two guards, never slept on. Returns whatever is still busy so the caller can
    // name it.
    async function waitForArchiveQuiescent(timeMax){
        const deadline = Date.now() + timeMax;
        let busy = busyArchiveRounds();
        while (Date.now() < deadline) {
            busy = busyArchiveRounds();
            if (busy.length === 0) return busy;
            await sleep(500);
        }
        return busy;
    }

    function describeBusy(busy){
        return (busy || []).map(s =>
            'hub' + s.i + (s.collecting ? ' collecting signatures' : '') + (s.publishing ? ' publishing' : '')
        ).join(', ');
    }

    // P2P dial-up is asynchronous after startP2P, so poll rather than sample once.
    // Returns the per-hub counts either way, so the caller's assertion can name them.
    async function waitForPeering(timeMax){
        const deadline = Date.now() + timeMax;
        let counts = mvh.hubs.map(deliverablePeers);
        while (Date.now() < deadline) {
            counts = mvh.hubs.map(deliverablePeers);
            if (counts.every(c => c >= N - 1)) return counts;
            await sleep(500);
        }
        return counts;
    }

    // A FRESH two-hub federation with EMPTY tables. Equal tables are what makes
    // _getNextBatchSeq agree across hubs, so this is the only moment at which the
    // archive election is guaranteed well-defined; every test starts from one.
    async function bootFederation(label){
        federationCount++;
        // Its own snapshot block, so this federation's indexer capability rows are
        // never tallied against another federation's validator keys.
        snapshotBlock = SNAPSHOT_BLOCK_BASE + (federationCount * 1009);
        broadcasts = [];
        archiveSignReqSeen = [];
        // Read at engine construction, so it must be set before the hubs start.
        process.env.XDEX_SNAPSHOT_BLOCK = String(snapshotBlock);

        mvh = new MultiValidatorHub({
            count: N, basePort: 34500 + (federationCount * 20),
            startCrossChain: true, startAttestation: false,
            dbNamePrefix: 'XChain_DOGE_Regtest_DEGARC_' + process.pid + '_' + federationCount + '_'
        });
        await mvh.start();
        identities = mvh.identities.map(id => new ValidatorIdentity(id.privkeyHex));
        pubkeys    = mvh.getPubkeys().map(p => p.toLowerCase());

        // Gap (b): on a DOGE-only venue every live capability resolution fails (the
        // hub reads the local indexer as its BTC one), and
        // _getActiveOraclePublishPubkeys has no local-table fallback. seedWeightSnapshot
        // patches getWeightSnapshot/getActiveWeightSnapshot on the shared
        // hub.capabilitySnapshot object - the one seam both the election and the
        // signing-set resolution read - and sets hub.network so the WEIGHTED path runs.
        // The default is one DISTINCT SOURCE per booted identity, which is exactly the
        // >= 2-source oracle_publish set AT-F2 requires.
        weightSeed = seedWeightSnapshot(mvh, { blockIndex: snapshotBlock, network: 'regtest' });

        for (let i = 0; i < N; i++) {
            const sap = mvh.hubs[i].stateAnchorPublisher;
            // Every engine caches hub.network ONCE at construction, before
            // seedWeightSnapshot runs; MultiValidatorHub threads HUB_NETWORK, so this is
            // belt-and-braces rather than the load-bearing fix.
            sap.network = 'regtest';
            sap.roundTimeoutMs = ROUND_TIMEOUT_MS;
            sap.electionToleranceBlocks = 100000;
            // _verifyAnchorOnChain's ONLY path to the chain. Without it the reward
            // drain answers 'no-indexer' forever and AT-F1's reward record never lands,
            // which would read as a degraded round rather than an unwired test.
            sap.indexers = sap.indexers || {};
            sap.indexers.DOGE = { url: indexerConnector.url, key: process.env.INDEXER_API_KEY || '' };

            // Wire-level observation of the archive attestation request, ABOVE the
            // handler silenceArchiveAttestor replaces. The publisher's listener reads
            // _handleMessage at call time, so wrapping the instance method sees every
            // envelope without detaching anything.
            archiveSignReqSeen.push(0);
            const idx  = i;
            const orig = sap._handleMessage;
            sap._handleMessage = function (envelope) {
                if (envelope && envelope.type === SAP.XANCARCHPUB_SIGN_REQ) archiveSignReqSeen[idx]++;
                return orig.call(this, envelope);
            };

            const hubIdx = i;
            sap.setBroadcastHook(async (payload) => {
                const result = await signerHooks.broadcastFn(payload);
                broadcasts.push({ hub: hubIdx, payload, txid: result.txid, phase1_txid: result.phase1_txid });
                // regtest has no organic blocks, and the tracker must see fresh UTXOs
                // before the next publish of the same cycle.
                await regtestMinerConnector.generateBlocks(1);
                await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
                return result;
            });
        }

        // Mirror the capability snapshot into the INDEXER DB (what hub_db_sync would
        // deliver in a hub-connected deployment) so the ANCHOR handler verifies as
        // 'valid' rather than 'unverified'. BOTH validators, each its own non-blank
        // source: the regtest tally is stake-weighted at genesis and dedupes by
        // DISTINCT source, so a blank one fails closed (WI-1).
        for (const cap of ['oracle_publish', 'cross_chain']) {
            for (const pk of pubkeys) {
                await indexerQuery(
                    'INSERT INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) VALUES (?, ?, ?, ?, ?) ' +
                    'ON DUPLICATE KEY UPDATE amount = VALUES(amount), source = VALUES(source)',
                    [snapshotBlock, cap, pk, '1', pk]);
            }
        }
        const seeded = await indexerQuery(
            'SELECT capability, signing_pubkey FROM capability_snapshots WHERE snapshot_block = ?', [snapshotBlock]);
        assert.strictEqual(seeded.length, 2 * N,
            'both validators are in both capability sets at snapshot block ' + snapshotBlock);

        // The SAME rows in each hub's OWN capability_snapshots, which the indexer-side
        // seed above does not touch (separate databases).
        //
        // The PINNED election path (_getActiveOraclePublishPubkeys, which gates the v0
        // bundle) asks hub.capabilitySnapshot first and falls back to this local table on
        // regtest. seedWeightSnapshot covers the accessor the SIGNING-set resolver uses,
        // but the third live drive of this suite showed the pinned path resolving neither:
        // "capability snapshot unavailable AND the local capability_snapshots table has no
        // rows", once per federation, so every publisher abstained from its bundle election
        // and correctly refused to spend a fee on a v0 that would index invalid. Every
        // "the bundle never reached the chain" failure was downstream of that one line.
        // anchorAcceptance's header already names this clause; this is the two-hub form of
        // it, and it is belt-and-braces: whichever branch answers, the answer is now the
        // same set. Rows are IDENTICAL on every hub, which matters beyond the election -
        // the archive carries a capability_snapshots section and a follower byte-compares
        // it against its own rebuild.
        //
        // A NON-BLANK, per-validator source is required, not cosmetic: the stake-weighted
        // tally dedupes by DISTINCT source and fails closed on a blank one (WI-1).
        for (const cap of ['oracle_publish', 'cross_chain']) {
            for (const pk of pubkeys) {
                await allHubs(
                    'INSERT IGNORE INTO capability_snapshots (snapshot_block, capability, signing_pubkey, amount, source) ' +
                    'VALUES (?, ?, ?, ?, ?)',
                    [snapshotBlock, cap, pk, '1', pk]);
            }
        }

        // PROVE, at boot, that the two resolvers the publish path depends on actually
        // answer - on the very methods that gate them, on every hub. Without this the
        // failure presents minutes later as a missing v0 bundle, which reads as a
        // publisher defect rather than as an unseeded fixture.
        let resolvedSources = null;
        for (let i = 0; i < N; i++) {
            const sap = mvh.hubs[i].stateAnchorPublisher;
            // (0) The network field itself, because it gates BOTH halves of the pinned
            // resolver: it decides weighted-vs-count (and only the WEIGHTED accessor is
            // the one seedWeightSnapshot patches), and the local-table fallback is
            // `if(this.network === 'regtest' && this.db)`. A wrong value here makes the
            // seed above inert and produces the exact "snapshot unavailable AND no local
            // rows" line the third drive hit, so name it rather than leave it inferred.
            assert.strictEqual(String(sap.network), 'regtest',
                'hub' + i + ': the publisher\'s network is regtest (got "' + sap.network + '"); ' +
                'off regtest the weighted accessor and the local capability_snapshots fallback are both bypassed');
            assert.strictEqual(String(mvh.hubs[i].network), 'regtest',
                'hub' + i + ': the hub\'s network is regtest (got "' + mvh.hubs[i].network + '")');
            // (1) The PINNED election set: the exact call _publishPendingCheckpoints makes
            // before it will elect a bundle publisher at all.
            const eligible = await sap._getActiveOraclePublishPubkeys(snapshotBlock);
            assert.deepStrictEqual([...eligible].sort(), [...pubkeys].sort(),
                'hub' + i + ': the PINNED oracle_publish election resolves to the whole federation at block ' +
                snapshotBlock + ' (got ' + JSON.stringify(eligible) + '). An unresolved set makes the publisher ' +
                'abstain from the bundle election, and no v0 ever reaches the chain.');
            // (2) The SIGNING set the attestation rounds tally, with the distinct
            // non-blank sources the weighted quorum needs.
            const signingSet = await sap._resolveCapabilitySet('oracle_publish', snapshotBlock, 'regtest');
            const sources    = signingSet.map(v => String(v.source));
            assert.strictEqual(signingSet.length, N,
                'hub' + i + ': the signing set resolves to all ' + N + ' validators (got ' + signingSet.length + ')');
            assert.strictEqual(new Set(sources).size, N,
                'hub' + i + ': every validator carries a DISTINCT source (got ' + JSON.stringify(sources) + ')');
            assert.ok(!sources.some(s => s === ''),
                'hub' + i + ': no source is blank, which WI-1\'s stake tally fails closed on (got ' +
                JSON.stringify(sources) + ')');
            resolvedSources = sources;
        }

        // Both rounds this suite drives are broadcast-then-wait, so an unpeered pair
        // times out in a way indistinguishable from an unresolved capability set.
        // Counted with the SAME gate PeerManager.broadcast applies.
        const peers = await waitForPeering(60000);
        assert.ok(peers.every(c => c >= N - 1),
            'every hub can deliver a broadcast to the rest of the federation (open peers per hub: ' +
            JSON.stringify(peers) + '); an unpeered pair collects no co-signature and every round degrades');

        // Rerunnability on a dirty regtest chain: the indexer's replay guards reject a
        // seq at-or-below the on-chain max while these hub DBs restart their counters
        // at 0. Seed both hubs' counters past whatever earlier runs anchored. The
        // baseline row is IDENTICAL on every hub (which is what keeps _getNextBatchSeq
        // equal at boot) and carries a batch_seq already, so no archive selector picks
        // it up.
        const prior = await indexerQuery(
            'SELECT MAX(match_batch_seq) AS max_batch FROM anchor_actions WHERE version IN (1, 6)');
        const maxBatch = (prior.length && prior[0].max_batch != null) ? Number(prior[0].max_batch) : null;
        if (maxBatch !== null) {
            await allHubs(
                `INSERT IGNORE INTO cross_chain_matches
                    (match_id, snapshot_block, network, a_chain, a_action_index, a_tick, a_amount, a_payout_addr,
                     b_chain, b_action_index, b_tick, b_amount, b_payout_addr, effective_time,
                     validator_signatures, status, batch_seq, archived_status)
                 VALUES ('degarc-seq-baseline', ?, 'regtest', 'DOGE', 0, 'X', '0', 'x', 'LTC', 0, 'X', '0', 'x', 0,
                         '[]', 'finalized', ?, 'finalized')`,
                [snapshotBlock, maxBatch]);
        }

        // Equal tables are the precondition every election below rests on. Prove it
        // at boot rather than discovering a mismatch as a stalled round later.
        const seqs = [];
        for (let i = 0; i < N; i++) seqs.push(Number(await mvh.hubs[i].stateAnchorPublisher._getNextBatchSeq()));
        assert.strictEqual(new Set(seqs).size, 1,
            'a fresh federation starts with every hub on the same next batch seq (got ' + JSON.stringify(seqs) + ')');

        // The resolved sources are logged, not just asserted: they say WHICH source
        // answered (seedWeightSnapshot's stub hands back src0/src1, the local-table
        // fallback hands back the validator pubkeys), which is the first thing worth
        // knowing if a future drive resolves an unexpected set.
        console.log('    [' + label + '] federation ' + federationCount + ' up: ' + N + ' hubs, snapshot_block ' +
                    snapshotBlock + ', batch baseline ' + maxBatch + ', next batch seq ' + seqs[0] +
                    ', peers/hub ' + JSON.stringify(peers) +
                    ', oracle_publish sources ' + JSON.stringify(resolvedSources.map(s => String(s).slice(0, 12))) +
                    ', archive round timeout ' + ROUND_TIMEOUT_MS + 'ms');
    }

    async function stopFederation(){
        // A fault outliving its federation would mute a hub for whatever comes next.
        if (fault) { try { fault(); } catch (e) { console.warn('    fault restore failed: ' + (e && e.message)); } fault = null; }
        if (weightSeed) { weightSeed.restore(); weightSeed = null; }
        if (mvh) { await mvh.stop(); await mvh.dropDatabases(); mvh = null; }
    }

    // A DOGE checkpoint row signed by BOTH validators over the hub's OWN
    // canonical. Root-bearing by construction: the publisher SKIPS a checkpoint row
    // with null roots with a log line rather than emitting a rootless section (D8),
    // so a rootless filler would simply be absent and every assert below would misread.
    function signedCheckpoint(chain, seq){
        let row = {
            chain, network: 'regtest', block_index: 100000 + seq,
            block_hash:    crypto.randomBytes(32).toString('hex'),
            ledger_hash:   crypto.randomBytes(32).toString('hex'),
            actions_hash:  crypto.randomBytes(32).toString('hex'),
            contract_hash: crypto.randomBytes(32).toString('hex'),
            checkpoint_seq: seq, snapshot_block: snapshotBlock,
            state_root:           crypto.randomBytes(32).toString('hex'),
            state_root_version:   1,
            block_merkle_root:    crypto.randomBytes(32).toString('hex'),
            block_merkle_version: 1
        };
        row.validator_signatures = JSON.stringify(identities.map(id => ({
            pubkey: id.getPubkeyHex().toLowerCase(),
            sig:    id.sign(SCE.canonicalCheckpoint(row))
        })));
        return row;
    }

    // The checkpoint seq for the next cycle: past BOTH the indexer's on-chain
    // watermark and the hubs' own newest row.
    //
    // The indexer half clears the per-chain replay guard on a dirty regtest chain.
    // The LOCAL half is what makes a second cycle work at all: an archive-only cycle
    // publishes no v0, so the indexer never learns a newer checkpoint_seq and the
    // indexer half alone hands back the SAME seq it did last cycle. The duplicate row
    // is then swallowed by INSERT IGNORE, the wrapper silently stays the previous
    // cycle's checkpoint, and every later lookup keyed on this cycle's ledger_hash
    // hunts an anchor that was never built from it.
    async function nextCheckpointSeq(chain){
        const onChain = await nextSeq(chain);
        const local   = await mvh.hubs[0].db.doQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM state_checkpoints WHERE chain = ? AND network = ?',
            [chain, 'regtest']);
        return Math.max(onChain, Number(local[0].s));
    }

    async function insertCheckpointEverywhere(row){
        await allHubs(
            'INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, ' +
            'actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures, ' +
            'state_root, state_root_version, block_merkle_root, block_merkle_version) ' +
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [row.chain, row.network, row.block_index, row.block_hash, row.ledger_hash,
             row.actions_hash, row.contract_hash, row.checkpoint_seq, row.snapshot_block,
             row.validator_signatures, row.state_root, row.state_root_version,
             row.block_merkle_root, row.block_merkle_version]);

        // INSERT IGNORE swallows a duplicate, so prove THIS row is the one every hub
        // now holds at that seq. A swallowed insert leaves the previous cycle's
        // checkpoint as the wrapper while every assertion downstream keys on this
        // cycle's ledger_hash, which fails far from the cause.
        for (let i = 0; i < N; i++) {
            const got = await mvh.hubs[i].db.doQuery(
                'SELECT ledger_hash FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?',
                [row.chain, row.network, row.checkpoint_seq]);
            assert.strictEqual(got.length, 1,
                'hub' + i + ': exactly one ' + row.chain + ' checkpoint at seq ' + row.checkpoint_seq);
            assert.strictEqual(String(got[0].ledger_hash), String(row.ledger_hash),
                'hub' + i + ': the checkpoint at seq ' + row.checkpoint_seq + ' is THIS cycle\'s row, not an ' +
                'earlier one an INSERT IGNORE preserved');
        }
    }

    // A finalized cross-chain match, signed by BOTH validators (a follower
    // re-verifies the archived matches against its own rows, and the weighted tally
    // needs both sources), inserted identically on every hub. This is the archive's
    // cargo: without a pending row there is no batch to archive at all.
    async function insertMatchEverywhere(matchId){
        let m = {
            match_id: matchId, snapshot_block: snapshotBlock, network: 'regtest',
            a_chain: 'DOGE', a_action_index: 11, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
            a_filled_before: '0', a_ownership: 0, a_payout_addr: 'degraded_payout_a',
            b_chain: 'LTC', b_action_index: 22, b_kind: 'swap', b_tick: 'TOKB', b_amount: '2000',
            b_filled_before: '0', b_ownership: 0, b_payout_addr: 'degraded_payout_b',
            effective_time: Math.floor(Date.now() / 1000)
        };
        let canonical = mvh.hubs[0].getCrossChainDex()._canonicalMatch(m);
        let sigs = JSON.stringify(identities.map(id =>
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

        // Prove the seed is genuinely UNBATCHED on every hub, at the moment it is
        // written. The archive selector's pending test is
        // `batch_seq IS NULL OR archived_status <> status`, so a row that somehow
        // landed already stamped is invisible to the round and the cycle flushes an
        // empty pipeline, which surfaces minutes later as an unexplained 'none'. Both
        // columns are nullable with no default (xchain-hub src/sql/cross_chain_matches.sql),
        // so this should always hold; it is asserted because the failure mode it
        // guards is one that reads as an election fault.
        for (let i = 0; i < N; i++) {
            const rows = await mvh.hubs[i].db.doQuery(
                'SELECT batch_seq FROM cross_chain_matches WHERE match_id = ?', [matchId]);
            assert.strictEqual(rows.length, 1, 'hub' + i + ': the seeded match landed');
            assert.ok(rows[0].batch_seq === null || rows[0].batch_seq === undefined,
                'hub' + i + ': the seeded match is unbatched, so the archive round can pick it up (batch_seq ' +
                rows[0].batch_seq + ')');
        }
        return m;
    }

    // The archive pipeline as _startArchiveRound sees it: its three pending selectors,
    // run verbatim against one hub.
    //
    // With matches, calls and rewards ALL empty the round returns 'none' (spec §1) no
    // matter how clean the election was, and nothing outside the hub shows why. In a
    // two-cycle test the first cycle consumes what it seeded, so the second cycle's
    // content is a precondition to establish rather than assume: this is what AT-F4's
    // recovery cycle failed on with an election that was entirely correct (both hubs
    // agreeing on batch 36 and on the leader, nothing in flight).
    async function archivePipeline(hubIndex){
        const sap = mvh.hubs[hubIndex].stateAnchorPublisher;
        const db  = mvh.hubs[hubIndex].db;
        const matches = await db.doQuery(
            'SELECT match_id FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status ' +
            'ORDER BY match_id ASC LIMIT ?', [sap.maxBatch]);
        const calls = await db.doQuery(
            'SELECT call_id FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status ' +
            'ORDER BY call_id ASC, phase ASC LIMIT ?', [sap.maxBatch]);
        const rewards = await db.doQuery(
            "SELECT reward_type, round_number, validator_pubkey, block_index FROM validator_rewards " +
            "WHERE reward_type LIKE 'anchor\\_%' AND batch_seq IS NULL AND block_index IS NOT NULL " +
            'ORDER BY reward_type ASC, round_number ASC, validator_pubkey ASC LIMIT ?', [sap.maxBatch]);
        return {
            matches: matches.length,
            calls:   calls.length,
            // The publisher drops chain-derived rewards from the batch (the chain
            // re-derives them), so count what it would actually keep, through its own
            // predicate rather than a copy of the rule.
            rewards: (rewards || []).filter(r => !sap._isChainDerivedReward(r)).length
        };
    }

    function describePipeline(p){
        return 'pending matches ' + p.matches + ', calls ' + p.calls + ', archivable rewards ' + p.rewards;
    }

    // Seqs must clear the indexer's per-chain replay guard: the regtest chain is
    // dirty with earlier runs' anchors while these hub DBs are brand new.
    async function nextSeq(chain){
        let r = await indexerQuery(
            'SELECT COALESCE(MAX(checkpoint_seq), -1) + 1 AS s FROM anchor_actions WHERE chain = ? AND network = ?',
            [chain, 'regtest']);
        return Number(r[0].s);
    }

    // The v1 archive-head tail, off the bytes that went to the chain.
    // anchorVersionHelper parses the v0 BUNDLE wire only, and adding a v1 parser to
    // that shared helper is another row's surface, so the walk lives here:
    //   ANCHOR|1|CHAIN|NETWORK|BLOCK_INDEX|BLOCK_HASH|LEDGER_HASH|ACTIONS_HASH
    //         |CONTRACT_HASH|CHECKPOINT_SEQ|SNAPSHOT_BLOCK|MATCH_BATCH_SEQ
    //         |MATCH_COUNT|CRC|TOTAL_CHUNKS|CHUNK0|SIG_COUNT|PUBKEY|SIG|...
    //         |PUBLISHER|ATTEST_SIG_COUNT|APUBKEY|ASIG|...
    // (StateAnchorPublisher._publishArchive builds it; xchain-indexer anchor.js
    // formats[1] reads it back at the same offsets.)
    function parseArchiveHead(payload){
        let f = String(payload).split('|');
        if (f[0] !== 'ANCHOR' || f[1] !== '1') return null;
        const SIG_COUNT_INDEX = 16;
        let sigCount = Number(f[SIG_COUNT_INDEX]);
        if (!Number.isInteger(sigCount) || sigCount < 0)
            throw new Error('ANCHOR v1 has a non-numeric SIG_COUNT');
        let tail = SIG_COUNT_INDEX + 1 + (2 * sigCount);
        if (tail + 1 >= f.length) throw new Error('ANCHOR v1 carries no publisher tail');
        let attestCount = Number(f[tail + 1]);
        if (!Number.isInteger(attestCount) || attestCount < 0)
            throw new Error('ANCHOR v1 has a non-numeric ATTEST_SIG_COUNT');
        return {
            chain: f[2], network: f[3], block_index: Number(f[4]),
            ledger_hash: f[6], checkpoint_seq: Number(f[9]), snapshot_block: Number(f[10]),
            batch_seq: Number(f[11]), sig_count: sigCount,
            publisher: String(f[tail]).toLowerCase(), attest_sig_count: attestCount
        };
    }

    // ONE hub's view of the archive election, assembled from the SAME reads
    // _startArchiveRound makes on that hub: its own BTC tip, its own wrapper
    // checkpoint (the BTC-preferred latest row on the consensus key), its own next
    // batch seq, its own oracle_publish election set, its own key method. Nothing
    // here is taken from a peer or from the harness's identity list, because reading
    // one hub and flushing another is exactly how the first live drive lost a cycle.
    async function archiveElectionView(i){
        const hub = mvh.hubs[i];
        const sap = hub.stateAnchorPublisher;
        const electionBlock = await hub._resolveBtcLatestBlock();
        const cpRow = (await hub.db.doQuery(
            "SELECT * FROM state_checkpoints WHERE network = ? " +
            "ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1",
            ['regtest']))[0];
        const batchSeq = Number(await sap._getNextBatchSeq());
        const key      = sap._archiveElectionKey(
            { chain: cpRow.chain, network: cpRow.network, checkpoint_seq: cpRow.checkpoint_seq }, batchSeq);
        const order    = SAP.hashOrder(key, await sap._getActiveOraclePublishPubkeys(electionBlock));
        return {
            hub: i, electionBlock, cpRow, batchSeq, key, order,
            leader: pubkeys.indexOf(order[0]),
            // The hub's OWN verdict on itself, through the predicate _startArchiveRound
            // consults. A rank the test computed and a rank the hub computed disagreeing
            // is precisely the bug this function exists to catch.
            selfRankZero: sap._isRankZero(order)
        };
    }

    // The archive election, agreed by the WHOLE federation.
    //
    // On a federation's FIRST cycle this is settled by construction (bootFederation
    // asserts the seqs are equal), and the poll returns immediately. It still polls
    // because AT-F4's second cycle depends on the XANC_FINALIZED back-fill of
    // batch_seq reaching the non-publishing hub, and that is a real, bounded wait.
    // What it must never do is paper over a SPLIT: if the hubs have genuinely
    // diverged (each having published its own batch), no amount of waiting converges
    // them, so the budget expires and the result carries every hub's view for the
    // assertion message.
    async function electArchive(timeMax = 120000){
        const deadline = Date.now() + timeMax;
        let views = [];
        while (Date.now() < deadline) {
            views = [];
            for (let i = 0; i < N; i++) views.push(await archiveElectionView(i));
            const agreedKey    = new Set(views.map(v => v.key)).size === 1;
            const agreedLeader = new Set(views.map(v => v.leader)).size === 1;
            const leader       = views[0].leader;
            if (agreedKey && agreedLeader && leader >= 0 && views[leader].selfRankZero) {
                return {
                    converged: true, views,
                    cpRow:    views[leader].cpRow,
                    batchSeq: views[leader].batchSeq,
                    key:      views[leader].key,
                    leader:   leader,
                    // N = 2, so the non-leader IS the co-signer whose
                    // _handleArchiveAttestSignReq AT-F3 mutes. Silencing the leader would
                    // be a no-op by construction: the leader broadcasts the request and
                    // waits, it never answers one.
                    follower: pubkeys.indexOf(views[leader].order[views[leader].order.length - 1])
                };
            }
            await sleep(1000);
        }
        return { converged: false, views };
    }

    // Every hub's election view, one line each, for an assertion message.
    function describeViews(views){
        return (views || []).map(v =>
            'hub' + v.hub + ' batch ' + v.batchSeq + ' key ' + v.key +
            ' leader hub' + v.leader + (v.selfRankZero ? ' (self rank 0)' : ' (self rank ' + v.order.indexOf(pubkeys[v.hub]) + ')')
        ).join(' | ');
    }

    // The bundle election is keyed on network + snapshot_block only (the bundle's
    // block is the MAX over its sections, and every section of a federation sits at
    // its one snapshot block). Built through the publisher's OWN key method rather
    // than a copy of the string: that tag is an opaque domain separator whose
    // spelling deliberately did not move with the wire version, and a drifting copy
    // here would silently elect the wrong hub.
    function electBundle(){
        let key = mvh.hubs[0].stateAnchorPublisher._bundleElectionKey(
            { network: 'regtest', snapshot_block: snapshotBlock });
        return pubkeys.indexOf(SAP.hashOrder(key, pubkeys)[0]);
    }

    // Wait for the archive head of this cycle. The two-hub archive round is
    // ASYNCHRONOUS: _startArchiveRound returns 'round_started' and the v1 is
    // published later, when the wrapper co-signature arrives - and in a degraded
    // cycle only after the attestation round times out. Polls for the wire rather
    // than settling for a fixed window.
    async function waitForArchiveHead(sinceIndex, timeMax){
        const deadline = Date.now() + timeMax;
        while (Date.now() < deadline) {
            let head = broadcasts.slice(sinceIndex)
                .find(b => anchorVersions.anchorPayloadVersion(b.payload) === 1);
            if (head) return head;
            await sleep(1000);
        }
        return null;
    }

    // The anchor_actions row the DOGE indexer stored for one of our anchors, keyed
    // on OUR ledger_hash so a prior run's anchors on this dirty chain cannot satisfy
    // an assert. Mines while it waits: regtest produces no organic blocks.
    async function waitForIndexedAnchor(version, ledgerHash, timeMax){
        const deadline = Date.now() + timeMax;
        while (Date.now() < deadline) {
            let rows = await indexerQuery(
                `SELECT a.*, s.status FROM anchor_actions a
                 LEFT JOIN index_statuses s ON s.id = a.status_id
                 WHERE a.version = ? AND a.ledger_hash = ?`, [version, ledgerHash]);
            if (rows.length) return rows[0];
            await regtestMinerConnector.generateBlocks(1);
            await sleep(2000);
        }
        return null;
    }

    // The archive-reward record for a batch, as this venue can observe it.
    //
    // ANCHOR_REWARD_DERIVE_ACTIVATION.regtest is 0, so the DOGE indexer deliberately
    // writes NO validator_rewards row: derivation has relocated to the BTC indexer,
    // which keys on the hub-mirrored anchor_reward_attestations row (capability stake
    // is BTC-side; ANCHOR is DOGE-only). On a DOGE-only venue that row IS the reward
    // derivation, and it is written only once the attestation quorum was met AND
    // _verifyAnchorOnChain has bound this exact txid at version 1, dogeConfirmations
    // deep. Drives the real drain the flush head calls rather than reimplementing it.
    async function waitForRewardRecord(hubIndex, batchSeq, timeMax){
        const deadline = Date.now() + timeMax;
        while (Date.now() < deadline) {
            await mvh.hubs[hubIndex].stateAnchorPublisher._drainDeferredRewardAttest();
            let rows = await mvh.hubs[hubIndex].db.doQuery(
                "SELECT * FROM anchor_reward_attestations " +
                "WHERE reward_type = 'anchor_archive' AND round_reference = ? AND snapshot_block = ?",
                [batchSeq, snapshotBlock]);
            if (rows.length) return rows[0];
            await regtestMinerConnector.generateBlocks(1);
            await sleep(2000);
        }
        return null;
    }

    // Every anchor_archive record for this batch across the federation (a co-signer
    // can write its own copy from a federated XANCREWARD, so a leader-only read
    // would miss one).
    async function rewardRecordsAnywhere(batchSeq){
        let found = [];
        for (let i = 0; i < N; i++) {
            let rows = await mvh.hubs[i].db.doQuery(
                "SELECT publisher FROM anchor_reward_attestations " +
                "WHERE reward_type = 'anchor_archive' AND round_reference = ? AND snapshot_block = ?",
                [batchSeq, snapshotBlock]);
            for (let r of rows) found.push('hub' + i + ':' + String(r.publisher).slice(0, 12));
        }
        return found;
    }

    // One publish cycle on the current federation: a fresh checkpoint and a fresh
    // pending match on every hub, then a flush by the hubs that are elected to
    // publish something.
    //
    // opts.onElected(election) fires AFTER the election and BEFORE any flush. The
    // archive election key binds the wrapper checkpoint and the batch seq, both of
    // which this cycle's own inserts move, so who the co-signer IS cannot be known
    // any earlier. Injecting a fault from outside on a previous cycle's election
    // would silence the wrong hub half the time.
    //
    // opts.requireBundle (default true) also flushes the elected BUNDLE publisher
    // and asserts a v0 landed. AT-F4 turns it off: recovery is a claim about the
    // archive tail, and flushing only the archive leader keeps exactly one hub
    // publishing, which is the cleanest run the batch_seq back-fill can get.
    async function runCycle(label, opts){
        opts = opts || {};
        const requireBundle = opts.requireBundle !== false;

        // SETTLE FIRST. An archive round still in flight from an earlier cycle makes
        // this cycle's flush return 'round_pending' before it elects anything, and it
        // also means the batch seq every election below reads is one the in-flight
        // round is about to consume. On a federation's first cycle this returns
        // immediately; it is AT-F4's second cycle that needs it.
        let busy = await waitForArchiveQuiescent(ROUND_TIMEOUT_MS + 240000);
        assert.strictEqual(busy.length, 0,
            label + ': an archive round from an earlier cycle never settled (' + describeBusy(busy) + '). ' +
            'Flushing now would return round_pending and this cycle would be measuring the previous ' +
            'round rather than its own.');

        let seq = await nextCheckpointSeq('DOGE');
        let cp  = signedCheckpoint('DOGE', seq);
        await insertCheckpointEverywhere(cp);
        let matchId = crypto.createHash('sha256')
            .update('degraded-archive-' + label + '-' + Date.now()).digest('hex');
        await insertMatchEverywhere(matchId);

        // WHO IS ELECTED, settled and asserted BEFORE anything flushes. A split here
        // fails naming both hubs' views; discovering it after the flush would surface
        // as a missing archive head, which reads like a publisher defect.
        let election = await electArchive();
        assert.ok(election.converged,
            label + ': the hubs do not agree on the archive election. Views: ' + describeViews(election.views) +
            '. _getNextBatchSeq is MAX+1 over each hub\'s OWN tables, so unequal tables mean ' +
            'different election keys and each hub can be rank 0 for its own; that is a SPLIT, ' +
            'not a lag, and no wait converges it.');
        assert.strictEqual(Number(election.cpRow.checkpoint_seq), seq,
            label + ': the archive wrapper is this cycle\'s checkpoint');
        assert.ok(election.leader >= 0 && election.follower >= 0 && election.leader !== election.follower,
            label + ': the election resolved to one leader and one distinct co-signer (' +
            describeViews(election.views) + ')');
        assert.ok(election.views[election.leader].selfRankZero,
            label + ': hub' + election.leader + ' agrees it is rank 0 for batch ' + election.batchSeq +
            ' (' + describeViews(election.views) + ')');

        let bundleLeader = electBundle();
        let before       = broadcasts.length;
        let seenBefore   = archiveSignReqSeen.slice();
        console.log('    [' + label + '] cp seq ' + seq + ' / batch ' + election.batchSeq +
                    ': archive leader hub' + election.leader + ' (self rank 0), co-signer hub' + election.follower +
                    (requireBundle ? ', bundle leader hub' + bundleLeader : ', archive-only') +
                    '; key ' + election.key);
        if (opts.onElected) await opts.onElected(election);

        // THE CONTENT PRECONDITION, checked on the hub that is about to publish and
        // as late as possible: an empty pipeline makes _startArchiveRound answer
        // 'none' however clean the election is, and that is indistinguishable from an
        // election fault once the flush has returned.
        const pipeline = await archivePipeline(election.leader);
        assert.ok(pipeline.matches >= 1,
            label + ': hub' + election.leader + ' holds unarchived content to publish (' +
            describePipeline(pipeline) + '). All three empty means _startArchiveRound returns "none" ' +
            'before it does anything else, so this cycle needs its own freshly seeded, unbatched row.');

        // Bundle first when it is wanted (it publishes synchronously inside the
        // flush), then the archive round. One flush covers both when the two
        // elections agree on the same hub.
        let order = requireBundle
            ? ((bundleLeader === election.leader) ? [bundleLeader] : [bundleLeader, election.leader])
            : [election.leader];
        let summaries = {};
        for (const i of order) summaries[i] = await mvh.hubs[i].stateAnchorPublisher.flush();

        // The elected leader must have ACCEPTED the round. 'none' here is the exact
        // shape of the first live drive's failure: the flushed hub declined the
        // election, and the missing head minutes later was only the symptom.
        //
        // 'round_pending' is deliberately NOT accepted here. It means the guard at the
        // top of _startArchiveRound refused because a round was already in flight, so
        // every assertion after this point would be reading the PREVIOUS cycle's head:
        // a green that measures something easier than it claims. The quiesce wait above
        // is the fix; seeing this verdict despite it means a round started in between.
        let archiveSummary = String(summaries[election.leader] && summaries[election.leader].archive);
        assert.ok(archiveSummary === 'round_started' || archiveSummary === 'published',
            label + ': the elected hub' + election.leader + ' started its archive round for batch ' +
            election.batchSeq + ' (flush said archive="' + archiveSummary + '"). ' +
            'A "round_pending" means an earlier round was still in flight despite the settle wait. ' +
            'A "none" is NOT the content gate here: the pipeline was checked non-empty immediately ' +
            'above (' + describePipeline(pipeline) + '), so look at the election set or the wrapper ' +
            'checkpoint instead. Views: ' + describeViews(election.views) +
            '; in flight now: ' + (describeBusy(busyArchiveRounds()) || 'nothing'));

        let bundle = anchorVersions.bundleBroadcasts(broadcasts.slice(before))
            .find(b => b.bundle.sections.some(s => String(s.ledger_hash) === String(cp.ledger_hash)));
        if (requireBundle)
            assert.ok(bundle, label + ': the v0 bundle carrying this cycle\'s checkpoint went to the chain');

        // A degraded cycle waits out ROUND_TIMEOUT_MS on top of the mine/quiesce
        // legs, so the budget clears it with room rather than racing it.
        let headWire = await waitForArchiveHead(before, ROUND_TIMEOUT_MS + 240000);
        assert.ok(headWire, label + ': the v1 archive head went to the chain');
        let head = parseArchiveHead(headWire.payload);
        assert.strictEqual(head.batch_seq, election.batchSeq,
            label + ': the head carries the batch seq the election was keyed on');
        assert.strictEqual(head.checkpoint_seq, seq, label + ': the head wraps this cycle\'s checkpoint');
        assert.strictEqual(head.publisher, pubkeys[election.leader],
            label + ': the head names the elected leader as PUBLISHER');

        return {
            label, cp, matchId, election, bundleLeader, bundle, head, headWire, summaries,
            signReqDelta: archiveSignReqSeen.map((n, i) => n - seenBefore[i])
        };
    }

    before(async function () {
        // Deterministic regtest seams, all set BEFORE any hub engine is constructed.
        process.env.CHECKPOINT_CHAINS         = 'DOGE';
        process.env.CHECKPOINT_POLL_MS        = '600000000';   // no engine ticks: checkpoints are inserted here
        process.env.ANCHOR_INTERVAL_MS        = '600000000';   // manual flush only
        process.env.ANCHOR_ELECTION_TOLERANCE_BLOCKS = '100000';  // only rank 0 ever unlocks
        // The capability sets are seeded per federation; a local-seed seam left over
        // from another suite in this process would shadow them.
        delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
        if(!process.env.DOGE_INDEXER_URL)
            process.env.DOGE_INDEXER_URL = 'http://localhost:' + (process.env.INDEXER_API_PORT || '3124');
        // coins/DOGE.js confirmations:60 is frozen into StateAnchorPublisher.dogeConfirmations
        // at construction and is unreachable inside this suite's block budget; the
        // reward drain's on-chain proof reads it.
        process.env.XCHAIN_CONFIRMATIONS_DOGE = '1';

        // forceDocker is required: without it, resolution path (1) hands back the
        // venue credential that authenticates but cannot CREATE DATABASE, and
        // MultiValidatorHub makes one DB per hub. One container serves every
        // federation; each makes its own databases and drops them on teardown.
        hubDb = await startDisposableHubDb({ forceDocker: true, port: HUB_DB_PORT, name: HUB_DB_NAME });
        if (!hubDb) { console.log('Skipping degraded-archive acceptance: no Docker available for the disposable hub DB'); this.skip(); }

        SAP = loadHubModule('src/StateAnchorPublisher.js');
        SCE = loadHubModule('src/StateCheckpointEngine.js');

        // One funded publisher wallet and one staged signer for the whole suite;
        // publishes are serialized by runCycle's flush order throughout. Funded for
        // three federations' worth of TWO-PHASE publishes (up to about eight P2SH
        // funding + reveal pairs), where anchorAcceptance needs only two.
        publisherAddr = await cryptoHelper.getNewFundedAddress(
            'degraded-archive-publisher', COIN, NETWORK, null, 'legacy', 0, 12.0
        );
        await regtestMinerConnector.generateBlocks(2);
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector });
        signerHooks = stageProductionSigner(publisherAddr);
    });

    // Every test owns its federation, so nothing it published can reach the next.
    afterEach(async function () {
        await stopFederation();
    });

    after(async function () {
        await stopFederation();
        if (hubDb) await hubDb.stop();
        if (signerDir) fs.rmSync(signerDir, { recursive: true, force: true });
        delete process.env.DOGE_WIF;
        delete process.env.HUB_SIGNER_MODULE;
    });

    it('AT-F1/AT-F2: both hubs answering, the archive round really broadcasts and the attested v1 derives its reward', async function () {
        await bootFederation('AT-F1/F2');
        const c1 = await runCycle('attested');
        const leaderSap = mvh.hubs[c1.election.leader].stateAnchorPublisher;

        // AT-F2, first clause: the set the round resolves at the wrapper's
        // snapshot_block, read through the publisher's OWN resolver. >= 2 DISTINCT
        // SOURCES containing the publisher is what makes snapCount <= 1's
        // self-satisfying short-circuit unreachable.
        let signingSet = await leaderSap._resolveCapabilitySet('oracle_publish', snapshotBlock, 'regtest');
        let sources    = new Set(signingSet.map(v => String(v.source)));
        assert.ok(signingSet.length >= 2,
            'the oracle_publish set holds >= 2 members (got ' + signingSet.length + ')');
        assert.ok(sources.size >= 2,
            'the set holds >= 2 DISTINCT SOURCES, so the stake tally cannot be met by the publisher alone (got ' +
            JSON.stringify([...sources]) + ')');
        assert.ok(signingSet.some(v => v.pubkey === pubkeys[c1.election.leader]),
            'the publisher is itself in the set (otherwise the round abstains before broadcasting)');

        // AT-F2, second clause and the positive one: the round BROADCAST. Counted on
        // the co-signer's own message path, so this is evidence of the wire, not an
        // inference from the set size.
        assert.ok(c1.signReqDelta[c1.election.follower] >= 1,
            'the co-signer observed an XANCARCHPUB_SIGN_REQ this cycle (deltas ' +
            JSON.stringify(c1.signReqDelta) + '); without it the publisher took the short-circuit');

        // AT-F1: the attested v1 head, on the wire and as the indexer stored it.
        assert.ok(c1.head.attest_sig_count >= 1,
            'the v1 head carries an attestation tail (ATTEST_SIG_COUNT ' + c1.head.attest_sig_count + ')');
        let v1Row = await waitForIndexedAnchor(1, c1.cp.ledger_hash, 180000);
        assert.ok(v1Row, 'the indexer parsed and stored the v1 archive head');
        assert.strictEqual(String(v1Row.status), 'valid',
            'the v1 head verified against the mirrored oracle_publish set (got ' + v1Row.status + ')');
        assert.strictEqual(Number(v1Row.match_batch_seq), c1.election.batchSeq);
        assert.ok(v1Row.publisher_attestations && JSON.parse(String(v1Row.publisher_attestations)).length >= 1,
            'the stored tail carries the attestation signatures');

        // AT-F1: the v0 bundle of the same cycle.
        assert.ok(c1.bundle.bundle.attest_sig_count >= 1,
            'the v0 bundle carries its own attestation tail (ATTEST_SIG_COUNT ' +
            c1.bundle.bundle.attest_sig_count + ')');
        let v0Row = await waitForIndexedAnchor(0, c1.cp.ledger_hash, 180000);
        assert.ok(v0Row, 'the indexer parsed and stored the v0 bundle section');
        assert.strictEqual(String(v0Row.status), 'valid',
            'the v0 bundle section is valid (got ' + v0Row.status + ')');

        // AT-F1: the reward. ANCHOR_REWARD_DERIVE_ACTIVATION.regtest is 0, so this is
        // the anchor_reward_attestations row the BTC indexer derives validator_rewards
        // from, written only after the round met quorum AND the head was proven mined.
        let reward = await waitForRewardRecord(c1.election.leader, c1.election.batchSeq, 240000);
        assert.ok(reward, 'an anchor_archive reward record derived for batch ' + c1.election.batchSeq);
        assert.strictEqual(String(reward.publisher).toLowerCase(), pubkeys[c1.election.leader],
            'the reward names the elected publisher');
        assert.strictEqual(String(reward.doge_anchor_txid).toLowerCase(), String(c1.headWire.txid).toLowerCase(),
            'the reward is bound to the archive head that actually mined');
        assert.ok(JSON.parse(String(reward.publisher_attestations)).length >= 1,
            'the reward record carries the XANCPUB quorum it was earned with');
        console.log('    AT-F1: v1 ' + c1.headWire.txid + ' ATTEST_SIG_COUNT ' + c1.head.attest_sig_count +
                    ', reward round_reference ' + c1.election.batchSeq +
                    '; AT-F2: ' + sources.size + ' distinct sources, ' +
                    c1.signReqDelta[c1.election.follower] + ' SIGN_REQ observed by the co-signer');
    });

    it('AT-F3: with the co-signer silenced ON THE ARCHIVE ATTESTATION ONLY, the v1 lands at ATTEST_SIG_COUNT 0, valid, unrewarded - and the SAME cycle\'s v0 bundle still carries its tail', async function () {
        // Its OWN federation, so this is the FIRST archive round these hubs ever run:
        // equal tables, one well-defined election, nothing inherited from an earlier
        // cycle. The fault goes in before that first round, which is what makes the
        // degraded path the only path this test can be measuring.
        await bootFederation('AT-F3');

        // Silenced from inside the cycle, on its own agreed election: the key binds
        // the wrapper checkpoint AND the batch seq, so the co-signer can only be named
        // once both are known. It must be the CO-SIGNER, never the leader: the leader
        // broadcasts XANCARCHPUB_SIGN_REQ and waits for answers, so muting its own
        // handler would change nothing and the round would meet quorum as in AT-F1.
        let silenced = null;
        const c2 = await runCycle('degraded', {
            onElected: (election) => {
                assert.notStrictEqual(election.follower, election.leader,
                    'the fault targets the CO-SIGNER; silencing the elected leader is a no-op by construction');
                silenced = election.follower;
                fault = silenceArchiveAttestor(mvh.hubs[election.follower]);
                console.log('    silencing hub' + election.follower + ' (co-signer for batch ' +
                            election.batchSeq + ', leader is hub' + election.leader + ') on the archive attestation only');
            }
        });
        assert.strictEqual(c2.election.follower, silenced,
            'the hub that was silenced is this cycle\'s co-signer');
        assert.notStrictEqual(silenced, c2.election.leader,
            'the elected publisher was left answering; only its co-signer went quiet');

        // The degraded shape: the head still lands, with no tail.
        assert.strictEqual(c2.head.attest_sig_count, 0,
            'the archive attestation round did not meet quorum, so the tail is empty');
        assert.ok(c2.head.sig_count >= 2,
            'the WRAPPER co-sign quorum was untouched by the fault (' + c2.head.sig_count + ' signatures)');
        let v1Row = await waitForIndexedAnchor(1, c2.cp.ledger_hash, 180000);
        assert.ok(v1Row, 'the indexer parsed and stored the degraded v1 archive head');
        assert.strictEqual(String(v1Row.status), 'valid',
            'a degraded attestation costs the reward, never the checkpoint (got ' + v1Row.status + ')');
        assert.strictEqual(v1Row.publisher_attestations, null,
            'an ATTEST_SIG_COUNT 0 tail stores NULL, carrying no signatures at all');

        // The request still reached the co-signer; only the ANSWER was withheld. This
        // is what separates a degraded round from a round that never ran.
        assert.ok(c2.signReqDelta[c2.election.follower] >= 1,
            'the silenced co-signer still received the XANCARCHPUB_SIGN_REQ (deltas ' +
            JSON.stringify(c2.signReqDelta) + ')');

        // No reward for this batch, on either hub, after the SAME drain that produced
        // one in AT-F1 has had its chance.
        // give-up-ok: the null IS the assertion here, and it is only meaningful
        // because the identical call returns a row on the attested path.
        let none = await waitForRewardRecord(c2.election.leader, c2.election.batchSeq, 60000);
        assert.strictEqual(none, null,
            'no anchor_archive reward record derived for the degraded batch ' + c2.election.batchSeq);
        assert.deepStrictEqual(await rewardRecordsAnywhere(c2.election.batchSeq), [],
            'no hub in the federation holds a reward record for the degraded batch');

        // THE clause the narrow seam exists for: the v0 bundle of this same cycle is
        // untouched. A shared-timer fault would have landed it 'invalid: ATTEST_SIG_COUNT'.
        assert.ok(c2.bundle.bundle.attest_sig_count >= 1,
            'the v0 bundle of the degraded cycle still carries its attestation tail (ATTEST_SIG_COUNT ' +
            c2.bundle.bundle.attest_sig_count + ')');
        let v0Row = await waitForIndexedAnchor(0, c2.cp.ledger_hash, 180000);
        assert.ok(v0Row, 'the indexer parsed and stored the v0 bundle section of the degraded cycle');
        assert.strictEqual(String(v0Row.status), 'valid',
            'the v0 bundle of the degraded cycle is still valid (got ' + v0Row.status + ')');
        console.log('    AT-F3: v1 ' + c2.headWire.txid + ' ATTEST_SIG_COUNT 0 valid, no reward for batch ' +
                    c2.election.batchSeq + '; v0 bundle still ' + v0Row.status + ' with ' +
                    c2.bundle.bundle.attest_sig_count + ' attesting sig(s)');
    });

    it('AT-F4: the co-signer returns and the NEXT archive batch carries a tail again and derives its reward', async function () {
        // Recovery is inherently two cycles in ONE federation, so this is the only
        // test that cannot be reduced to a first cycle. Both cycles are ARCHIVE-ONLY
        // and flush only the elected leader, so exactly one hub ever publishes and
        // the batch_seq back-fill has the cleanest run it can get. If cycle 2 still
        // finds the hubs split, runCycle fails with both views: that is the honest
        // outcome, not something to assert around.
        await bootFederation('AT-F4');

        const degraded = await runCycle('degraded (recovery baseline)', {
            requireBundle: false,
            onElected: (election) => {
                fault = silenceArchiveAttestor(mvh.hubs[election.follower]);
                console.log('    silencing hub' + election.follower + ' (co-signer for batch ' +
                            election.batchSeq + ') on the archive attestation only');
            }
        });
        assert.strictEqual(degraded.head.attest_sig_count, 0,
            'the baseline cycle really did degrade (ATTEST_SIG_COUNT ' + degraded.head.attest_sig_count + ')');

        // The co-signer returns.
        fault();
        fault = null;
        console.log('    co-signer restored; driving the next archive batch');

        const recovered = await runCycle('recovered', { requireBundle: false });
        assert.ok(recovered.head.attest_sig_count >= 1,
            'the recovered batch carries an attestation tail again (ATTEST_SIG_COUNT ' +
            recovered.head.attest_sig_count + ')');
        assert.notStrictEqual(recovered.election.batchSeq, degraded.election.batchSeq,
            'the recovery batch is a NEW batch, not a retry of the degraded one');

        let v1Row = await waitForIndexedAnchor(1, recovered.cp.ledger_hash, 180000);
        assert.ok(v1Row, 'the indexer parsed and stored the recovered v1 archive head');
        assert.strictEqual(String(v1Row.status), 'valid');
        assert.ok(v1Row.publisher_attestations && JSON.parse(String(v1Row.publisher_attestations)).length >= 1,
            'the recovered head stores its attestation tail');

        let reward = await waitForRewardRecord(recovered.election.leader, recovered.election.batchSeq, 240000);
        assert.ok(reward, 'an anchor_archive reward record derived for the recovered batch ' + recovered.election.batchSeq);
        assert.strictEqual(String(reward.doge_anchor_txid).toLowerCase(), String(recovered.headWire.txid).toLowerCase(),
            'the recovered reward is bound to the recovered head');

        // The degraded batch stays unrewarded for good: recovery mints the NEXT
        // batch's reward, it does not back-fill the one the federation withheld.
        assert.deepStrictEqual(await rewardRecordsAnywhere(degraded.election.batchSeq), [],
            'the degraded batch is still unrewarded after recovery');
        console.log('    AT-F4: batch ' + recovered.election.batchSeq + ' ATTEST_SIG_COUNT ' +
                    recovered.head.attest_sig_count + ', reward bound to ' + recovered.headWire.txid +
                    '; batch ' + degraded.election.batchSeq + ' remains unrewarded');
    });
});
