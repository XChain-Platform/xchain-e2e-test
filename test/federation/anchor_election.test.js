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
 * E2E: ANCHOR v0 BUNDLE election on a LIVE DOGE regtest chain.
 *
 * The multi-validator paths the single-validator mainnet deployment never
 * exercises: four hubs over REAL P2P (Ed25519-verified gossip, per-hub
 * MariaDB), each with its OWN funded regtest DOGE wallet, electing ONE
 * publisher per NETWORK per cycle and publishing REAL two-phase P2SH
 * transactions.
 *
 * The bundle shape (anchor-bundle-per-network.md): every chain's newest
 * un-anchored checkpoint rides ONE ANCHOR v0 as a section, under ONE election
 * keyed `XANCV7|NETWORK|SNAPSHOT_BLOCK` (the internal round-id tag does not
 * follow the wire's version byte), with ONE `anchor_bundle` reward. A
 * per-checkpoint-row election would mean three pending chains, three
 * elections, three transactions, three attestation rounds and three
 * `anchor_<CHAIN>` rewards split across whichever validators won each key.
 * The cardinality IS the property under test, so every assert here counts
 * bundles and sections rather than rows.
 *
 * Verified:
 *
 *   1. AT1 (federation form): one flush across four hubs lands exactly ONE v0
 *      carrying all three chains as sections, chain-ascending, published by the
 *      bundle key's rank-0 validator and paid from that validator's own wallet;
 *      exactly one `anchor_bundle` reward at round_reference = SNAPSHOT_BLOCK;
 *      XANC_BUNDLE_DONE back-fills the SAME txid onto every section row on
 *      every hub; a second flush publishes nothing.
 *   2. AT3 (missing chain): a chain whose newest eligible checkpoint is already
 *      anchored is simply ABSENT from the next bundle and never delays it (a short
 *      bundle is the NORMAL daily case, not an anomaly), and it rejoins
 *      at its newer seq once it cuts one.
 *   3. AT5 (failover race): ranks above 0 stay locked inside the tolerance
 *      window; rank 1 takes over after it elapses; a returning rank 0 that
 *      MISSED the announcement adopts the mined bundle through per-section
 *      `getanchoraction` (findExistingBundle) instead of spending a second
 *      time, and both hubs rebuild byte-identical bundle payloads.
 *   4. Archive round: the per-election-block leader collects
 *      2f+1 co-signatures, publishes ANCHOR v1 (the tail always appended), and XANC_FINALIZED back-fills every hub, with the `anchor_archive`
 *      reward on the leader.
 *
 * The oracle_publish capability set is stubbed (identical 4-validator snapshot
 * on every hub): resolving REAL on-chain BTC stakes into snapshots is
 * CapabilitySnapshot's own concern, covered by its units and the Tier-2
 * federation proof. Everything downstream of the set (election, gossip,
 * signing, broadcast, DB state) is live.
 *
 * Pre-requisites: same dogecoin-regtest stack + env as
 * anchorAcceptance.test.js (node, utxo-tracker, encoder, decoder,
 * indexer, regtest-miner; HUB_DB_* for the driver hub DBs).
 ********************************************************************/

'use strict';

const { installHooks } = require('./anchor_election.test/support/hooks');
const at1     = require('./anchor_election.test/01_at1_one_bundle.test');
const at3     = require('./anchor_election.test/02_at3_missing_chain.test');
const at5     = require('./anchor_election.test/03_at5_failover.test');
const archive = require('./anchor_election.test/04_archive_round.test');

describe('ANCHOR bundle live: multi-validator per-NETWORK publisher (DOGE regtest)', function () {
    this.timeout(20 * 60 * 1000);

    installHooks();
    at1.register();
    at3.register();
    at5.register();
    archive.register();
});
