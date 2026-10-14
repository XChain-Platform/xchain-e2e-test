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
 * runArchiveAttestationRound short-circuits `met: true` at snapCount <= 1
 * (anchor/publisher.js), so a one-hub venue proves the ATTESTED path and
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
 * The archive election key is archiveElectionKey(wrapperCp, batchSeq), and
 * batchSeq is getNextBatchSeq(): MAX+1 over that hub's OWN cross_chain_matches
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
 * the leader's own isRankZero BEFORE any flush, then asserts that leader's flush
 * actually returned round_started/published. A mis-election fails as "the elected
 * hubN started its archive round ... flush said archive=none" with every view
 * printed, never as a missing archive head minutes later.
 *
 * WHY NOT ANCHOR_ROUND_TIMEOUT_MS. It is the SHARED round timer: the v0 bundle
 * attestation round, the archive wrapper co-sign round and the archive
 * attestation round all read StateAnchorPublisher.roundTimeoutMs. The v0 bundle
 * tail REQUIRES ATTEST_SIG_COUNT >= 1 (xchain-indexer anchor/index.js throws on 0,
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

const { installHooks } = require('./anchor_degraded_archive.test/hooks');
const atF1F2 = require('./anchor_degraded_archive.test/at_f1_f2_attested');
const atF3   = require('./anchor_degraded_archive.test/at_f3_degraded');
const atF4   = require('./anchor_degraded_archive.test/at_f4_recovery');

describe('ANCHOR live acceptance: degraded ARCHIVE attestation across two validators (DOGE regtest)', function () {
    this.timeout(30 * 60 * 1000);

    installHooks();
    atF1F2.register();
    atF3.register();
    atF4.register();
});
