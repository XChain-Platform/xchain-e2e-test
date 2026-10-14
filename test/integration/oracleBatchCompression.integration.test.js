'use strict';

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
 **********************************************************************
 * AT9 (compression), driven verbatim:
 *
 *   "a real six-round batch round-trips body -> deflate -> base64 -> parse ->
 *    identical body with the ratio RECORDED; a ratio/size breach is rejected
 *    identically on two nodes and never absorbed; non-canonical base64
 *    rejected; a batch that deflates larger publishes uncompressed"
 *
 * FOUR CLAUSES, FOUR RUNGS. Compression is the only part of PRICE v0 where the
 * bytes a node reads are not the bytes on the wire, and section 4a makes every
 * bound on that translation CONSENSUS rather than presentational. So the whole
 * of AT9 is one question asked four ways: can two nodes disagree about what a
 * compressed wire means? A ratio cap that one node enforces and another absorbs,
 * a base64 spelling one node normalizes and another refuses, a form the emitter
 * picks non-deterministically: each of those is a fork, not a nuisance.
 *
 * WHAT IS REAL HERE. Six real PBFT price rounds on four in-process validators
 * with a real peer mesh; a real OracleBatchSigner round; the real OraclePublisher
 * packer, emit-smaller decision and wire builder; a real encoder build, signature
 * and broadcast on DOGE regtest; real blocks; and TWO whole XChain nodes (a live
 * one standing before the publish and an isolated one built from nothing
 * afterwards) each reaching its own verdict from the chain alone. The
 * compression module under test is the INDEXER's own copy, reached through
 * `oracleBatchDrive.priceBatch`, so a payload this drill calls illegal is a
 * payload the landing chain calls illegal.
 *
 * NOTHING IS A FIXTURE. Clause 1's body is the body the federation actually
 * signed and published; it is never hand-written here. The hostile wires are
 * built by the publisher's OWN `buildPriceBatchBody` over ghost round numbers,
 * so they are well-formed batch bodies that differ from an honest one only in
 * the one property each clause is about.
 *
 * WHY GHOST ROUNDS. "Never absorbed" is only a claim if there is something that
 * COULD have been absorbed. The breach and the non-canonical wires therefore
 * carry round numbers this run has never finalized (roundBase + GHOST_OFFSET),
 * so their absence from `price_snapshots` on both nodes is evidence rather than
 * a tautology: had either node relaxed a bound, those rounds would be sitting in
 * the table.
 *
 * WHY TWO NODES. Section 4a's bounds are consensus, and a consensus rule
 * demonstrated on one node is a rule demonstrated on nobody. The live node was
 * running before the hostile wires were broadcast and saw them arrive as new
 * blocks; the replay node was built from an empty database afterwards and
 * reached the same block by reading the chain. Same wire, two independent
 * decisions, compared on the recorded status string.
 *
 * A MEASURED LIMIT OF CLAUSE 4, stated because it shapes the test. A
 * STRUCTURALLY LEGAL PRICE batch body can never deflate larger than itself:
 * every free-form field in the wire is drawn from a small alphabet (pair names
 * [A-Z]{3,N}/[A-Z]{3,5}, prices decimal, pubkeys and signatures hex), so the
 * densest legal body still deflates to roughly 0.75 of its length and base64's
 * 4/3 expansion cannot undo that. Measured across every shape a real federation
 * can emit, from a one-round one-pair one-signature body up, the packed form
 * always won. The emit-smaller branch is therefore exercised the only way it can
 * be exercised honestly: `emitWire` (the real publisher's real decision) is
 * driven with an incompressible body and asserted to return the uncompressed
 * form, and the UNCOMPRESSED WIRE FORM is separately proven to be a first-class
 * citizen on the chain by broadcasting the honest batch's own plain twin and
 * showing the landing chain stores the identical batch from it.
 *
 * VENUE RACE. One DOGE regtest stack, one fixed-port disposable MariaDB. Run
 * this drill serially against that venue, never beside another oracle drill.
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { STEPS, teardown } = require('./oracleBatchCompression.integration.test/helpers/setup');
const { printEvidence } = require('./oracleBatchCompression.integration.test/helpers/evidence');

describe('AT9 PRICE batch compression: round trip, consensus caps, canonical base64, emit-smaller (L3)', function () {
    // Two whole nodes, a full chain replay, a live publish rail and six
    // transactions. The budget is per-suite; every wait inside is a poll.
    this.timeout(90 * 60 * 1000);

    // The drill's shared state. Setup fills it, the parts read it.
    const S = {
        hubDb: null, liveNode: null, replayNode: null, venue: null,
        pinned: null, signerSet: null, conn: null,
        rounds: [], targetHeight: null, publicationCount: 0, railState: '',
        liveRows: {}, replayRows: {},
        liveGhostSnaps: [], replayGhostSnaps: [], replayGhostMirror: [], liveGhostActions: [],
    };

    before(async function () {
        // Started here, once, and shared with everything below. The venue's own
        // startDisposableHubDb call resolves this same handle out of the
        // environment and returns a no-op stop(), so tearing the federation down
        // cannot take the replay node's database server with it.
        S.hubDb = await startDisposableHubDb();
        if (!S.hubDb) {
            console.log('AT9 unavailable: no env hub DB and Docker unavailable');
            this.skip();
            return;
        }
        for (const step of STEPS) {
            if (!(await step(S))) { this.skip(); return; }
        }
        printEvidence(S);
    });

    after(async function () {
        await teardown(S);
    });

    require('./oracleBatchCompression.integration.test/01_a_real_six_round_batch_round_trips_with_the_ratio_recorded.test')(S);
    require('./oracleBatchCompression.integration.test/02_a_ratio_or_size_breach_is_rejected_identically_and_never_absorbed.test')(S);
    require('./oracleBatchCompression.integration.test/03_non_canonical_base64_is_rejected_not_silently_normalized.test')(S);
    require('./oracleBatchCompression.integration.test/04_a_batch_that_deflates_larger_publishes_uncompressed.test')(S);
});
