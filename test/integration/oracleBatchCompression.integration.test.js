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
 * be exercised honestly: `_emitWire` (the real publisher's real decision) is
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

const assert  = require('assert');
const crypto  = require('crypto');
const mariadb = require('mariadb');

const { OracleBatchVenue }      = require('../helpers/oracleBatchVenue');
const { startDisposableHubDb }  = require('../helpers/disposableHubDb');
const { OracleBatchReplayNode } = require('../helpers/oracleBatchReplay');
const { waitFor }               = require('../helpers/consensusWait');
const drive                     = require('../helpers/oracleBatchDrive');

// The consensus compression module, as the landing chain runs it.
const priceBatch = drive.priceBatch;

// ---------------------------------------------------------------------------
// The run's numbers
// ---------------------------------------------------------------------------

// "a real six-round batch" is AT9's own wording, so the window stays at six.
const WINDOW_ROUNDS = 6;
// Four validators gives a weighted quorum of three, so a signing round that
// reaches quorum has persuaded peers rather than counted itself.
const VALIDATORS    = 4;
const MIN_SIGNATURES = 3;

// Seconds, not the shipped five minutes: six rounds driven back to back
// in-process have no stragglers for the grace to wait for.
const GRACE_MS = 4000;

// The price-sync grace BOTH nodes run at, in seconds. At the frozen 4800 a node
// reading a freshly published block defers it until its wall clock is 80 minutes
// past that block's time, which no drill budget survives. 600 is the value the
// platform ran on until this spec moved it, so the barrier is real rather than
// switched off, and it is applied IDENTICALLY to both nodes, which is what keeps
// the two-node comparison sound. Exercising the barrier at 4800 is AT5's job.
const PRICE_GRACE_S = 600;

// How far above the run's real rounds the hostile wires' round numbers sit. Big
// enough that no rerun's seconds-since-epoch base can ever reach it, so a ghost
// round found in `price_snapshots` came from THIS drill's hostile wire and from
// nowhere else.
const GHOST_OFFSET = 5_000_000;

// Filler appended to a ghost body to push its inflated size past the caps. Any
// highly compressible run does; the exact length is searched for at runtime
// against the consensus module rather than hard-coded, so a change in zlib's
// output cannot silently turn the breach into a legal payload.
const BREACH_FILLER_CHAR = 'A';

// Budgets. Every one is a poll that returns the moment its condition holds.
const CONFIRM_WAIT_MS  = 300_000;   // one broadcast wire reaching a block
const PRICE_ROW_WAIT_MS = 180_000;  // a node writing its verdict for that wire
const SETTLE_MS         = 15_000;   // the push outbox delivering post-commit

// The one verdict a well-formed PRICE can legitimately record on a non-BTC
// indexer while the price-capability rung is still settling. AT9 is a claim
// about wire FORM, not about signer resolution, so the honest batch's clauses
// tolerate this verdict and say so out loud rather than failing on it.
const KNOWN_CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// The exact status a non-canonical base64 spelling must record, from the module
// that produces it. Never spelled out as a literal here: these strings reach the
// chain inside the action's recorded status, so the module owns them.
const STATUS_BASE64 = 'invalid: COMPRESSION (' +
    priceBatch.PRICE_BATCH_COMPRESSION_FAIL_REASONS.BASE64 + ')';
const REASON_RATIO  = priceBatch.PRICE_BATCH_COMPRESSION_FAIL_REASONS.RATIO_CAP;
const REASON_SIZE   = priceBatch.PRICE_BATCH_COMPRESSION_FAIL_REASONS.SIZE_CAP;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// ---------------------------------------------------------------------------
// Reading a PRICE v0 wire
//
// HELPER GAP, worked around here rather than fixed in the helper (this drill is
// jailed to one file): `oracleBatchDrive.parsePriceBatchWire` still refuses any
// wire whose version field is not `2`, and the v0 collapse (spec preamble,
// 2026-08-26) made the publisher emit `PRICE|0|`. Every wire this drill touches
// would come back `{ok:false, reason:'not-version-2'}`. The splitter below is
// the same reader with the version pinned at 0; it deliberately inflates through
// the CONSENSUS module, not through zlib, so a wire this drill can read is a
// wire the chain can read.
// ---------------------------------------------------------------------------

const BATCH_WIRE_VERSION = 0;

function splitWire(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== BATCH_WIRE_VERSION) return { ok: false, reason: 'not-a-batch-version', version: version };

    if (parts[2] === priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Rejoining fields 3+ is required, not cosmetic: canonical base64 carries
        // no `|`, but a hostile wire may, and rejoining is what makes this reader
        // see the field the indexer's `params[2]` sees for every honest wire.
        const field    = parts.slice(3).join('|');
        const inflated = priceBatch.inflatePriceBatchBody(field);
        if (!inflated.ok) {
            return { ok: false, compressed: true, field: field,
                     reason: inflated.reason, status: inflated.status };
        }
        return {
            ok: true, compressed: true, field: field, body: inflated.body,
            bodyBytes:       inflated.inflatedBytes,
            compressedBytes: inflated.compressedBytes,
            ratio:           inflated.ratio,
            wireBytes:       Buffer.byteLength(String(wire), 'utf8')
        };
    }
    const body = parts.slice(2).join('|');
    return {
        ok: true, compressed: false, field: null, body: body,
        bodyBytes:       Buffer.byteLength(body, 'utf8'),
        compressedBytes: null, ratio: null,
        wireBytes:       Buffer.byteLength(String(wire), 'utf8')
    };
}

// Field order is `actions/price.js:_parseV0`'s, read out of the same body the
// parser reads: FIRST_ROUND, LAST_ROUND, BTC_BLOCK_HEIGHT, ROUND_COUNT, then
// ROUND/TIMESTAMP/ANCHOR_HEIGHT/PAIR_COUNT + pairs per round, then the sig set.
function splitBody(body) {
    const f = String(body).split('|');
    let i = 0;
    const firstRound = parseInt(f[i++], 10);
    const lastRound  = parseInt(f[i++], 10);
    const anchor     = parseInt(f[i++], 10);
    const roundCount = parseInt(f[i++], 10);
    const rounds = [];
    for (let r = 0; r < roundCount; r++) {
        const round     = parseInt(f[i++], 10);
        const timestamp = parseInt(f[i++], 10);
        const rAnchor   = parseInt(f[i++], 10);
        const pairCount = parseInt(f[i++], 10);
        const pairs = [];
        for (let p = 0; p < pairCount; p++) pairs.push({ pair: f[i++], price: f[i++] });
        rounds.push({ round: round, timestamp: timestamp, btcBlockHeight: rAnchor, pairs: pairs });
    }
    const sigCount = parseInt(f[i++], 10);
    const sigs = [];
    for (let s = 0; s < sigCount; s++) {
        sigs.push({ pubkey: String(f[i++]).toLowerCase(), sig: String(f[i++]).toLowerCase() });
    }
    return { firstRound, lastRound, anchor, roundCount, rounds, sigs };
}

// ---------------------------------------------------------------------------
// Crafting the hostile payloads
// ---------------------------------------------------------------------------

// A high-entropy string over printable ASCII with `|` removed, for the
// incompressible body of clause 4. 93 symbols is 6.54 bits per character, which
// deflate cannot shrink below about 0.82 of the input; base64's 4/3 expansion
// then puts the packed form comfortably above the plain one. Drawn from
// crypto.randomBytes so the incompressibility is a property of the data and not
// of a seed this file chose.
function entropyString(n) {
    const alphabet = [];
    for (let c = 33; c < 127; c++) if (c !== 0x7C) alphabet.push(String.fromCharCode(c));
    const raw = crypto.randomBytes(n);
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[raw[i] % alphabet.length];
    return out;
}

/**
 * Grow a compressible filler onto `body` until the consensus module rejects the
 * compressed field for the intended reason.
 *
 * SEARCHED, NOT ASSUMED. Which of the two caps binds is a function of the
 * deflated length alone (`outputCap = min(PRICE_WIRE_MAX_BYTES, compressed*150)`),
 * so a hard-coded filler length would silently stop breaching the day zlib's
 * output moved by a few bytes and the drill would go green on a payload that is
 * merely legal. The module itself is the oracle here.
 */
function craftBreach(body, wantReason) {
    const tried = [];
    for (const fill of [7_000, 12_000, 20_000, 35_000, 60_000, 120_000, 240_000]) {
        const padded = body + BREACH_FILLER_CHAR.repeat(fill);
        const field  = priceBatch.compressPriceBatchBody(padded);
        if (field.length > priceBatch.PRICE_WIRE_MAX_BYTES) continue;
        const verdict = priceBatch.inflatePriceBatchBody(field);
        tried.push(fill + ':' + (verdict.ok ? 'accepted' : verdict.reason));
        if (!verdict.ok && verdict.reason === wantReason) {
            return { field: field, status: verdict.status, reason: verdict.reason,
                     fill: fill, inflatedBody: padded };
        }
    }
    throw new Error('AT9 could not craft a "' + wantReason + '" breach from this body; ' +
        'filler lengths tried were [' + tried.join(', ') + ']. The caps in ' +
        'price_batch_compression.js moved, or zlib\'s output did.');
}

// The three non-canonical spellings section 4a names, each produced from the
// SAME canonical field so all three decode (under a lenient reader) to exactly
// the same bytes. That identity is the point: it is what makes "silently
// normalized" a thing that could happen rather than a thing that could not.
function spellWithWhitespace(field) {
    const at = Math.floor(field.length / 2);
    return field.slice(0, at) + ' ' + field.slice(at);
}

function spellUrlSafe(field) {
    if (!/[+/]/.test(field)) return null;
    return field.replace(/\+/g, '-').replace(/\//g, '_');
}

// The padding game that a length check and an alphabet check both MISS: the
// final quantum's unused low bits. With one `=` the last data character carries
// four significant bits and two unused; with two, two significant and four
// unused. Either way bit 0 is unused, so flipping it leaves the decoded bytes
// identical and only the re-encode round trip in `decodeCanonicalBase64` can
// tell the two spellings apart. `QR==` and `QQ==` are the textbook pair.
function spellUnusedBits(field) {
    const pads = (field.match(/=+$/) || [''])[0].length;
    if (pads === 0) return null;
    const at = field.length - pads - 1;
    const v  = B64_ALPHABET.indexOf(field[at]);
    if (v < 0) return null;
    return field.slice(0, at) + B64_ALPHABET[v ^ 1] + field.slice(at + 1);
}

/**
 * A canonical compressed field whose spelling can carry all three mutations.
 *
 * The URL-safe mutation needs a `+` or a `/` to replace and the padding
 * mutation needs a pad character, neither of which deflate is obliged to
 * produce. A trailing field is appended to the body until both appear; the
 * parser reads its fields positionally and stops after the signature set, so a
 * trailing field leaves the batch body it is appended to well-formed.
 */
function craftMutableField(body) {
    for (let k = 0; k <= 400; k++) {
        const padded = k === 0 ? body : (body + '|' + 'X'.repeat(k));
        const field  = priceBatch.compressPriceBatchBody(padded);
        if (/[+/]/.test(field) && /=$/.test(field)) return { field: field, body: padded, filler: k };
    }
    throw new Error('AT9 could not produce a compressed field carrying both a non-standard ' +
        'alphabet character and a pad character in 400 attempts');
}

// ---------------------------------------------------------------------------
// Reading a node's verdict for one transaction
// ---------------------------------------------------------------------------

function plain(rows) {
    return JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

function ident(name) {
    if (!/^[A-Za-z0-9_]+$/.test(String(name))) throw new Error('AT9: unusable database name');
    return String(name);
}

/**
 * The `prices` row a node wrote for a broadcast transaction, with the batch
 * columns AT9 needs.
 *
 * HELPER GAP, worked around here: `oracleBatchReplay.readPriceActions` selects
 * neither the four v2 batch columns nor the transaction hash, and filters only
 * by round or block. A wire rejected at decompression never records a round
 * number at all (`_parseV0` sets `data['ROUND']` from an undefined
 * `firstRound`), so a round filter cannot find the rows this drill is about.
 * Keyed on the transaction hash through the same join `indexerWait.js` uses.
 */
async function readPriceRowByTx(conn, dbName, txid) {
    const db = ident(dbName);
    const rows = await conn.query(
        'SELECT p.action_index, p.version, p.round_number, p.batch_first_round, p.batch_last_round, ' +
        'p.round_count, p.rounds_json, p.sigs_json, p.validation_status, s.status, ' +
        'a.block_index, a.tx_index, a.tx_vout ' +
        'FROM `' + db + '`.prices p ' +
        'JOIN `' + db + '`.actions a ON a.action_index = p.action_index ' +
        'JOIN `' + db + '`.transactions tr ON tr.tx_index = a.tx_index ' +
        'JOIN `' + db + '`.index_transactions itx ON itx.id = tr.tx_hash_id ' +
        'LEFT JOIN `' + db + '`.index_statuses s ON s.id = p.status_id ' +
        'WHERE itx.hash = ?', [txid]);
    return plain(rows);
}

// The verdict a node recorded for one transaction, for an evidence line. Reads
// "(no row)" rather than throwing: the evidence block runs before any assertion
// and its job is to describe a failed run, not to become one.
function statusOf(rows, txid) {
    const row = rows[txid];
    return row ? String(row.status) : '(no row)';
}

async function waitForPriceRow(conn, dbName, txid, label) {
    const result = await waitFor(async () => {
        let rows = [];
        try { rows = await readPriceRowByTx(conn, dbName, txid); } catch (_) { rows = []; }
        return { ok: rows.length > 0, rows: rows };
    }, { timeoutMs: PRICE_ROW_WAIT_MS, intervalMs: 2000 });
    if (!result.ok) {
        throw new Error('AT9: the ' + label + ' node never wrote a prices row for tx ' + txid +
            ' within ' + result.waitedMs + 'ms. The decoder did not resolve the wire as a PRICE ' +
            'action, or the block loop has not reached it.');
    }
    return result.last.rows[0];
}

// ---------------------------------------------------------------------------

describe('AT9 PRICE batch compression: round trip, consensus caps, canonical base64, emit-smaller (L3)', function () {
    // Two whole nodes, a full chain replay, a live publish rail and six
    // transactions. The budget is per-suite; every wait inside is a poll.
    this.timeout(90 * 60 * 1000);

    let hubDb = null, liveNode = null, replayNode = null, venue = null;
    let pinned = null, signerSet = null, conn = null;

    let rounds = [];                 // what the federation finalized
    let landedWire = null;           // the wire the publisher actually broadcast
    let landedTxid = null;
    let parsedWire = null;           // splitWire(landedWire)
    let parsedBody = null;           // splitBody(parsedWire.body)
    let rebuiltBody = null;          // the publisher's own builder, re-run on the parsed content
    let reField = null, reInflated = null;   // the explicit deflate/base64/parse round trip

    let emitReal = null, emitEntropy = null; // the publisher's emit-smaller decision, both ways
    let entropyPlainBytes = null, entropyPackedBytes = null;

    let ghost = null;                // { body, rounds, first, last, anchor }
    let breachSize = null, breachRatio = null;   // { field, status, reason, wire, txid, height }
    let spellings = [];              // [{ name, field, wire, txid, height }]
    let plainTwin = null;            // { wire, txid, height }

    let targetHeight = null;
    let publicationCount = 0;
    let railState = '';
    let liveRows = {}, replayRows = {};          // txid -> prices row
    let liveGhostSnaps = [], replayGhostSnaps = [], replayGhostMirror = [], liveGhostActions = [];

    // One wire onto the chain the venue is pointed at, then block until a real
    // block carries it. Serialized on purpose: the venue funds ONE publisher
    // address, so two in-flight builds would select the same outputs, and a
    // second build before the first confirms would spend unconfirmed change.
    async function land(wire, label) {
        const sent = await drive.broadcastWire(venue, wire);
        const mined = await waitFor(async () => {
            let block = null;
            try { block = await venue.blockOf(sent.txid); } catch (_) { block = null; }
            return { ok: block !== null && Number.isFinite(Number(block.height)), block: block };
        }, { timeoutMs: CONFIRM_WAIT_MS, intervalMs: 2000 });
        if (!mined.ok) {
            throw new Error('AT9: the ' + label + ' wire (tx ' + sent.txid + ', ' + sent.wireBytes +
                ' bytes) was broadcast but never reached a block within ' + mined.waitedMs +
                'ms on the ' + venue.rail.code + ' regtest chain.');
        }
        const height = Number(mined.last.block.height);
        if (targetHeight === null || height > targetHeight) targetHeight = height;
        return { label: label, wire: wire, wireBytes: sent.wireBytes, txid: sent.txid, height: height };
    }

    before(async function () {
        // Started here, once, and shared with everything below. The venue's own
        // startDisposableHubDb call resolves this same handle out of the
        // environment and returns a no-op stop(), so tearing the federation down
        // cannot take the replay node's database server with it.
        hubDb = await startDisposableHubDb();
        if (!hubDb) {
            console.log('AT9 unavailable: no env hub DB and Docker unavailable');
            this.skip();
            return;
        }

        const bail = async (why) => {
            console.log('AT9 unavailable: ' + why);
            if (signerSet) { try { signerSet.stop(); } catch (_) {} signerSet = null; }
            if (venue)      { await venue.down();      venue = null; }
            if (replayNode) { await replayNode.down(); replayNode = null; }
            if (liveNode)   { await liveNode.down();   liveNode = null; }
            if (pinned)     { pinned.restore();        pinned = null; }
            if (conn)       { try { await conn.end(); } catch (_) {} conn = null; }
            if (hubDb)      { await hubDb.stop();      hubDb = null; }
        };

        // --- 1. the live node, caught up BEFORE anything is published ---------
        liveNode = new OracleBatchReplayNode({
            label: 'live', hubDb: hubDb, basePort: 61000, priceGraceS: PRICE_GRACE_S });
        let up = false;
        try { up = await liveNode.up(); }
        catch (err) { await bail('live node failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!up) { await bail(liveNode.unavailable); this.skip(); return; }

        const tipBefore = (await liveNode.decoderHeight()).height;
        console.log('  AT9: live node built; catching up to chain block ' + tipBefore + '...');
        await liveNode.waitForHeight(tipBefore);

        // --- 2. the federation publishes a REAL six-round batch ---------------
        pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });
        venue = new OracleBatchVenue({
            coin: 'dogecoin', network: 'regtest',
            validatorCount: VALIDATORS,
            basePort: 33900,
            roundBase: drive.alignedRoundBase(WINDOW_ROUNDS),
            expectWireVersion: BATCH_WIRE_VERSION
        });

        let venueUp = false;
        try { venueUp = await venue.up(); }
        catch (err) { await bail('publish venue failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!venueUp) { await bail(venue.unavailable); this.skip(); return; }

        // Keep the batch BUFFER out of the checkout. OraclePublisher derives
        // bufferPath from queuePath in its CONSTRUCTOR and the venue redirects
        // queuePath afterwards, so the redirect never reaches the buffer: the rail
        // would write `<cwd>/data/publisher-queue.buffer.jsonl` into the working
        // tree and RELOAD a previous run's rounds into this one, where they would
        // fail their signing round.
        for (const pub of venue.publishers) {
            if (pub.queuePath) pub.bufferPath = String(pub.queuePath).replace(/\.jsonl$/, '') + '.buffer.jsonl';
            if (pub._buffer && typeof pub._buffer.clear === 'function') pub._buffer.clear();
        }

        // Every hub, not just the leader: OraclePublisher builds its signer lazily
        // and only the leader reaches that code, so without this no follower has
        // registered the XPRICEB handler and the round expires at 1/3 sigs.
        signerSet = drive.attachBatchSigners(venue);

        rounds = await drive.finalizeRoundsNoWait(venue, WINDOW_ROUNDS);
        const settle = await drive.waitForPublications(venue, { min: 1, quietMs: 20_000, timeoutMs: 300_000 });
        railState = drive.railDiagnosis(venue, signerSet);

        if (!settle.reached || venue.publications.length === 0) {
            await bail('the window never produced a wire.' + railState);
            this.skip();
            return;
        }

        publicationCount = venue.publications.length;
        landedWire = venue.publications[0].wire;
        landedTxid = venue.publications[0].txid;
        parsedWire = splitWire(landedWire);
        if (!parsedWire.ok) {
            await bail('the published wire does not read as a PRICE batch: ' +
                (parsedWire.reason || '?') + railState);
            this.skip();
            return;
        }
        parsedBody = splitBody(parsedWire.body);

        // The publisher's OWN builder, re-run over the content the wire carried.
        // Re-deriving the body in this file instead would compare the test to
        // itself; running the real builder is what makes "identical body" a claim
        // about the producer.
        rebuiltBody = venue.publishers[0].buildPriceBatchBody(
            parsedBody.firstRound, parsedBody.lastRound, parsedBody.anchor,
            parsedBody.rounds, parsedBody.sigs);

        // The literal round trip AT9 names: body -> deflate -> base64 -> parse ->
        // body, through the consensus module in both directions.
        reField    = priceBatch.compressPriceBatchBody(parsedWire.body);
        reInflated = priceBatch.inflatePriceBatchBody(reField);

        // --- 3. the emit-smaller decision, driven both ways -------------------
        // The real publisher's real method. Called on the venue's own instance
        // rather than on a fresh one, so the decision measured is the decision the
        // rail makes.
        emitReal = venue.publishers[0]._emitWire(
            parsedBody.firstRound, parsedBody.lastRound, parsedBody.anchor,
            parsedBody.rounds, parsedBody.sigs);

        // The same batch shape with incompressible content. Pair names and prices
        // are replaced with high-entropy strings; the ROUND/ANCHOR arithmetic is
        // left honest so `buildPriceBatchBody`'s anchor derivation still passes and
        // the body it produces is a real batch body in every structural respect.
        const entropyRounds = parsedBody.rounds.map((r) => ({
            round:          r.round,
            timestamp:      r.timestamp,
            btcBlockHeight: r.btcBlockHeight,
            // 32 and 64 characters rather than a realistic pair name's length, and
            // the reason is arithmetic. The body's numeric header (round numbers,
            // timestamps, anchors, counts) is ordinary compressible text, so it
            // works AGAINST the claim; the entropy has to outweigh it by roughly
            // 3.6 to 1 before the packed form loses. Measured at these lengths the
            // packed wire runs about 5% above the plain one, with the entropy
            // portion at ~1,900 B against ~150 B of header.
            pairs:          r.pairs.map(() => ({ coinPair: entropyString(32), price: entropyString(64) }))
        }));
        const entropySigs = parsedBody.sigs.map(() => ({ pubkey: entropyString(64), sig: entropyString(128) }));
        emitEntropy = venue.publishers[0]._emitWire(
            parsedBody.firstRound, parsedBody.lastRound, parsedBody.anchor, entropyRounds, entropySigs);
        const entropyBody = venue.publishers[0].buildPriceBatchBody(
            parsedBody.firstRound, parsedBody.lastRound, parsedBody.anchor, entropyRounds, entropySigs);
        entropyPlainBytes  = Buffer.byteLength('PRICE|' + BATCH_WIRE_VERSION + '|' + entropyBody, 'utf8');
        entropyPackedBytes = Buffer.byteLength('PRICE|' + BATCH_WIRE_VERSION + '|' +
            priceBatch.PRICE_BATCH_COMPRESSION_MARKER + '|' +
            priceBatch.compressPriceBatchBody(entropyBody), 'utf8');

        // --- 4. the hostile wires -------------------------------------------
        // A well-formed batch body over rounds this run has never finalized, built
        // by the publisher's own builder so it differs from an honest body in
        // nothing but its round numbers.
        const ghostRounds = parsedBody.rounds.map((r, i) => ({
            round:          venue.roundBase + GHOST_OFFSET + i,
            timestamp:      r.timestamp,
            btcBlockHeight: r.btcBlockHeight,
            pairs:          r.pairs.map((p) => ({ coinPair: p.pair, price: p.price }))
        }));
        ghost = {
            rounds: ghostRounds.map((r) => r.round),
            first:  ghostRounds[0].round,
            last:   ghostRounds[ghostRounds.length - 1].round,
            anchor: ghostRounds[ghostRounds.length - 1].btcBlockHeight
        };
        ghost.body = venue.publishers[0].buildPriceBatchBody(
            ghost.first, ghost.last, ghost.anchor, ghostRounds, parsedBody.sigs);

        breachSize  = craftBreach(ghost.body, REASON_SIZE);
        // A ratio breach needs the deflated field under 55 bytes
        // (`ratioCap = compressed * 150` must fall at or below the 8189 size cap
        // for the RATIO reason to bind), which no body carrying real round data can
        // reach. The ratio case is therefore what it is in the wild: a pure bomb,
        // a payload that is nothing but compression.
        breachRatio = craftBreach('', REASON_RATIO);

        const mutable = craftMutableField(ghost.body);
        const spellingDefs = [
            { name: 'embedded whitespace', field: spellWithWhitespace(mutable.field) },
            { name: 'URL-safe alphabet',   field: spellUrlSafe(mutable.field) },
            { name: 'unused padding bits', field: spellUnusedBits(mutable.field) }
        ];
        for (const s of spellingDefs) {
            if (s.field === null) {
                await bail('could not produce the "' + s.name + '" spelling from the compressed field');
                this.skip();
                return;
            }
        }
        spellings = spellingDefs.map((s) => ({
            name: s.name,
            field: s.field,
            canonicalField: mutable.field,
            // What a LENIENT reader would make of this spelling. Captured before
            // anything is broadcast, because "not silently normalized" is only a
            // claim about spellings a lenient reader really does normalize.
            lenientDecodesSame: Buffer.from(s.field, 'base64')
                .equals(Buffer.from(mutable.field, 'base64')),
            strictRejects: priceBatch.decodeCanonicalBase64(s.field) === null
        }));

        // --- 5. onto the chain, one at a time --------------------------------
        const marker = priceBatch.PRICE_BATCH_COMPRESSION_MARKER;
        breachSize.landed  = await land('PRICE|' + BATCH_WIRE_VERSION + '|' + marker + '|' + breachSize.field,  'size-cap breach');
        breachRatio.landed = await land('PRICE|' + BATCH_WIRE_VERSION + '|' + marker + '|' + breachRatio.field, 'ratio-cap breach');
        for (const s of spellings) {
            s.landed = await land('PRICE|' + BATCH_WIRE_VERSION + '|' + marker + '|' + s.field, s.name);
        }
        // The honest batch's own plain twin: the SAME signed body in the other
        // wire form. This is what makes "publishes uncompressed" a statement about
        // the chain and not only about the emitter.
        plainTwin = await land('PRICE|' + BATCH_WIRE_VERSION + '|' + parsedWire.body, 'uncompressed twin');

        const landedBlock = await venue.blockOf(landedTxid);
        if (landedBlock && Number(landedBlock.height) > targetHeight) targetHeight = Number(landedBlock.height);

        // --- 6. the live node absorbs them, then the federation goes away -----
        await liveNode.waitForHeight(targetHeight);
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        conn = await mariadb.createConnection({
            host: hubDb.host, port: parseInt(hubDb.port, 10),
            user: hubDb.user, password: hubDb.pass, connectTimeout: 10_000
        });

        const allTx = [landedTxid, breachSize.landed.txid, breachRatio.landed.txid,
                       plainTwin.txid].concat(spellings.map((s) => s.landed.txid));
        for (const txid of allTx) liveRows[txid] = await waitForPriceRow(conn, liveNode.indexerDbName, txid, 'live');
        liveGhostSnaps   = await liveNode.hubPriceSnapshots({ rounds: ghost.rounds });
        liveGhostActions = await liveNode.priceActions({ rounds: ghost.rounds });

        if (signerSet) { signerSet.stop(); signerSet = null; }
        await venue.down();
        venue = null;
        pinned.restore();
        pinned = null;

        // --- 7. the replay node, built from nothing, reads the same chain -----
        replayNode = new OracleBatchReplayNode({
            label: 'replay', hubDb: hubDb, basePort: 61100, priceGraceS: PRICE_GRACE_S });
        try { up = await replayNode.up(); }
        catch (err) { await bail('replay node failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!up) { await bail(replayNode.unavailable); this.skip(); return; }

        console.log('  AT9: replay node built; replaying the chain to block ' + targetHeight + '...');
        await replayNode.waitForHeight(targetHeight);
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        for (const txid of allTx) replayRows[txid] = await waitForPriceRow(conn, replayNode.indexerDbName, txid, 'replay');
        replayGhostSnaps  = await replayNode.hubPriceSnapshots({ rounds: ghost.rounds });
        replayGhostMirror = await replayNode.mirrorPriceSnapshots({ rounds: ghost.rounds });

        // --- 8. the run's evidence, printed once ------------------------------
        // A green tick with no numbers proves nothing to an operator reading CI,
        // and a red one with no numbers proves less. THE RATIO LINE IS PART OF
        // AT9's wording, not decoration.
        const uncompressedWireBytes = Buffer.byteLength('PRICE|' + BATCH_WIRE_VERSION + '|' + parsedWire.body, 'utf8');
        console.log('\n  --- AT9: what actually landed ---');
        console.log('  rounds driven         : ' + rounds.map((r) => r.round).join(', '));
        console.log('  publications          : ' + publicationCount + '  tx ' + landedTxid);
        console.log('  batch on the wire     : rounds [' + parsedBody.firstRound + '..' + parsedBody.lastRound +
            '] count ' + parsedBody.roundCount + '  pairs/round ' +
            parsedBody.rounds.map((r) => r.pairs.length).join('/') + '  sigs ' + parsedBody.sigs.length);
        console.log('  wire form             : ' + (parsedWire.compressed ? 'COMPRESSED' : 'uncompressed'));
        console.log('  COMPRESSION RATIO     : ' +
            (parsedWire.ratio === null ? 'n/a (uncompressed)' : parsedWire.ratio.toFixed(2) + ':1') +
            '   (body ' + parsedWire.bodyBytes + ' B -> deflate ' + parsedWire.compressedBytes +
            ' B -> base64 ' + (parsedWire.field ? parsedWire.field.length : 0) + ' B)');
        console.log('  wire bytes            : ' + parsedWire.wireBytes + ' compressed vs ' +
            uncompressedWireBytes + ' uncompressed, saving ' +
            (uncompressedWireBytes - parsedWire.wireBytes) + ' B against the ' +
            priceBatch.PRICE_WIRE_MAX_BYTES + ' B ceiling');
        console.log('  round trip            : rebuilt body ' +
            (rebuiltBody === parsedWire.body ? 'IDENTICAL' : 'DIVERGED') + ', re-inflated body ' +
            ((reInflated.ok && reInflated.body === parsedWire.body) ? 'IDENTICAL' : 'DIVERGED'));
        console.log('  emit-smaller (real)   : compressed=' + emitReal.compressed + '  ' + emitReal.bytes + ' B');
        console.log('  emit-smaller (entropy): compressed=' + emitEntropy.compressed + '  plain ' +
            entropyPlainBytes + ' B vs packed ' + entropyPackedBytes + ' B  -> emitted ' +
            emitEntropy.bytes + ' B');
        console.log('  ghost rounds          : ' + ghost.first + '..' + ghost.last +
            '  (never finalized; must never appear in price_snapshots)');
        console.log('  size-cap breach       : field ' + breachSize.field.length + ' B, body would be ' +
            breachSize.inflatedBody.length + ' B, expects "' + breachSize.status + '"');
        console.log('  ratio-cap breach      : field ' + breachRatio.field.length + ' B, body would be ' +
            breachRatio.inflatedBody.length + ' B, expects "' + breachRatio.status + '"');
        for (const s of spellings) {
            console.log('  base64 spelling       : ' + s.name + ' -> lenient decode same=' +
                s.lenientDecodesSame + ' strict rejects=' + s.strictRejects +
                '  live "' + statusOf(liveRows, s.landed.txid) + '"  replay "' +
                statusOf(replayRows, s.landed.txid) + '"');
        }
        console.log('  breach verdicts       : size  live "' + statusOf(liveRows, breachSize.landed.txid) +
            '"  replay "' + statusOf(replayRows, breachSize.landed.txid) + '"');
        console.log('                          ratio live "' + statusOf(liveRows, breachRatio.landed.txid) +
            '"  replay "' + statusOf(replayRows, breachRatio.landed.txid) + '"');
        console.log('  ghost snapshots       : live ' + liveGhostSnaps.length + ', replay ' +
            replayGhostSnaps.length + ', replay mirror ' + replayGhostMirror.length + ' (all must be 0)');
        console.log('  compressed batch      : live "' + statusOf(liveRows, landedTxid) +
            '"  replay "' + statusOf(replayRows, landedTxid) + '"');
        console.log('  uncompressed twin     : live "' + statusOf(liveRows, plainTwin.txid) +
            '"  replay "' + statusOf(replayRows, plainTwin.txid) + '"');
        console.log('  replay target block   : ' + targetHeight);
        console.log(railState);
        console.log('  ---------------------------------\n');
    });

    after(async function () {
        if (signerSet)  { try { signerSet.stop(); } catch (_) {} }
        if (venue)      await venue.down();
        if (pinned)     pinned.restore();
        if (conn)       { try { await conn.end(); } catch (_) {} }
        if (replayNode) await replayNode.down();
        if (liveNode)   await liveNode.down();
        if (hubDb)      await hubDb.stop();
    });

    // -----------------------------------------------------------------------
    // Clause 1: a REAL six-round batch round-trips, with the ratio recorded
    // -----------------------------------------------------------------------

    it('the federation finalized six real rounds and published them as ONE compressed batch', function () {
        assert.strictEqual(rounds.length, WINDOW_ROUNDS,
            'expected ' + WINDOW_ROUNDS + ' finalized rounds, got ' + rounds.length + railState);
        for (const r of rounds) {
            const distinct = new Set(r.signatures.map((s) => String(s.pubkey).toLowerCase()));
            assert.ok(distinct.size >= MIN_SIGNATURES,
                'CONSENSUS rung: round ' + r.round + ' finalized on only ' + distinct.size +
                ' distinct signer(s); nothing downstream of this can be read.' + railState);
        }
        assert.strictEqual(parsedBody.roundCount, WINDOW_ROUNDS,
            'AT9 requires a REAL six-round batch; the wire carries ' + parsedBody.roundCount + ' round(s)');
        assert.deepStrictEqual(parsedBody.rounds.map((r) => r.round), rounds.map((r) => r.round),
            'the batch covers rounds the federation did not finalize, so this is not a real batch');
        assert.ok(parsedWire.compressed,
            'AT9 clause 1 needs a COMPRESSED wire to round-trip and the publisher emitted the ' +
            'uncompressed form. At ' + parsedWire.bodyBytes + ' bytes of body over ' +
            parsedBody.rounds.length + ' rounds the packed form should have won; read the ' +
            'emit-smaller measurement in the run evidence above.');
    });

    it('body -> deflate -> base64 -> parse returns the IDENTICAL body, and the ratio is recorded', function () {
        // The wire the publisher emitted is itself strictly canonical base64.
        assert.notStrictEqual(priceBatch.decodeCanonicalBase64(parsedWire.field), null,
            'the publisher emitted a base64 field the consensus decoder refuses as non-canonical; ' +
            'the federation is paying a fee for a wire no node will read');

        // Leg one: the wire's own field inflates to a body the publisher's own
        // builder reproduces byte for byte from the parsed content.
        assert.strictEqual(rebuiltBody, parsedWire.body,
            'the inflated body is not what OraclePublisher.buildPriceBatchBody produces for the ' +
            'same content, so the wire and the signed canonical describe different batches');

        // Leg two: the explicit round trip AT9 names.
        assert.ok(reInflated.ok,
            're-compressing the landed body produced a field the consensus module refuses: ' +
            (reInflated.reason || '?'));
        assert.strictEqual(reInflated.body, parsedWire.body,
            'body -> deflate -> base64 -> parse did NOT return the identical body; ' +
            'inflation is the one direction consensus depends on being deterministic');
        assert.strictEqual(Buffer.byteLength(reInflated.body, 'utf8'), parsedWire.bodyBytes);

        // The ratio is a measurement, so it has to be a real number and it has to
        // be inside the consensus cap that judges every node's inflate.
        assert.ok(Number.isFinite(parsedWire.ratio) && parsedWire.ratio > 1,
            'no compression ratio was measured for the landed wire');
        assert.ok(parsedWire.ratio <= priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO,
            'the honest batch inflates at ' + parsedWire.ratio.toFixed(2) + ':1, past the consensus cap of ' +
            priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO + ':1; every node would refuse it');
        assert.ok(parsedWire.bodyBytes <= priceBatch.PRICE_WIRE_MAX_BYTES,
            'the inflated body is ' + parsedWire.bodyBytes + ' B, past the reader bound of ' +
            priceBatch.PRICE_WIRE_MAX_BYTES + ' B. Compression buys FEE, not round capacity: a ' +
            'compressed wire under the encoder limit whose BODY is over this one is a fee spent ' +
            'on an action no indexing node will finish inflating.');
        assert.ok(parsedWire.wireBytes <= priceBatch.PRICE_WIRE_MAX_BYTES,
            'the emitted wire is ' + parsedWire.wireBytes + ' B, past the encoder limit');
    });

    it('both nodes stored the compressed batch as the same six-round batch', function () {
        for (const [label, rows] of [['live', liveRows], ['replay', replayRows]]) {
            const row = rows[landedTxid];
            assert.ok(row, 'the ' + label + ' node wrote no prices row for the batch');
            assert.strictEqual(Number(row.version), BATCH_WIRE_VERSION,
                'PARSE rung: the ' + label + ' node recorded PRICE version ' + row.version + ' for a batch wire');
            assert.strictEqual(Number(row.batch_first_round), parsedBody.firstRound,
                'the ' + label + ' node stored batch_first_round ' + row.batch_first_round +
                ' for a wire whose FIRST_ROUND is ' + parsedBody.firstRound);
            assert.strictEqual(Number(row.batch_last_round), parsedBody.lastRound);
            assert.strictEqual(Number(row.round_count), WINDOW_ROUNDS,
                'the ' + label + ' node stored round_count ' + row.round_count);
            assert.strictEqual(Number(row.round_number), parsedBody.firstRound,
                'D21: a batch row carries FIRST_ROUND in round_number');
            const storedRounds = JSON.parse(row.rounds_json || '[]');
            assert.strictEqual(storedRounds.length, WINDOW_ROUNDS,
                'the ' + label + ' node stored ' + storedRounds.length + ' round(s) in rounds_json');
        }
        assert.strictEqual(liveRows[landedTxid].status, replayRows[landedTxid].status,
            'the two nodes disagree about the honest batch: live "' + liveRows[landedTxid].status +
            '" vs replay "' + replayRows[landedTxid].status + '". A compressed wire that means two ' +
            'things is a fork.');
    });

    // -----------------------------------------------------------------------
    // Clause 2: a ratio/size breach, rejected identically on two nodes,
    //           and never absorbed
    // -----------------------------------------------------------------------

    it('a SIZE-cap breach is rejected with the identical status on both nodes', function () {
        const txid = breachSize.landed.txid;
        assert.strictEqual(breachSize.reason, REASON_SIZE);
        const live = liveRows[txid], replay = replayRows[txid];
        assert.ok(live && replay, 'one of the two nodes wrote no prices row for the size-cap breach');
        assert.strictEqual(live.status, breachSize.status,
            'the live node recorded "' + live.status + '" for a payload whose inflated body is ' +
            breachSize.inflatedBody.length + ' B, past the ' + priceBatch.PRICE_WIRE_MAX_BYTES +
            ' B reader bound. Expected "' + breachSize.status + '".');
        assert.strictEqual(replay.status, live.status,
            'the two nodes disagree about a size-cap breach: live "' + live.status + '" vs replay "' +
            replay.status + '". Section 4a makes this bound CONSENSUS precisely so they cannot.');
        assert.strictEqual(live.validation_status, 'invalid');
        assert.strictEqual(replay.validation_status, 'invalid');
    });

    it('a RATIO-cap breach is rejected with the identical status on both nodes', function () {
        const txid = breachRatio.landed.txid;
        assert.strictEqual(breachRatio.reason, REASON_RATIO);
        // Which of the two caps binds is `ratioCap <= PRICE_WIRE_MAX_BYTES`, resolved
        // on the DECODED length, so re-derive it here rather than trusting the
        // reason string: a ratio breach that is really size-bound would still be
        // rejected, and this clause would then be the size clause a second time.
        const rawBytes = priceBatch.decodeCanonicalBase64(breachRatio.field);
        assert.notStrictEqual(rawBytes, null, 'the crafted ratio breach is not canonical base64');
        assert.ok(rawBytes.length * priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO <= priceBatch.PRICE_WIRE_MAX_BYTES,
            'the crafted breach is SIZE-bound, not ratio-bound: ' + rawBytes.length + ' compressed bytes ' +
            'times ' + priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO + ' is above the ' +
            priceBatch.PRICE_WIRE_MAX_BYTES + ' B cap, so the size bound would bind first');
        const live = liveRows[txid], replay = replayRows[txid];
        assert.ok(live && replay, 'one of the two nodes wrote no prices row for the ratio-cap breach');
        assert.strictEqual(live.status, breachRatio.status,
            'the live node recorded "' + live.status + '" for a ' + breachRatio.field.length +
            ' byte field that inflates to ' + breachRatio.inflatedBody.length + ' B, a ratio far past ' +
            priceBatch.PRICE_BATCH_MAX_INFLATE_RATIO + ':1. Expected "' + breachRatio.status + '".');
        assert.strictEqual(replay.status, live.status,
            'the two nodes disagree about a ratio-cap breach: live "' + live.status + '" vs replay "' +
            replay.status + '"');
        assert.strictEqual(live.validation_status, 'invalid');
        assert.strictEqual(replay.validation_status, 'invalid');
    });

    it('nothing from a breached wire is absorbed: no structural fields, no snapshots, on either node', function () {
        // A wire refused at decompression must never record structure. `_parseV0`
        // reaches its storage step with `firstRound` undefined and `roundsWire`
        // empty, so a batch column carrying anything here means a node parsed a
        // body it had already refused to inflate.
        for (const b of [breachSize, breachRatio]) {
            for (const [label, rows] of [['live', liveRows], ['replay', replayRows]]) {
                const row = rows[b.landed.txid];
                assert.strictEqual(row.rounds_json, null,
                    'the ' + label + ' node stored rounds_json for a ' + b.reason +
                    ' wire it never inflated: ' + String(row.rounds_json).slice(0, 120));
                assert.strictEqual(row.sigs_json, null,
                    'the ' + label + ' node stored a signature set for a ' + b.reason + ' wire');
                assert.ok(row.round_count === null || Number(row.round_count) === 0,
                    'the ' + label + ' node stored round_count ' + row.round_count + ' for a ' +
                    b.reason + ' wire');
            }
        }

        // And the rounds those wires CLAIMED are in no table on either node. This
        // is the half that makes "never absorbed" evidence: the ghost rounds exist
        // nowhere else in this run, so finding one would name the node that
        // relaxed a bound.
        assert.deepStrictEqual(liveGhostSnaps, [],
            'the live node\'s hub holds ' + liveGhostSnaps.length + ' price_snapshots row(s) for rounds ' +
            ghost.first + '..' + ghost.last + ', which no federation ever finalized');
        assert.deepStrictEqual(replayGhostSnaps, [],
            'the replay node\'s hub holds ' + replayGhostSnaps.length + ' ghost price_snapshots row(s)');
        assert.deepStrictEqual(replayGhostMirror, [],
            'the replay node\'s mirror carried ' + replayGhostMirror.length + ' ghost row(s) back down');
        assert.deepStrictEqual(liveGhostActions, [],
            'the live node recorded ' + liveGhostActions.length + ' prices row(s) claiming a ghost round');
    });

    // -----------------------------------------------------------------------
    // Clause 3: non-canonical base64 rejected, not silently normalized
    // -----------------------------------------------------------------------

    it('every non-canonical base64 spelling decodes to the SAME bytes under a lenient reader', function () {
        // The premise of the clause, established before the verdicts are read. A
        // spelling a lenient reader would REJECT anyway proves nothing about
        // strictness; these three are exactly the spellings Node's own
        // Buffer.from(s, 'base64') happily normalizes onto the canonical payload.
        for (const s of spellings) {
            assert.ok(s.strictRejects,
                'the "' + s.name + '" spelling is accepted by decodeCanonicalBase64, so it is not a ' +
                'non-canonical spelling at all and this clause tests nothing');
            assert.ok(s.lenientDecodesSame,
                'the "' + s.name + '" spelling does not decode to the canonical payload under a lenient ' +
                'reader, so rejecting it is not evidence about normalization. Rebuild the spelling.');
            assert.notStrictEqual(s.field, s.canonicalField);
        }
    });

    it('every non-canonical base64 spelling is rejected ON CHAIN, on both nodes, with the base64 status', function () {
        for (const s of spellings) {
            const live = liveRows[s.landed.txid], replay = replayRows[s.landed.txid];
            assert.ok(live && replay, 'a node wrote no prices row for the "' + s.name + '" wire');
            assert.strictEqual(live.status, STATUS_BASE64,
                'the live node recorded "' + live.status + '" for the "' + s.name + '" spelling. ' +
                'Expected "' + STATUS_BASE64 + '". Any other status means the field got PAST the ' +
                'decoder, i.e. the spelling was silently normalized into the canonical payload and ' +
                'one wire now has two meanings.');
            assert.strictEqual(replay.status, live.status,
                'the two nodes disagree about the "' + s.name + '" spelling: live "' + live.status +
                '" vs replay "' + replay.status + '"');
            assert.strictEqual(live.validation_status, 'invalid');
            assert.strictEqual(replay.validation_status, 'invalid');
            // Not normalized: had it been, the ghost body would have been parsed and
            // its structure recorded.
            assert.strictEqual(live.rounds_json, null,
                'the live node stored round bodies for a "' + s.name + '" wire, so it decoded the ' +
                'non-canonical spelling after all');
            assert.strictEqual(replay.rounds_json, null,
                'the replay node stored round bodies for a "' + s.name + '" wire');
        }
    });

    // -----------------------------------------------------------------------
    // Clause 4: a batch that deflates larger publishes uncompressed
    // -----------------------------------------------------------------------

    it('the publisher\'s emit-smaller decision is content-driven, not a constant', function () {
        assert.strictEqual(emitReal.compressed, true,
            'OraclePublisher._emitWire declined to compress the real six-round batch, whose body is ' +
            parsedWire.bodyBytes + ' B and whose packed form is ' + parsedWire.wireBytes + ' B');
        assert.strictEqual(emitEntropy.compressed, false,
            'OraclePublisher._emitWire compressed an INCOMPRESSIBLE body: the plain wire is ' +
            entropyPlainBytes + ' B and the packed wire is ' + entropyPackedBytes + ' B, so ' +
            'compressing it spends bytes to buy nothing');
        assert.ok(entropyPackedBytes >= entropyPlainBytes,
            'the incompressible body is not actually incompressible (' + entropyPackedBytes +
            ' B packed vs ' + entropyPlainBytes + ' B plain), so this clause proves nothing. ' +
            'entropyString drew from too small an alphabet.');
        assert.strictEqual(emitEntropy.bytes, entropyPlainBytes,
            '_emitWire returned ' + emitEntropy.bytes + ' B for a body whose plain wire is ' +
            entropyPlainBytes + ' B');
        const emittedFields = String(emitEntropy.wire).split('|');
        assert.strictEqual(emittedFields[0], 'PRICE');
        assert.strictEqual(parseInt(emittedFields[1], 10), BATCH_WIRE_VERSION);
        assert.notStrictEqual(emittedFields[2], priceBatch.PRICE_BATCH_COMPRESSION_MARKER,
            'the emitted wire carries the compression marker in the FIRST_ROUND slot even though ' +
            '_emitWire reported the uncompressed form; the two halves of the decision disagree');
    });

    it('the uncompressed wire form is a first-class wire: the plain twin lands the identical batch', function () {
        // The same signed body, in the other form, on the same chain. If the two
        // forms could diverge in validity, this is where it would show: the
        // compressed original and its plain twin must produce the same stored
        // batch on both nodes.
        const original = liveRows[landedTxid];
        for (const [label, rows] of [['live', liveRows], ['replay', replayRows]]) {
            const twin = rows[plainTwin.txid];
            assert.ok(twin, 'the ' + label + ' node wrote no prices row for the uncompressed twin');
            assert.ok(!/^invalid: COMPRESSION/.test(String(twin.status)),
                'the ' + label + ' node recorded "' + twin.status + '" for an UNCOMPRESSED wire; a wire ' +
                'with no `Z` marker must never reach the decompression path at all');
            assert.strictEqual(Number(twin.version), BATCH_WIRE_VERSION);
            assert.strictEqual(Number(twin.batch_first_round), parsedBody.firstRound);
            assert.strictEqual(Number(twin.batch_last_round), parsedBody.lastRound);
            assert.strictEqual(Number(twin.round_count), WINDOW_ROUNDS);
            assert.strictEqual(twin.rounds_json, rows[landedTxid].rounds_json,
                'the ' + label + ' node stored different round bodies for the two wire forms of ONE ' +
                'signed batch. Everything downstream of decompression is meant to be form-agnostic.');
            assert.strictEqual(twin.sigs_json, rows[landedTxid].sigs_json,
                'the ' + label + ' node stored a different signature set for the two wire forms');
        }
        assert.strictEqual(liveRows[plainTwin.txid].status, replayRows[plainTwin.txid].status,
            'the two nodes disagree about the uncompressed twin');
        // The verdict itself is not AT9's claim, but a twin that validates
        // differently from its compressed original IS: same bytes, same rules.
        assert.strictEqual(liveRows[plainTwin.txid].status, original.status,
            'the compressed batch recorded "' + original.status + '" and its own uncompressed twin ' +
            'recorded "' + liveRows[plainTwin.txid].status + '". The two wire forms are one action ' +
            'in two spellings; a validity difference between them is a fork.' +
            (original.status === KNOWN_CAPABILITY_GAP_STATUS
                ? ' (Both carry the known price-capability verdict, which AT9 does not judge.)' : ''));
    });
});
