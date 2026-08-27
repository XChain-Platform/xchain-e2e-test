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
 * AT4, both halves, as reworded 2026-08-26:
 *
 *   "a post-signing tamper records invalid with the same status string on two
 *    independently replaying nodes, and a validator that signed a PER-ROUND
 *    CONSENSUS CANONICAL (still built and signed, XORACLE-tagged) and a BATCH
 *    canonical (XORACLEB-tagged) at one anchor is NOT slashable"
 *
 * HALF ONE, THE TAMPER. A real federation finalizes a real window, the real
 * OracleBatchSigner collects a real quorum over it and the real OraclePublisher
 * lands one genuinely signed batch on DOGE regtest. This drill then takes THAT
 * wire, corrupts it AFTER the signatures were produced, re-encodes it in the same
 * wire form and lands the corrupt bytes on the same chain from the same funded
 * address. Two nodes then decide the corrupt action independently: the standing
 * stack's own indexer, which saw it arrive live, and a node built from nothing by
 * the AT2 replay rig, which sees it only as a block it walks. THE CLAIM IS
 * CROSS-NODE IDENTITY OF THE REJECTION, not rejection: one node refusing a
 * tampered batch is a parser working, two nodes refusing it with byte-identical
 * status strings is consensus.
 *
 * TWO TAMPERS, AND WHY THE SECOND ONE IS NOT PADDING. The tamper AT4 names is a
 * flipped price digit inside the body, which leaves the batch structurally legal,
 * so it reaches signature verification, fails every signature and is rejected at
 * the quorum gate. On a stake-weighted network that gate's refusal reads
 * `invalid: insufficient signer stake`, WHICH IS THE SAME STRING the still-open
 * price-capability gap produces for a perfectly honest batch. A drill that
 * asserted only on that string could pass while proving nothing, so a second
 * tamper moves the batch header's anchor off the last round's anchor: that breach
 * is caught in the structural rules, before any capability is resolved, and its
 * status can ONLY have come from the tamper. The price-digit tamper's own
 * discrimination assertion is isolated in its own `it()` and WAITS (skips, with
 * the reason printed) if the honest batch on the same chain is still recording
 * the capability-gap string; the cross-node identity assertion never waits.
 *
 * HALF TWO, THE SLASH SAFETY, AND EXACTLY HOW FAR IT IS DRIVEN. A full on-chain
 * SLASH is not drivable here and would not be a stronger claim: SLASH is BTC-only
 * (`slash.js` rejects any other COIN outright, because capability stake is
 * BTC-only) while the batch rail publishes to DOGE, and capability bonds cannot
 * be staked on the venue's chain at all. So this half drives the indexer's REAL
 * `Slash` handler in-process against REAL signed artifacts the venue produced:
 * the per-round canonical built by the hub's OWN producer
 * (`OracleConsensus._buildPriceV0Payload`, reached through `venue.priceCanonical`)
 * and the batch canonical the REAL signing round built, each carrying a signature
 * that a REAL venue validator produced and that `ValidatorIdentity.verify`
 * confirms. Only the DB surface behind the handler is stubbed, and it is stubbed
 * PERMISSIVELY (the offender is in the capability snapshot, has never been
 * slashed, holds a burnable bond), so the only thing that can stop the burn is
 * the equivocation logic itself.
 *
 * THE COUNTERFACTUAL IS THE POINT. A test that shows an honest pair is refused
 * proves nothing unless the same harness burns a bond when it should. So the same
 * two RAW contents, signed by the same real validator, are re-wrapped under ONE
 * shared XORACLE key at the same anchor, which is precisely the world the spec
 * describes before `ENGINE_TAGS.ORACLE_BATCH` existed, and fed to the same
 * handler: it records `valid` and burns the entire bond. That pair of results is
 * AT4's parenthetical driven rather than asserted: the distinct tag is the only
 * thing standing between an honest validator and a full bond burn plus permanent
 * capability disqualification.
 *
 * WHAT IS REAL AND WHAT IS NOT:
 *   REAL     - the PBFT rounds, the peer signing round, the canonical builders in
 *              both repos, the publisher, the encoder, the signature, the DOGE
 *              regtest broadcast, the blocks, both indexers' parsers and their
 *              recorded status strings, the consensus compression module, the
 *              indexer's Slash handler, every Ed25519 key and signature.
 *   NOT REAL - the DB surface behind Slash (stubbed permissively in this file,
 *              see slashHarness), and the SLASH action is never carried on a
 *              chain. Named here rather than implied.
 *
 * ONE VENUE AT A TIME. The venue and the replay rig share a fixed-port disposable
 * MariaDB and one DOGE regtest stack. Run this drill serially, never beside
 * another oracle batch drill.
 ********************************************************************/

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const path   = require('path');

const { OracleBatchVenue, ValidatorIdentity } = require('../helpers/oracleBatchVenue');
const drive                    = require('../helpers/oracleBatchDrive');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { waitFor }              = require('../helpers/consensusWait');
const {
    OracleBatchReplayNode,
    readPriceActions,
    connectTo
} = require('../helpers/oracleBatchReplay');

// The indexer's own consensus modules, read from the repo a landing chain
// actually runs. `slash.js` pulls in only `ed25519.js` and
// `equivocation_header.js`, both of which depend on nothing but `crypto`, so the
// real handler loads here without a database driver or a running node.
const INDEXER_ROOT = path.resolve(__dirname, '../../../xchain-indexer');
const Slash   = require(path.join(INDEXER_ROOT, 'src', 'actions', 'slash.js'));
const eq      = require(path.join(INDEXER_ROOT, 'src', 'equivocation_header.js'));
const ed25519 = require(path.join(INDEXER_ROOT, 'src', 'ed25519.js'));

// ---------------------------------------------------------------------------
// The drill's own numbers
// ---------------------------------------------------------------------------

// Two rounds, not six. AT1 owns "how many rounds fit in one wire"; AT4 owns what
// happens to a signed wire afterwards, and a two-round window is a genuine
// multi-round batch (a real window, a real signing round, per-round bodies the
// tamper can reach into) at a third of the PBFT cost.
const WINDOW_ROUNDS  = 2;
const VALIDATORS     = 4;
const MIN_SIGNATURES = 3;

// Seconds, not the shipped five minutes: rounds driven back to back in-process
// have no stragglers for the grace to wait for.
const GRACE_MS = 4000;

// The price-sync grace BOTH the standing node and the replay node must be judged
// under. MEASURED by the AT2 rig: at the frozen 4800 a chain-only node stops dead
// at the first block younger than 4800 seconds and cannot reach a freshly mined
// tip inside any sensible budget. 600 is the value the platform ran on until this
// spec moved it, so it is a real barrier rather than a barrier switched off, and
// the indexer honours the override on regtest only. AT5 is the drill that must
// exercise the barrier itself; this one must not.
const PRICE_GRACE_S = 600;

// The one verdict a well-formed PRICE can legitimately record on a non-BTC
// indexer while the price-capability gap is open, and, unhelpfully, also the
// verdict a body tamper earns on a stake-weighted network. See the header.
const CAPABILITY_GAP_STATUS = 'invalid: insufficient signer stake';

// The status a header-anchor tamper can ONLY earn from the tamper: it is thrown
// in the structural rules (`price.js`, "batch anchor does not match the last
// round"), upstream of every capability, gate and signature.
const ANCHOR_TAMPER_STATUS = 'invalid: batch anchor does not match the last round';

// What `slash.js` records for two canonicals that do not share an EQUIV key
// prefix. This is the whole of AT4's second half: a per-round canonical and a
// batch canonical carry DIFFERENT engine tags, so they cannot be paired at all.
const TAG_SEPARATION_STATUS = 'invalid: EQUIV header/key mismatch';

// The PRICE wire prefix every batch rides under after the v0 collapse
// (`OraclePublisher`: `'PRICE|0|' + body`, or `'PRICE|0|Z|' + base64`).
const WIRE_PREFIX = 'PRICE|0|';

// ---------------------------------------------------------------------------
// Reading and re-encoding a batch wire
//
// HELPER GAP, WORKED AROUND HERE RATHER THAN EDITED: `oracleBatchDrive
// .parsePriceBatchWire` still refuses anything whose version field is not `2`
// (`if (version !== 2) return { ok:false, reason:'not-version-2' }`), which the
// v0 collapse of 2026-08-26 made unreachable for every wire the shipped publisher
// emits. The reader below is that helper's body with the version gate moved onto
// 0, and it inflates through the SAME consensus module (`price_batch_compression`,
// reached as `drive.priceBatch`), so a wire this file accepts is a wire the chain
// accepts and a wire it re-encodes is one an indexer will read.
// ---------------------------------------------------------------------------

function parseBatchWire(wire) {
    const parts = String(wire || '').split('|');
    if (parts[0] !== 'PRICE') return { ok: false, reason: 'not-a-price-wire' };
    const version = parseInt(parts[1], 10);
    if (version !== 0) return { ok: false, reason: 'not-version-0', version: version };

    let body, compressed = false, compressedBytes = null, ratio = null;
    if (parts[2] === drive.priceBatch.PRICE_BATCH_COMPRESSION_MARKER) {
        // Rejoining is required rather than cosmetic: canonical base64 carries no
        // `|`, but a hostile wire may, and rejoining is what makes this reader see
        // the same single field the indexer's parser sees.
        const field    = parts.slice(3).join('|');
        const inflated = drive.priceBatch.inflatePriceBatchBody(field);
        if (!inflated.ok) return { ok: false, reason: inflated.reason, status: inflated.status, compressed: true };
        body            = inflated.body;
        compressed      = true;
        compressedBytes = inflated.compressedBytes;
        ratio           = inflated.ratio;
    } else {
        body = parts.slice(2).join('|');
    }

    const f = body.split('|');
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

    return {
        ok: true, version: 0, compressed: compressed,
        body: body,
        bodyBytes:  Buffer.byteLength(body, 'utf8'),
        wireBytes:  Buffer.byteLength(String(wire), 'utf8'),
        compressedBytes: compressedBytes, ratio: ratio,
        firstRound: firstRound, lastRound: lastRound, anchor: anchor,
        roundCount: roundCount, rounds: rounds, sigs: sigs
    };
}

/**
 * Put a (tampered) body back on the wire in the SAME form the honest wire used.
 *
 * Same form on purpose: emitting the smaller of the two, as the publisher does,
 * would let a tamper change the wire FORM as well as the content, and then a
 * cross-node disagreement could be about the form. The only difference between
 * the honest wire and a tampered one here is the bytes the tamper touched.
 */
function encodeBatchWire(body, compressed) {
    return compressed
        ? WIRE_PREFIX + drive.priceBatch.PRICE_BATCH_COMPRESSION_MARKER + '|' +
          drive.priceBatch.compressPriceBatchBody(body)
        : WIRE_PREFIX + body;
}

// Field offsets inside the body (everything after `PRICE|0|`), in the parser's own
// order: FIRST_ROUND, LAST_ROUND, BTC_BLOCK_HEIGHT, ROUND_COUNT, then the round
// blocks. Named rather than inlined so the two tampers below say what they touch.
const BODY_ANCHOR_FIELD    = 2;
const BODY_FIRST_ROUND_AT  = 4;   // where round block 0 starts
const ROUND_HEADER_FIELDS  = 4;   // ROUND, TIMESTAMP, ANCHOR_HEIGHT, PAIR_COUNT

/**
 * THE TAMPER AT4 NAMES: flip one digit of one price, deep inside the signed body.
 *
 * Deliberately keeps the result a LEGAL price (`/^[0-9]+(\.[0-9]+)?$/`, the
 * parser's own pattern), because a tamper that broke the format would be rejected
 * by a format rule and would never reach the signatures. This one is structurally
 * perfect and cryptographically dead: the canonical every node rebuilds from the
 * body no longer matches the bytes the federation signed, so not one signature on
 * the wire verifies.
 */
function tamperPriceDigit(body) {
    const f = body.split('|');
    const priceIndex = BODY_FIRST_ROUND_AT + ROUND_HEADER_FIELDS + 1;   // round 0, pair 0, price
    const before = String(f[priceIndex]);
    const digit  = before.search(/[0-9]/);
    if (digit < 0) throw new Error('AT4: no digit found in the first price field: "' + before + '"');
    const after = before.slice(0, digit) +
                  String((Number(before[digit]) + 1) % 10) +
                  before.slice(digit + 1);
    if (after === before) throw new Error('AT4: the price digit flip changed nothing');
    if (!/^[0-9]+(\.[0-9]+)?$/.test(after))
        throw new Error('AT4: the tampered price is not a legal price: "' + after + '"');
    f[priceIndex] = after;
    return { body: f.join('|'), field: 'round 0 pair "' + f[BODY_FIRST_ROUND_AT + ROUND_HEADER_FIELDS] +
        '" price', before: before, after: after };
}

/**
 * THE TAMPER THAT CANNOT BE CONFUSED WITH ANYTHING ELSE: move the batch header's
 * anchor off the last included round's anchor.
 *
 * Section 4 pins the two to be numerically equal and `price.js` checks it
 * structurally, BEFORE the straddle rule and before either quorum gate resolves,
 * so the rejection is reached without resolving a capability, a stake weight or a
 * signature. Its status string is therefore attributable to this tamper and to
 * nothing else, which is what keeps the drill honest while the price-capability
 * verdict on DOGE is still settling.
 */
function tamperHeaderAnchor(body) {
    const f = body.split('|');
    const before = String(f[BODY_ANCHOR_FIELD]);
    const after  = String(parseInt(before, 10) + 1);
    f[BODY_ANCHOR_FIELD] = after;
    return { body: f.join('|'), field: 'header BTC_BLOCK_HEIGHT', before: before, after: after };
}

// ---------------------------------------------------------------------------
// The signed artifacts AT4's second half is about
// ---------------------------------------------------------------------------

function stripEquivHeader(canonical) {
    const s = String(canonical);
    const at = s.indexOf('||');
    if (!s.startsWith('EQUIV|') || at < 0)
        throw new Error('AT4: canonical carries no EQUIV header: ' + s.slice(0, 60));
    return s.slice(at + 2);
}

function equivPrefixOf(canonical) {
    const s = String(canonical);
    return s.slice(0, s.indexOf('||') + 2);
}

/**
 * Find ONE validator that really signed BOTH canonicals, using only artifacts the
 * run observed: the per-round signature set the PBFT round collected, and the
 * batch signature set that rode the wire.
 *
 * Both sides are re-verified here with the hub's own `ValidatorIdentity.verify`
 * against the canonical the hub's own producer built, so a pair returned by this
 * function is a pair a slashing reviewer would find on the chain, not one this
 * file assembled.
 */
function findObservedDualSigner(venue, roundRecords, parsed, batchCanonical) {
    for (const wireRound of parsed.rounds) {
        const record = roundRecords.find((r) => r.round === wireRound.round);
        if (!record || !Array.isArray(record.signatures)) continue;
        // Built from the WIRE's pair data, not from the venue's submissions: the
        // federation finalizes an aggregate fixed to eight decimals, and the wire
        // carries that finalized spelling, which is what the round was signed over.
        const roundCanonical = venue.priceCanonical(
            wireRound.round, wireRound.timestamp, wireRound.pairs, wireRound.btcBlockHeight);
        for (const rs of record.signatures) {
            const pubkey = String(rs.pubkey || '').toLowerCase();
            if (!pubkey || !rs.sig) continue;
            if (!ValidatorIdentity.verify(roundCanonical, String(rs.sig), pubkey)) continue;
            const bs = parsed.sigs.find((s) => s.pubkey === pubkey &&
                ValidatorIdentity.verify(batchCanonical, s.sig, s.pubkey));
            if (!bs) continue;
            return {
                source:         'observed on the chain and on the round',
                pubkey:         pubkey,
                round:          wireRound.round,
                roundCanonical: roundCanonical,
                roundSig:       String(rs.sig).toLowerCase(),
                batchCanonical: batchCanonical,
                batchSig:       bs.sig
            };
        }
    }
    return null;
}

/** The venue hub holding a given capability signing key, or hubs[0]. */
function identityFor(venue, pubkey) {
    for (const hub of venue.mvh.hubs) {
        const id = hub.getIdentity ? hub.getIdentity() : null;
        if (id && String(id.getPubkeyHex()).toLowerCase() === String(pubkey).toLowerCase()) return id;
    }
    for (const hub of venue.mvh.hubs) {
        const id = hub.getIdentity ? hub.getIdentity() : null;
        if (id) return id;
    }
    return null;
}

/**
 * Fallback for the dual signer: a REAL venue validator identity signs the two
 * REAL canonicals directly.
 *
 * Weaker than the observed path by exactly one step (the signatures were made
 * here rather than read off the chain) and identical in every other respect: the
 * key is a live validator's capability key and the bytes are the production
 * builders' own output. Used only when the observed intersection is empty, and
 * the run prints which path it took.
 */
function signDualWithVenueIdentity(venue, parsed, batchCanonical) {
    const id = identityFor(venue, null);
    if (!id) return null;
    const w = parsed.rounds[0];
    const roundCanonical = venue.priceCanonical(w.round, w.timestamp, w.pairs, w.btcBlockHeight);
    return {
        source:         'signed here by a real venue validator identity',
        pubkey:         String(id.getPubkeyHex()).toLowerCase(),
        round:          w.round,
        roundCanonical: roundCanonical,
        roundSig:       id.sign(roundCanonical),
        batchCanonical: batchCanonical,
        batchSig:       id.sign(batchCanonical)
    };
}

// ---------------------------------------------------------------------------
// The SLASH harness
//
// The real handler, a permissive DB. Every stub below is set so that the ONLY
// thing able to stop a burn is the equivocation logic: the offender is in the
// price capability snapshot at whatever block the proof resolves, has never been
// slashed, stakes in its own name, and holds a burnable bond. A refusal from this
// harness is therefore a refusal by the tag/round-id design and by nothing else.
// ---------------------------------------------------------------------------

function slashHarness(offenderPubkey) {
    const calls = { capabilityLookups: [], burns: [], events: [] };

    const indexerDb = {
        getValidatorsByCapability: async (capability, block) => {
            calls.capabilityLookups.push({ capability: capability, block: block });
            return [{ pubkey: offenderPubkey, amount: '1000' }];
        },
        getActiveValidators:             async () => [{ pubkey: offenderPubkey, amount: '1000' }],
        getOrCreatePubkeyId:             async () => 7,
        hasCapabilitySlashEvent:         async () => false,
        getStakeSourceForDelegatedPubkey: async () => null,
        slashCapabilityStake: async (pubkeyId, blockIndex, actionIndex, burnPending, ownerSourceId) => {
            calls.burns.push({ pubkeyId, blockIndex, actionIndex, burnPending, ownerSourceId });
            return '1000';
        },
        createCapabilitySlashEvent: async (row) => { calls.events.push(row); },
        getAddressId:               async () => 1,
        updateBalances:             async () => {},
        updateTokens:               async () => {}
    };

    // Only the arithmetic and list helpers the handler reaches. The amounts here
    // never leave this process: with no STAKING.CAPABILITIES.price.SLASH config the
    // split is a pure burn, so nothing is credited and no precision question arises.
    const util = {
        isNull: (v) => v === null || v === undefined || v === '',
        bcgt:   (a, b) => Number(a) > Number(b),
        bcsub:  (a, b) => String(Number(a) - Number(b)),
        bcmul:  (a, b) => String(Number(a) * Number(b)),
        bcdiv:  (a, b) => String(Number(a) / Number(b)),
        processTransactionLedgerChanges: async () => {},
        getTickersList:   () => [],
        getAddressesList: () => ({}),
        addAddressTicker: () => {}
    };

    const ctx = {
        config:    { GAS: 'XCHAIN', NETWORK: 'regtest' },
        util:      util,
        mapper:    { createMappings: async () => {} },
        decoderDb: {},
        indexerDb: indexerDb,
        protocolChanges: {
            isDefined: () => true,
            // Both gates the handler reads (SLASH_ORACLE_ROUND_DISCRIMINATED and
            // SLASH_BURNS_PENDING_STAKE) resolved ON, which is the strictest setting
            // for the honest pair and the most permissive for the counterfactual.
            isEnabled: async () => true
        }
    };

    return { handler: new Slash(ctx), calls: calls };
}

const b64url = (s) => Buffer.from(String(s), 'utf8').toString('base64url');

async function runSlashProof(harness, capability, offender, msgA, sigA, msgB, sigB, blockIndex) {
    const data = {
        FORMAT: 0, COIN: 'BTC', BLOCK_INDEX: blockIndex, ACTION_INDEX: 1,
        SOURCE: 'xchain-at4-submitter', BLOCK_TIME: 1700000000
    };
    await harness.handler.parse(
        ['0', capability, offender, b64url(msgA), String(sigA), b64url(msgB), String(sigB)],
        data, null);
    return String(data['STATUS']);
}

// ---------------------------------------------------------------------------
// Live-chain reads
//
// HELPER GAP: `OracleBatchReplayNode` resolves the standing stack's indexer
// database for its own use but exposes no accessor for it (`this._live` is
// private, and `liveChainFeeCoordinates` returns only fee coordinates). The
// resolver below is the rig's own discovery path, repeated here so this file can
// read the live node's PRICE verdicts as supporting evidence. Only the database
// NAME is ever printed; the credentials go straight into the driver.
// ---------------------------------------------------------------------------

async function resolveLiveIndexerDb(coin, network) {
    const XChainHubConnector = require('../../src/XChainHubConnector.js');
    const hub = new XChainHubConnector(XChainHubConnector.parseEndpoints());
    if (!(await hub.ping())) return null;
    const cfg = await hub.getAllConfig();
    const svc = cfg && cfg[coin] && cfg[coin][network];
    const ixr = svc && svc['xchain-indexer'];
    if (!ixr || !ixr.name) return null;
    return {
        host: process.env.DATABASE_URL || '127.0.0.1',
        port: parseInt(process.env.DATABASE_PORT, 10) || 13306,
        name: ixr.name, user: ixr.user, pass: ixr.pass
    };
}

// Wait until the landing chain has MINED a transaction, so the next broadcast can
// never share its block. Sharing one would leave two of this drill's PRICE actions
// at one block_index, and the replay side attributes verdicts by block.
async function waitMined(venue, txid, timeoutMs) {
    const got = await waitFor(async () => {
        let block = null;
        try { block = await venue.blockOf(txid); } catch (_) { block = null; }
        return { ok: !!(block && Number.isFinite(Number(block.height))), block: block };
    }, { timeoutMs: timeoutMs || 240_000, intervalMs: 1000 });
    if (!got.ok) throw new Error('AT4: transaction ' + txid + ' was never mined within ' + got.waitedMs + 'ms');
    return got.last.block;
}

function statusHistogram(rows) {
    const out = {};
    for (const r of rows) out[String(r.status)] = (out[String(r.status)] || 0) + 1;
    return out;
}

function describeHistogram(h) {
    return Object.keys(h).map((k) => h[k] + ' x "' + k + '"').join(', ') || 'nothing';
}

// ---------------------------------------------------------------------------

describe('AT4: a post-signing tamper is refused identically by two nodes, and an honest ' +
         'per-round + batch signer is NOT slashable (L3)', function () {

    // A real window, three chain landings, a whole node built from nothing and a
    // full chain replay. The budget is per-suite; every wait inside is a poll that
    // returns the moment its condition holds.
    this.timeout(90 * 60 * 1000);

    let hubDb = null, venue = null, pinned = null, signerSet = null, replayNode = null;
    let liveConn = null, liveDb = null, liveDbError = null;

    // half one
    let rounds = [], parsed = null, honest = null;
    let landed = {};                 // name -> { wire, txid, bytes, height, tamper }
    let liveStatus = {}, replayStatus = {};
    let livePriceRows = [], replayPriceRows = [];
    let minBlock = null, targetHeight = null;
    let priceRowDiff = null;

    // half two
    let dual = null, counterfactual = null, batchCanonical = null, rebuiltCanonical = null;
    let canonicalFromSigningRound = false;
    let honestProof = null, swappedProof = null, sharedTagProof = null;

    before(async function () {
        const bail = async (why) => {
            console.log('AT4 unavailable: ' + why);
            if (signerSet)  { try { signerSet.stop(); } catch (_) { /* teardown is best effort */ } }
            if (venue)      await venue.down();
            if (replayNode) await replayNode.down();
            if (liveConn)   { try { await liveConn.end(); } catch (_) { /* ditto */ } }
            if (hubDb)      await hubDb.stop();
            if (pinned)     pinned.restore();
            signerSet = venue = replayNode = liveConn = hubDb = pinned = null;
        };

        // Started once, here, and shared with the venue and the replay node. The
        // venue's own startDisposableHubDb resolves this same handle and hands back a
        // no-op stop(), so tearing the federation down cannot take the replay node's
        // database server with it.
        hubDb = await startDisposableHubDb();
        if (!hubDb) { console.log('AT4 unavailable: no env hub DB and Docker unavailable'); this.skip(); return; }

        // MUST precede venue.up(): OraclePublisher reads both knobs in its constructor.
        pinned = drive.pinBatchWindow({ windowRounds: WINDOW_ROUNDS, graceMs: GRACE_MS });

        venue = new OracleBatchVenue({
            coin: 'dogecoin', network: 'regtest',
            validatorCount: VALIDATORS,
            basePort: 33900,
            roundBase: drive.alignedRoundBase(WINDOW_ROUNDS),
            expectWireVersion: 0
        });

        let up = false;
        try { up = await venue.up(); }
        catch (err) { await bail('venue failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!up) { await bail(venue.unavailable); this.skip(); return; }

        // Keep the publisher's batch BUFFER out of the checkout, and out of THIS run.
        // OraclePublisher derives bufferPath from queuePath in its CONSTRUCTOR, and the
        // venue redirects queuePath afterwards, so the redirect never reaches the
        // buffer: left alone the rail writes `<cwd>/data/publisher-queue.buffer.jsonl`
        // into the working tree and RELOADS it next run, so a previous drill's rounds
        // arrive in this one and fail their signing round.
        for (const pub of venue.publishers) {
            if (pub.queuePath) pub.bufferPath = String(pub.queuePath).replace(/\.jsonl$/, '') + '.buffer.jsonl';
            if (pub._buffer && typeof pub._buffer.clear === 'function') pub._buffer.clear();
        }

        // Every hub, not just the leader: OraclePublisher builds a signer lazily and
        // only the elected leader reaches that call, so without this no follower has
        // registered the XPRICEB handler and the signing round expires at 1/N.
        signerSet = drive.attachBatchSigners(venue);

        // --- 1. one genuinely signed batch on a real chain ----------------------
        rounds = await drive.finalizeRoundsNoWait(venue, WINDOW_ROUNDS);
        const settle = await drive.waitForPublications(venue, { min: 1, quietMs: 20_000, timeoutMs: 300_000 });
        if (!settle.reached || venue.publications.length === 0) {
            await bail('the federation never published a batch for the window.' +
                drive.railDiagnosis(venue, signerSet));
            this.skip(); return;
        }

        honest = venue.publications[0];
        parsed = parseBatchWire(honest.wire);
        if (!parsed.ok) {
            await bail('the published wire does not parse as a PRICE batch: ' + parsed.reason);
            this.skip(); return;
        }

        const honestBlock = await waitMined(venue, honest.txid);
        landed.honest = {
            wire: honest.wire, txid: honest.txid, bytes: honest.wireBytes,
            height: Number(honestBlock.height), tamper: null
        };

        // --- 2. the two post-signing tampers, on the same rail -------------------
        // Same encoder, same publisher address, same node, same blocks. The ONLY
        // thing that is not the federation's own is the bytes.
        const digit  = tamperPriceDigit(parsed.body);
        const anchor = tamperHeaderAnchor(parsed.body);

        for (const [name, t] of [['priceDigit', digit], ['headerAnchor', anchor]]) {
            const wire = encodeBatchWire(t.body, parsed.compressed);
            assert.ok(Buffer.byteLength(wire, 'utf8') <= drive.priceBatch.PRICE_WIRE_MAX_BYTES,
                'AT4: the ' + name + ' tamper produced a ' + Buffer.byteLength(wire, 'utf8') +
                ' byte wire, over the ' + drive.priceBatch.PRICE_WIRE_MAX_BYTES + ' byte ceiling; ' +
                'it would be dropped by the encoder rather than judged by a parser');
            assert.notStrictEqual(wire, honest.wire, 'AT4: the ' + name + ' tamper changed nothing on the wire');
            const sent  = await drive.broadcastWire(venue, wire);
            const block = await waitMined(venue, sent.txid);
            landed[name] = {
                wire: wire, txid: sent.txid, bytes: sent.wireBytes,
                height: Number(block.height), tamper: t
            };
        }

        const heights = Object.keys(landed).map((k) => landed[k].height);
        minBlock     = Math.min(...heights);
        targetHeight = Math.max(...heights);

        // --- 3. what the LIVE node made of all three ----------------------------
        for (const name of Object.keys(landed)) {
            const row = await venue.readIndexedPrice(landed[name].txid);
            liveStatus[name] = String(row.status);
            landed[name].liveRow = {
                version: Number(row.version), round_number: Number(row.round_number),
                batch_first_round: row.batch_first_round, batch_last_round: row.batch_last_round,
                round_count: row.round_count
            };
        }

        // --- 4. AT4's second half: the artifacts, captured before teardown -------
        const proposal = signerSet.proposals.find((p) => p.met === true);
        batchCanonical = (proposal && proposal.canonical) || null;
        // The indexer's OWN builder over the wire's own rounds. Compared with the
        // hub's below: producer and verifier agreeing on real bytes is what makes
        // everything after this a statement about the platform and not about a
        // canonical this file invented.
        rebuiltCanonical = ed25519.buildPriceBatchPayload(
            parsed.firstRound, parsed.lastRound, parsed.anchor, parsed.rounds);
        canonicalFromSigningRound = !!batchCanonical;
        if (!batchCanonical) batchCanonical = rebuiltCanonical;

        dual = findObservedDualSigner(venue, rounds, parsed, batchCanonical) ||
               signDualWithVenueIdentity(venue, parsed, batchCanonical);

        if (dual) {
            const id = identityFor(venue, dual.pubkey);
            // The counterfactual: the SAME two raw contents, re-wrapped under ONE
            // shared XORACLE key at the same anchor and re-signed by the same real
            // validator. This is the world before ENGINE_TAGS.ORACLE_BATCH existed.
            const rawRound = stripEquivHeader(dual.roundCanonical);
            const rawBatch = stripEquivHeader(dual.batchCanonical);
            const sharedA  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parsed.anchor, 0, rawRound);
            const sharedB  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, parsed.anchor, 0, rawBatch);
            counterfactual = id ? {
                pubkey: String(id.getPubkeyHex()).toLowerCase(),
                msgA: sharedA, sigA: id.sign(sharedA),
                msgB: sharedB, sigB: id.sign(sharedB)
            } : null;
        }

        // --- 5. the federation goes away --------------------------------------
        signerSet.stop(); signerSet = null;
        await venue.down(); venue = null;
        pinned.restore(); pinned = null;

        // --- 6. a node built from nothing reads the same chain ------------------
        replayNode = new OracleBatchReplayNode({
            label: 'tamper', hubDb: hubDb, basePort: 61200, priceGraceS: PRICE_GRACE_S });
        try { up = await replayNode.up(); }
        catch (err) { await bail('replay node failed to build: ' + (err && err.message)); this.skip(); return; }
        if (!up) { await bail(replayNode.unavailable); this.skip(); return; }

        console.log('  AT4: replay node built; replaying the chain to block ' + targetHeight + '...');
        await replayNode.waitForHeight(targetHeight);
        // The verdict is written inside the block transaction, but the hub push that
        // follows it is asynchronous; a short settle keeps a read from racing it.
        await new Promise((r) => setTimeout(r, 15_000));

        replayPriceRows = await replayNode.priceActions({ minBlock: minBlock });
        for (const name of Object.keys(landed)) {
            const at = replayPriceRows.filter((r) => Number(r.block_index) === landed[name].height);
            replayStatus[name] = (at.length === 1) ? String(at[0].status)
                : (at.length === 0 ? null : 'AMBIGUOUS(' + at.length + ' PRICE actions in block ' +
                    landed[name].height + ')');
        }

        // Supporting evidence, not the claim: the live node's own PRICE rows over the
        // same block range, read straight out of its database.
        try {
            liveDb = await resolveLiveIndexerDb('dogecoin', 'regtest');
            if (liveDb) {
                liveConn      = await connectTo(liveDb);
                livePriceRows = await readPriceActions(liveConn, liveDb.name, { minBlock: minBlock });
            } else {
                liveDbError = 'the stack hub carries no indexer database for dogecoin/regtest';
            }
        } catch (e) { liveDbError = (e && e.message) || String(e); }

        if (livePriceRows.length > 0) {
            const key = (r) => r.block_index + ':' + r.tx_index + ':' + r.tx_vout;
            const liveInRange = livePriceRows.filter((r) => Number(r.block_index) <= targetHeight);
            const replayByKey = new Map(replayPriceRows
                .filter((r) => Number(r.block_index) <= targetHeight).map((r) => [key(r), r]));
            priceRowDiff = { compared: 0, agreed: 0, disagreed: [], missing: [] };
            for (const l of liveInRange) {
                priceRowDiff.compared++;
                const r = replayByKey.get(key(l));
                if (!r) { priceRowDiff.missing.push(key(l)); continue; }
                if (String(r.status) === String(l.status)) priceRowDiff.agreed++;
                else priceRowDiff.disagreed.push({ at: key(l), live: String(l.status), replay: String(r.status) });
            }
        }

        // --- the run's evidence, printed once -----------------------------------
        console.log('\n  --- AT4: what actually landed and what each node made of it ---');
        console.log('  rounds driven      : ' + rounds.map((r) => r.round).join(', '));
        console.log('  honest wire        : ' + parsed.roundCount + ' round(s) [' + parsed.firstRound + '..' +
            parsed.lastRound + '] anchor ' + parsed.anchor + '  sigs ' + parsed.sigs.length +
            '  body ' + parsed.bodyBytes + 'B  compressed=' + parsed.compressed +
            (parsed.compressed ? ('  (' + parsed.compressedBytes + 'B on the wire)') : ''));
        for (const name of Object.keys(landed)) {
            const l = landed[name];
            console.log('  ' + name.padEnd(13) + ': block ' + l.height + '  ' + l.bytes + 'B  tx ' +
                String(l.txid).slice(0, 16) + (l.tamper ? ('  [' + l.tamper.field + ': "' +
                l.tamper.before + '" -> "' + l.tamper.after + '"]') : '  [untouched]'));
            console.log('                   stored v' + l.liveRow.version + ' round_number ' +
                l.liveRow.round_number + ' batch [' + l.liveRow.batch_first_round + '..' +
                l.liveRow.batch_last_round + '] count ' + l.liveRow.round_count);
            console.log('                   live   -> "' + liveStatus[name] + '"');
            console.log('                   replay -> "' + replayStatus[name] + '"');
        }
        console.log('  replay PRICE rows  : ' + replayPriceRows.length + ' -> ' +
            describeHistogram(statusHistogram(replayPriceRows)));
        if (priceRowDiff) {
            console.log('  live vs replay     : ' + priceRowDiff.compared + ' PRICE row(s) compared, agreed ' +
                priceRowDiff.agreed + ', disagreed ' + priceRowDiff.disagreed.length +
                ', missing ' + priceRowDiff.missing.length + ' (live db ' + liveDb.name + ')');
            for (const d of priceRowDiff.disagreed.slice(0, 10)) {
                console.log('    DISAGREE @' + d.at + '  live "' + d.live + '"  replay "' + d.replay + '"');
            }
        } else {
            console.log('  live vs replay     : live database not read (' + liveDbError + ')');
        }
        console.log('  dual signer        : ' + (dual ? (dual.pubkey.slice(0, 16) + '... (' + dual.source + ')')
            : 'NONE FOUND'));
        if (dual) {
            console.log('    round canonical  : ' + equivPrefixOf(dual.roundCanonical));
            console.log('    batch canonical  : ' + equivPrefixOf(dual.batchCanonical));
        }
        console.log('  ---------------------------------------------------------------\n');

        // --- 7. AT4's second half, driven -------------------------------------
        if (dual) {
            const proofBlock = parsed.anchor + 50;   // any height at/after the slot
            let h = slashHarness(dual.pubkey);
            honestProof = { status: await runSlashProof(h, 'price', dual.pubkey,
                dual.roundCanonical, dual.roundSig, dual.batchCanonical, dual.batchSig, proofBlock),
                calls: h.calls };

            // The same pair with the messages swapped: neither ordering may pair them.
            h = slashHarness(dual.pubkey);
            swappedProof = { status: await runSlashProof(h, 'price', dual.pubkey,
                dual.batchCanonical, dual.batchSig, dual.roundCanonical, dual.roundSig, proofBlock),
                calls: h.calls };

            if (counterfactual) {
                h = slashHarness(counterfactual.pubkey);
                sharedTagProof = { status: await runSlashProof(h, 'price', counterfactual.pubkey,
                    counterfactual.msgA, counterfactual.sigA,
                    counterfactual.msgB, counterfactual.sigB, proofBlock),
                    calls: h.calls };
            }

            console.log('  --- AT4: the slash decisions on those artifacts ---');
            console.log('  honest pair (XORACLE + XORACLEB) : "' + honestProof.status + '"  burns ' +
                honestProof.calls.burns.length);
            console.log('  same pair, order swapped         : "' + swappedProof.status + '"  burns ' +
                swappedProof.calls.burns.length);
            console.log('  counterfactual (ONE shared tag)  : ' + (sharedTagProof
                ? ('"' + sharedTagProof.status + '"  burns ' + sharedTagProof.calls.burns.length)
                : 'not built (no venue identity)'));
            console.log('  --------------------------------------------------\n');
        }
    });

    after(async function () {
        if (signerSet)  { try { signerSet.stop(); } catch (_) { /* teardown is best effort */ } }
        if (venue)      await venue.down();
        if (replayNode) await replayNode.down();
        if (liveConn)   { try { await liveConn.end(); } catch (_) { /* ditto */ } }
        if (hubDb)      await hubDb.stop();
        if (pinned)     pinned.restore();
    });

    // ---- half one: the tamper -------------------------------------------

    it('the window produced ONE genuinely signed batch, on a real quorum, before anything was touched', function () {
        assert.strictEqual(rounds.length, WINDOW_ROUNDS,
            'expected ' + WINDOW_ROUNDS + ' finalized rounds, got ' + rounds.length);
        assert.ok(parsed.ok, 'the honest wire does not parse: ' + parsed.reason);
        assert.strictEqual(parsed.roundCount, WINDOW_ROUNDS,
            'the honest batch covers ' + parsed.roundCount + ' round(s), not ' + WINDOW_ROUNDS);
        const distinct = new Set(parsed.sigs.map((s) => s.pubkey));
        assert.strictEqual(distinct.size, parsed.sigs.length, 'the honest wire carries a duplicate signer');
        assert.ok(distinct.size >= MIN_SIGNATURES,
            'SIGNING ROUND rung: the honest batch carries only ' + distinct.size + ' signature(s); a ' +
            'weighted quorum over ' + VALIDATORS + ' equal sources needs ' + MIN_SIGNATURES + '. There is ' +
            'no signed artifact to tamper with below that.');
        // Every signature on the wire verifies over the canonical the signing round
        // built. This is the baseline the tamper is measured against: it establishes
        // that what follows breaks something that was genuinely intact.
        let verified = 0;
        for (const s of parsed.sigs) if (ValidatorIdentity.verify(batchCanonical, s.sig, s.pubkey)) verified++;
        assert.strictEqual(verified, parsed.sigs.length,
            'only ' + verified + ' of ' + parsed.sigs.length + ' signatures on the honest wire verify ' +
            'against the batch canonical, so the batch was not intact before the tamper');
    });

    it('both tampered wires landed on the chain, in their own blocks, from the same rail', function () {
        for (const name of ['priceDigit', 'headerAnchor']) {
            const l = landed[name];
            assert.ok(l && /^[0-9a-f]{64}$/.test(String(l.txid)),
                'PUSH rung: the ' + name + ' tamper did not return a transaction id');
            assert.ok(Number.isFinite(l.height),
                'PUSH rung: the ' + name + ' tamper transaction ' + l.txid + ' is not in a block');
        }
        const heights = ['honest', 'priceDigit', 'headerAnchor'].map((n) => landed[n].height);
        assert.strictEqual(new Set(heights).size, heights.length,
            'two of this drill\'s three PRICE actions share a block (heights ' + heights.join(', ') +
            '), so a per-block verdict lookup cannot attribute them. Each broadcast waits for the ' +
            'previous one to be mined, so this means the chain reorganised or the miner batched them.');
    });

    it('the price-digit tamper is refused with the SAME status string on both nodes', function () {
        const live   = liveStatus.priceDigit;
        const replay = replayStatus.priceDigit;
        assert.ok(replay !== null,
            'the replaying node recorded NO PRICE action at block ' + landed.priceDigit.height +
            ', so it never judged the tampered wire at all');
        assert.ok(String(live).startsWith('invalid: '),
            'the live node recorded "' + live + '" for a batch whose body was altered after signing; ' +
            'a tampered batch must never be accepted');
        assert.strictEqual(replay, live,
            'CONSENSUS: the two nodes disagree about a tampered batch. Live recorded "' + live +
            '", the replaying node recorded "' + replay + '". Both walked the same block ' +
            landed.priceDigit.height + ' with the same bytes, so this is a fork in the PRICE parser.');
    });

    it('the header-anchor tamper is refused with the SAME status string on both nodes, and that ' +
       'string can only have come from the tamper', function () {
        const live   = liveStatus.headerAnchor;
        const replay = replayStatus.headerAnchor;
        assert.ok(replay !== null,
            'the replaying node recorded NO PRICE action at block ' + landed.headerAnchor.height);
        assert.strictEqual(live, ANCHOR_TAMPER_STATUS,
            'the live node recorded "' + live + '" for a batch whose header anchor was moved off the ' +
            'last round\'s anchor. Section 4 pins those equal and price.js checks it structurally, ' +
            'BEFORE the straddle rule and both quorum gates, so the expected verdict is "' +
            ANCHOR_TAMPER_STATUS + '". Anything else means the check moved or stopped running.');
        assert.strictEqual(replay, live,
            'CONSENSUS: live recorded "' + live + '" and the replaying node recorded "' + replay +
            '" for the same bytes in block ' + landed.headerAnchor.height);
    });

    it('the tamper, not the chain, is what the rejection is about [WAITING while the honest batch ' +
       'is still recording the capability-gap status]', function () {
        const honestLive = liveStatus.honest;
        if (honestLive === CAPABILITY_GAP_STATUS) {
            console.log('  AT4 discrimination assertion is WAITING, not failing. The honest batch on this ' +
                'chain recorded "' + honestLive + '", which is also what a body tamper earns at the ' +
                'stake-weighted quorum gate, so the two are indistinguishable on this run. The ' +
                'header-anchor tamper above is unaffected: its status "' + ANCHOR_TAMPER_STATUS + '" is ' +
                'reached before any capability is resolved and can only have come from the tamper. This ' +
                'assertion turns green with no edit to this file once an honest batch validates on DOGE.');
            this.skip();
            return;
        }
        assert.strictEqual(honestLive, 'valid',
            'the honest batch recorded "' + honestLive + '". Expected either "valid" or the known ' +
            'capability-gap status "' + CAPABILITY_GAP_STATUS + '"; anything else is a parse, fee or ' +
            'wire regression rather than the known gap, and it makes the tamper comparison unreadable.');
        for (const name of ['priceDigit', 'headerAnchor']) {
            assert.notStrictEqual(liveStatus[name], honestLive,
                'the ' + name + ' tamper recorded the same status "' + liveStatus[name] + '" as the ' +
                'UNTOUCHED batch, so nothing here is a statement about the tamper');
            assert.ok(String(liveStatus[name]).startsWith('invalid: '),
                'the ' + name + ' tamper recorded "' + liveStatus[name] + '" on a chain that accepts the ' +
                'honest batch, so a post-signing tamper is being absorbed');
        }
    });

    it('every PRICE action in the tampered block range reads the same on both nodes', function () {
        if (!priceRowDiff) {
            assert.fail('the live node\'s PRICE rows could not be read (' + liveDbError + '), so the ' +
                'range-wide half of the cross-node claim was never measured. The per-transaction ' +
                'assertions above still stand on the venue\'s own indexer read.');
        }
        assert.strictEqual(priceRowDiff.disagreed.length, 0,
            'CONSENSUS: ' + priceRowDiff.disagreed.length + ' of ' + priceRowDiff.compared +
            ' PRICE action(s) in blocks ' + minBlock + '..' + targetHeight + ' were decided differently ' +
            'by the live node and the replaying node: ' +
            priceRowDiff.disagreed.slice(0, 5).map((d) => d.at + ' live "' + d.live + '" replay "' +
                d.replay + '"').join('; '));
        assert.strictEqual(priceRowDiff.missing.length, 0,
            'the replaying node holds no PRICE action at ' + priceRowDiff.missing.slice(0, 5).join(', ') +
            ', which the live node decided; a batch the chain carries must be judged by every node ' +
            'that walks it, valid or not');
        assert.ok(priceRowDiff.compared >= 3,
            'only ' + priceRowDiff.compared + ' PRICE action(s) were compared, but this drill landed 3');
    });

    // ---- half two: slash safety -----------------------------------------

    it('one real validator signed BOTH a per-round canonical and the batch canonical at one anchor', function () {
        assert.ok(dual,
            'no validator could be shown to have signed both a per-round canonical and the batch ' +
            'canonical, so AT4\'s second half has no premise to test. The round signatures come from ' +
            'the round:finalized event and the batch signatures from the landed wire; an empty ' +
            'intersection means one of those sets is empty or verifies against different bytes.');
        // Producer and verifier agree on the batch bytes, on real data. Vacuous if the
        // signing round never handed over a canonical, so that is asserted first.
        assert.ok(canonicalFromSigningRound,
            'the batch canonical came from this file rebuilding it rather than from the signing round ' +
            'that actually produced it, so the producer/verifier equality below compares the indexer ' +
            'to itself');
        assert.strictEqual(dual.batchCanonical, rebuiltCanonical,
            'the hub\'s signing round and the indexer\'s buildPriceBatchPayload produced DIFFERENT ' +
            'canonical bytes for the same landed batch; every signature on the wire would fail on ' +
            'one side of that pair');
        assert.ok(ValidatorIdentity.verify(dual.roundCanonical, dual.roundSig, dual.pubkey),
            'the per-round signature does not verify over the per-round canonical');
        assert.ok(ValidatorIdentity.verify(dual.batchCanonical, dual.batchSig, dual.pubkey),
            'the batch signature does not verify over the batch canonical');
        // The tags, and the window inside the batch round id, are the whole defence.
        assert.ok(dual.roundCanonical.startsWith(
            'EQUIV|' + eq.ENGINE_TAGS.ORACLE + '|' + parsed.anchor + '|0||'),
            'the per-round canonical is not XORACLE-tagged at the anchor: ' + equivPrefixOf(dual.roundCanonical));
        assert.ok(dual.batchCanonical.startsWith(
            'EQUIV|' + eq.ENGINE_TAGS.ORACLE_BATCH + '|' + parsed.anchor + '|' + parsed.firstRound + '|' +
            parsed.lastRound + '|0||'),
            'the batch canonical is not XORACLEB-tagged with the window in its round id: ' +
            equivPrefixOf(dual.batchCanonical));
        assert.notStrictEqual(equivPrefixOf(dual.roundCanonical), equivPrefixOf(dual.batchCanonical),
            'the two canonicals share an EQUIV key prefix, which is exactly the collision the distinct ' +
            'engine tag exists to prevent');
    });

    it('that validator is NOT slashable: the proof is refused and no bond is burned', function () {
        assert.ok(honestProof, 'no slash decision was reached for the honest pair');
        assert.strictEqual(honestProof.status, TAG_SEPARATION_STATUS,
            'SLASH recorded "' + honestProof.status + '" for a validator that signed one honest ' +
            'per-round canonical and one honest batch at the same anchor. Expected "' +
            TAG_SEPARATION_STATUS + '": the two carry different engine tags, so they cannot share an ' +
            'equiv key and cannot be paired as equivocation.');
        assert.strictEqual(honestProof.calls.burns.length, 0,
            'a bond was burned for an honest validator (' + honestProof.calls.burns.length + ' burn call(s))');
        assert.strictEqual(honestProof.calls.events.length, 0,
            'a capability_slash_event was written for an honest validator, which disqualifies its key ' +
            'from every capability permanently');
        // Order must not matter: whichever message the submitter puts first, the
        // prefix comes from MSG_A and the other cannot match it.
        assert.strictEqual(swappedProof.status, TAG_SEPARATION_STATUS,
            'with the two messages swapped SLASH recorded "' + swappedProof.status + '", so the refusal ' +
            'depends on which one the submitter names first');
        assert.strictEqual(swappedProof.calls.burns.length, 0,
            'swapping the message order burned a bond');
    });

    it('the distinct tag is the ONLY thing preventing that burn: under one shared tag the same ' +
       'signatures DO slash', function () {
        assert.ok(sharedTagProof,
            'the counterfactual was never built, so the refusal above is unfalsified: a harness that ' +
            'refuses everything would produce the same result');
        assert.strictEqual(sharedTagProof.status, 'valid',
            'the counterfactual recorded "' + sharedTagProof.status + '" rather than "valid". The two ' +
            'contents are the same real bodies, signed by the same real validator, wrapped under ONE ' +
            'XORACLE key at one anchor. If this does not slash, the assertion above proves nothing ' +
            'about the tag, because the harness refuses genuine equivocation too.');
        assert.strictEqual(sharedTagProof.calls.burns.length, 1,
            'the counterfactual reached "valid" without burning a bond (' +
            sharedTagProof.calls.burns.length + ' burn call(s))');
        assert.strictEqual(sharedTagProof.calls.events.length, 1,
            'the counterfactual burned without writing the capability_slash_event that makes the ' +
            'disqualification permanent');
        // The slot resolved at the BATCH ANCHOR, which is what makes the membership
        // lookup, and therefore the burn, a pure function of the proof.
        const lookup = sharedTagProof.calls.capabilityLookups.find((c) => c.capability === 'price');
        assert.ok(lookup, 'the counterfactual never resolved the `price` capability set');
        assert.strictEqual(Number(lookup.block), parsed.anchor,
            'membership resolved at block ' + lookup.block + ' rather than at the batch anchor ' +
            parsed.anchor + ', so the burn is not a pure function of the proof');
    });
});
