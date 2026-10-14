/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

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

// The one mutable record the helpers and the tests share. Venue-wide members are
// booted once by the suite hooks; per-federation members are rebuilt by
// bootFederation() and torn down by stopFederation().
const S = {
    hubDb: null, SAP: null, SCE: null,
    publisherAddr: null, signerDir: null, signerHooks: null,
    mvh: null, weightSeed: null, fault: null,
    identities: [], pubkeys: [],
    broadcasts: [],               // { hub, payload, txid, phase1_txid }
    // XANCARCHPUB_SIGN_REQ envelopes each hub saw on the wire, by hub index. Counted
    // ABOVE the injected handler (on handleMessage), so a degraded cycle still
    // observes the request arriving even though the response is silenced - which is
    // what tells a degraded ROUND apart from a round that never ran.
    archiveSignReqSeen: [],
    snapshotBlock: 0,
    federationCount: 0
};

module.exports = { S, N, HUB_DB_PORT, HUB_DB_NAME, SNAPSHOT_BLOCK_BASE, ROUND_TIMEOUT_MS, sleep };
