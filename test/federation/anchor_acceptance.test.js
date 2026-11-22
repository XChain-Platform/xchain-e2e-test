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
 * E2E acceptance: ANCHOR on a LIVE DOGE regtest chain.
 *
 * The on-chain leg the L2 federation test can't cover: a real hub
 * (in-process, single validator via the XDEX_SEED_LOCAL_VALIDATOR seam)
 * checkpoints the REAL DOGE indexer state (getblockhashes RPC), publishes a
 * checkpoint anchor + a match archive as REAL DOGE transactions through the
 * encoder's P2SH two-tx pipeline, the regtest miner mines them, the decoder
 * parses them, and the indexer's ANCHOR handler verifies + stores them.
 *
 * This is acceptance test AT1 of anchor-bundle-per-network.md, driven: with
 * BTC/LTC/DOGE regtest checkpoints pending, one flush lands ONE ANCHOR v0 on
 * DOGE regtest with THREE sections, the indexer holds three anchor_actions rows
 * sharing one action_index at section_index 0..2 all `valid`, and every
 * state_checkpoints row carries the same anchor_txid. The DOGE section is the
 * REAL checkpoint the engine cut from the live indexer; BTC and LTC are
 * synthetic rows signed with the seeded validator's own key over the hub's own
 * XCHECKPOINT canonical (StateCheckpointEngine.canonicalCheckpoint), so all
 * three sections verify against the same mirrored oracle_publish set rather
 * than one section being real and two being 'invalid: SECTION n'.
 *
 * The ANCHOR version set is single-wire (anchor-v0-single-wire.md D2): the
 * checkpoint bundle is v0 and the archive leg is v1, and the earlier per-chain
 * numberings (v0/v3/v4/v5, the interim v7 bundle and the interim v6 archive)
 * stay deleted. The CHECKPOINT leg has exactly one version, and a degraded
 * publisher attestation still falls back WITHIN it to ATTEST_SIG_COUNT 0
 * rather than to another version. The ARCHIVE leg always appends its tail.
 * Neither leg has a cross-version fallback to derive; both are still read from
 * the hub's own frozen modules via test/helpers/anchorVersionHelper.js so an
 * armed ANCHOR_ACTIVATION height (0 on regtest, so every anchor on this chain
 * is already past it) moves the test and the publisher together.
 *
 * Pre-requisites (driven by the operator/runner, NOT this file):
 *   - dogecoin-regtest stack up (node, utxo-tracker, encoder, decoder,
 *     indexer, regtest-miner) with the ANCHOR-aware decoder/indexer code;
 *   - env: COIN=dogecoin NETWORK=regtest HUB_URL/HUB_PORT (config discovery),
 *     HUB_DB_USER/HUB_DB_PASS + HUB_DB_HOST/HUB_DB_PORT (driver hub DB),
 *     DOGE_INDEXER_URL (the checkpoint engine's getblockhashes target),
 *     XDEX_SEED_LOCAL_VALIDATOR=1.
 *
 * The synthetic cross-chain match is signed by the seeded validator and the
 * capability snapshot rows are hand-mirrored into the indexer DB (the
 * mirror TRANSPORT (hub_db_sync WS/REST) is covered by its own unit + L2
 * tests; this run accepts the ON-CHAIN pipeline).
 *
 * SIGNER PATH IS PRODUCTION: broadcasts go through the hub's signer-loader
 * (HUB_SIGNER_MODULE) loading a staged copy of examples/doge-signer.example.js
 * (the exact module operators install in ~/hub-signer), which drives the sdk
 * two-phase P2SH pipeline (encoder createTx → signPsbt → broadcast →
 * spendP2sh → signRevealPsbt → broadcast). A walletSign-only or custom test
 * hook would skip the phase-2 reveal path, which is precisely where the
 * 2026-06-11 mainnet shakedown bug hid. The test only wraps the production
 * hook to mine + quiesce after each publish (regtest has no organic blocks,
 * and the tracker must see fresh UTXOs between the bundle and archive publishes).
 *
 * The follow-up recovery drill (wipe indexer DB -> reindex from chain ->
 * src/recovery.js -> byte-identical hash triples) is driven by the runner
 * after this suite passes -- see the acceptance report.
 *
 * Three gaps that make the pipeline above unrunnable on a realistic venue,
 * plus two reward-leg-only gaps, closed here with the repo's own seams
 * (never re-derived plumbing):
 *
 *   (a) The platform DB user (xchain_hub / the indexer user) lacks CREATE
 *       DATABASE, and MultiValidatorHub makes one DB per hub -> hub.start()
 *       dies ER_DBACCESS_DENIED_ERROR. Fixed via test/helpers/disposableHubDb.js
 *       with forceDocker:true (resolution path (1) would otherwise hand back
 *       the venue's authenticating-but-can't-CREATE credential).
 *   (b) On a DOGE-only venue the hub resolves the local indexer as its BTC
 *       indexer, sees a DOGE indexer, and every live oracle_publish/cross_chain
 *       resolution fails; getActiveOraclePublishPubkeys has NO local-DB
 *       fallback (only resolveCapabilitySet does), so publisher election and
 *       the fail-closed defer check both starve regardless of any row seeded
 *       into capability_snapshots. Fixed via test/helpers/seededWeightSnapshot.js,
 *       which monkeypatches hub.capabilitySnapshot.getWeightSnapshot /
 *       getActiveWeightSnapshot directly (the one seam both call sites share)
 *       and sets hub.network = 'regtest' so the WEIGHTED path is taken.
 *   (c) XCHAIN_CONFIRMATIONS_DOGE defaults to 60 (coins/DOGE.js), read into
 *       StateAnchorPublisher.dogeConfirmations ONCE at construction
 *       (coins.resolveConfirmations); unreachable on regtest inside one test's
 *       block budget. Set to a low value BEFORE `new MultiValidatorHub(...)`.
 *
 * Reward-leg-only (not asserted by this suite's own checks, but required for
 * the ATTESTED path -- without it the publisher's attestation round abstains and
 * the bundle lands with ATTEST_SIG_COUNT 0, which creates no reward row):
 *   - an oracle_publish row seeded into the HUB's OWN capability_snapshots
 *     (the hub side seeds cross_chain and oracle_publish both);
 *   - a NON-BLANK `source` on those rows (the stake-weighted tally
 *     dedupes by source and fails closed on a blank one).
 * seedWeightSnapshot's monkeypatch already makes both capabilities resolve
 * correctly without touching the DB (it intercepts the method, not the
 * table), so this insert is a belt-and-suspenders mirror of the indexer-side
 * seed below, not the load-bearing fix -- see the code comment at the
 * insert site.
 *
 * Also: a same-snapshot-block re-run self-poisons. The INDEXER db is real and
 * persistent across runs (unlike the disposable hub db, torn down every run);
 * each run's fresh MultiValidatorHub validator pubkey lands a NEW row at the
 * SAME snapshot_block, so a second run's one live signer is only 50% of the
 * tallied stake and on-chain verify fails closed. SNAPSHOT_BLOCK is therefore
 * derived per-run (override via ANCHOR_ACCEPTANCE_SNAPSHOT_BLOCK for a
 * deliberate replay).
 ********************************************************************/

'use strict';

const { installHooks } = require('./anchor_acceptance.test/support/hooks');
const at1 = require('./anchor_acceptance.test/01_at1_bundle.test');
const at4 = require('./anchor_acceptance.test/02_at4_read_back.test');

describe('ANCHOR live acceptance: DOGE regtest on-chain pipeline', function () {
    this.timeout(15 * 60 * 1000);

    installHooks();
    at1.register();
    at4.register();
});
