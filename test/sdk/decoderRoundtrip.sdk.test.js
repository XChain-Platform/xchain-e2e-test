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
 * XChain Platform E2E - sdk.decoder against the live chain
 *
 * The SDK decoder module (sdk.decoder.parse / describe, and the PSBT
 * extraction the MuSig2 co-signer signs against) is pinned by unit
 * suites in xchain-sdk against locally composed action strings. Those
 * prove the SDK agrees with ITSELF. This suite proves it agrees with
 * the CHAIN, on two lanes:
 *
 *   1. Corpus replay (read-only). Every recent action the indexer
 *      recorded is re-parsed from the exact wire bytes the
 *      authoritative decoder recovered from the OP_RETURN (`tx_data`).
 *      parse() must agree with the indexer on the action, the version
 *      and the field values, and must be a canonicalization fixpoint
 *      on real wire bytes. A parse that quietly disagrees here is a
 *      co-signer that signs something other than what indexes.
 *
 *   2. Live round-trip (writes to chain). compose -> live encoder ->
 *      real PSBT over real UTXOs -> extract the action string back out
 *      of the PSBT -> parse -> broadcast -> compare against what the
 *      indexer decoded off the confirmed transaction. The extraction
 *      runs inside a custom `signer`, i.e. at the exact point a
 *      hardware/co-signer wallet reads the payload it is about to
 *      sign.
 *
 * Read-only lane 1 is safe to run against a shared venue at any time.
 * Lane 2 broadcasts a handful of small actions on regtest.
 *
 * Run (NFS tree, Node 22):
 *
 *     npm run test:sdk:decoder
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, fundedSdkAddress,
        uniqueTick, submitOpts, loadSDK } = require('./sdkHelper');

const { decoder } = loadSDK();

// How far back through the action index the corpus lane walks. Every row is
// one explorer round trip, so this trades runtime for coverage.
const CORPUS_SIZE = Number(process.env.DECODER_CORPUS_SIZE || 250);

function haveConnectors() {
    return global.regtestMinerConnector && global.utxoTrackerConnector && global.nodeConnector;
}

// A `^<id>` value is the compacted wire form of a ticker or an address; the
// indexer reports the resolved name instead, so the two are not comparable
// as strings (the equivalence itself is covered by ticker-id-equivalence).
function compacted(value) {
    return typeof value === 'string' && value.startsWith('^');
}

function firstOf(value) {
    return Array.isArray(value) ? value[0] : value;
}

// The indexer's own decode of the first action of a confirmed transaction.
function indexedDetails(res) {
    const actions = (res && res.indexed && res.indexed.actions) || [];
    return (actions[0] && actions[0].details) || {};
}

// One transaction can produce several action rows, and only ONE of them
// carried the wire string. Every other row is DERIVED: it never had a string
// of its own, so the explorer serves it the parent transaction's `tx_data`
// rather than inventing one (xchain-explorer db.js: "a VM-emitted action has
// no wire string of its own... inventing a wire form that was never broadcast
// would be worse than the ambiguity"). The corpus lane therefore sees the
// parent's bytes hanging off a row whose own COLUMNS describe the derived
// action, and those columns are not comparable to the wire fields.
//
// The canonical example, RLTC block 1461, is the divergence this lane was
// reporting as an SDK/indexer disagreement: a SEND to an open dispenser
// writes the SEND row plus a DISPENSE payout row on the same tx_hash. The
// SEND row's `destination` is the dispenser (exactly what the wire says); the
// DISPENSE row's `destination` is the buyer being paid out. Each row is right
// about its own action, and neither decoder nor indexer is wrong - the lane
// was simply reading the payout row's columns against the SEND's bytes.
//
// Derived rows come from two places, and the two are recognised differently:
//
//   1. VM EMISSIONS, which the explorer marks explicitly: a non-null
//      `emitted_by` naming the parent EXECUTE's action_index and the
//      emission's position. Any action the VM can emit shows up this way, so
//      there is no name list to keep - the marker IS the evidence, and the
//      row is anchored to the parent EXECUTE's `emissions` manifest below.
//
//   2. INDEXER-DERIVED rows, which carry no such marker and have to be
//      recognised by name:
//        - a SWEEP re-homes every object the address owns, so besides its own
//          row it writes one derived row per swept object - a token ownership
//          transfer lands as an ISSUE row whose tx_data is still the SWEEP
//          wire string (regtest action_index 993, same tx_hash as the SWEEP
//          row 992);
//        - a SEND whose DESTINATION is an open dispenser pays that dispenser
//          out, and the payout is its own DISPENSE row on the same tx_hash
//          (indexer utility.processDispenserSends).
//
// Two more name divergences are NOT derived rows - they are the wire row
// under a display name, so their columns stay comparable to the wire:
// a DISPENSER v1/v2 indexes as DISPENSER_CANCEL / DISPENSER_EDIT, and each
// sub-action of a BATCH gets its own row carrying the whole BATCH string.
//
// Anything outside all of that means parse() and the indexer read the same
// bytes differently, which is the failure this lane exists to catch.
const DERIVED_ROW_ACTIONS = {
    SWEEP: ['ISSUE', 'DISPENSER', 'SEND'],
    SEND:  ['DISPENSE'],
};

// The parent EXECUTE's action_index for a VM-emitted row, or null.
function emittedFrom(row) {
    const e = row && row.emitted_by;
    if (!e || e.execution_index === null || e.execution_index === undefined) return null;
    return String(e.execution_index);
}

// Every action name a parse can legitimately show up under as an
// indexer-derived row. A BATCH is included through its sub-actions: a batched
// SEND to a dispenser emits the same DISPENSE row a top-level one does, and
// the row then carries the whole BATCH string as tx_data.
function derivedActionsFor(parsed) {
    const out = new Set(DERIVED_ROW_ACTIONS[parsed.action] || []);
    if (parsed.action === 'BATCH' && Array.isArray(parsed.commands))
        for (const c of parsed.commands)
            if (c.ok) for (const a of (DERIVED_ROW_ACTIONS[c.action] || [])) out.add(a);
    return out;
}

// True when the row exists only because the VM or the indexer derived it from
// the action the wire bytes actually carry.
function isDerivedRow(row, parsed) {
    if (emittedFrom(row)) return true;
    const rowAction = String(row.action);
    if (rowAction === parsed.action) return false;
    if (rowAction.startsWith(parsed.action + '_')) return false;
    if (parsed.action === 'BATCH' && Array.isArray(parsed.commands) &&
        parsed.commands.some(c => c.ok && c.action === rowAction)) return false;
    return derivedActionsFor(parsed).has(rowAction);
}

// A VM-emitted row's name is the EMITTED action and is unrelated to the wire
// action by design, so the name check passes it through; the emission is
// pinned against the parent EXECUTE's own manifest instead.
function indexerNameMatches(row, parsed) {
    if (emittedFrom(row)) return true;
    const rowAction = String(row.action);
    if (rowAction === parsed.action) return true;
    if (rowAction.startsWith(parsed.action + '_')) return true;
    if (parsed.action === 'BATCH' && Array.isArray(parsed.commands) &&
        parsed.commands.some(c => c.ok && c.action === rowAction)) return true;
    return derivedActionsFor(parsed).has(rowAction);
}

describe('[sdk] decoder.parse vs the live chain', function () {
    this.timeout(0);

    let sdk, FORMATS;

    before(function () {
        // Address compaction off, matching the other SDK suites: a `^<id>`
        // DESTINATION is rejected on a chain that has not seen the address.
        sdk = makeSdk({ compactAddresses: false });
        FORMATS = {};
        for (const action of sdk.getActions()) FORMATS[action] = sdk.getActionFormats(action) || {};
    });

    // =====================================================================
    // Lane 1: corpus replay (read-only)
    //
    // Declared per chain. The venue's explorer serves all three regtest
    // chains, and the decoder is chain-agnostic, so the same replay runs
    // against each: the action mixes differ (LTC/DOGE carry the native-fee
    // and cross-chain traffic BTC does not), which is free coverage. A chain
    // the venue does not serve skips rather than fails.
    // =====================================================================
    function corpusLane(label, network) {
    describe('corpus replay [' + label + ']: re-parse what the chain already carries', function () {

        const rows = [];

        before(async function () {
            const chainSdk = network ? makeSdk({ network, compactAddresses: false }) : sdk;
            let list;
            try {
                const latest = await chainSdk.explorer.getActions({ limit: 1 });
                list = (latest && latest.data) || latest || [];
            } catch (e) { list = []; }
            if (!list.length) {
                console.log('    [sdk] corpus [' + label + ']: no actions served, skipping');
                return this.skip();
            }

            let index = Number(list[0].action_index);
            while (index > 0 && rows.length < CORPUS_SIZE) {
                let row = null;
                try { row = await chainSdk.explorer.getAction(index); } catch (e) { row = null; }
                // tx_data is empty for actions the VM/indexer synthesized on a
                // transaction that carried no OP_RETURN at all (a DISPENSE
                // triggered by a plain coin send); there is no wire string to
                // re-parse. A synthesized action on a transaction that DID carry
                // one (a DISPENSE triggered by a token SEND) is served the parent
                // transaction's string instead, and stays in the corpus: those
                // bytes are real, they just belong to the parent row. See
                // DERIVED_ROW_ACTIONS.
                if (row && typeof row.tx_data === 'string' && row.tx_data !== '') rows.push(row);
                index--;
            }
            console.log('    [sdk] corpus [' + label + ']: ' + rows.length +
                        ' on-chain actions with wire data, newest index ' + list[0].action_index);
            expect(rows.length, 'corpus is non-empty').to.be.greaterThan(0);
        });

        it('every valid on-chain action string parses', function () {
            const misses = [];
            for (const row of rows) {
                const wireAction  = String(row.tx_data).split('|')[0];
                const canonical   = decoder.ACTION_ALIASES[wireAction] || wireAction;
                const wireVersion = Number(String(row.tx_data).split('|')[1]);
                const encodable   = FORMATS[canonical] && FORMATS[canonical][wireVersion] !== undefined;
                const status      = String(row.status || '');
                if (!encodable || status !== 'valid') continue;
                const parsed = decoder.parse(row.tx_data);
                if (!parsed.ok) misses.push(row.action_index + ' ' + row.tx_data.slice(0, 60) +
                                            ' -> ' + parsed.reason);
            }
            expect(misses, 'valid on-chain actions decoder.parse refused').to.deep.equal([]);
        });

        it('parse never disagrees with the indexer about the action or version', function () {
            const misses = [];
            for (const row of rows) {
                const parsed = decoder.parse(row.tx_data);
                if (!parsed.ok) continue;
                const wire = String(row.tx_data).split('|');
                const expectedAction = decoder.ACTION_ALIASES[wire[0]] || wire[0];
                if (parsed.action !== expectedAction)
                    misses.push(row.action_index + ' action ' + parsed.action + ' != wire ' + expectedAction);
                if (parsed.version !== Number(wire[1]))
                    misses.push(row.action_index + ' version ' + parsed.version + ' != wire ' + wire[1]);
                // A derived row has no wire format of its own. The indexer writes
                // whatever `FORMAT` its data object carried: NULL where the row was
                // built fresh (a DISPENSE), the parent's format where the derived row
                // reuses the parent's object (a SWEEP's ISSUE). Anything else means
                // the row claims a format the wire never stated.
                if (isDerivedRow(row, parsed)) {
                    if (row.action_format !== null && row.action_format !== undefined &&
                        Number(row.action_format) !== Number(wire[1]))
                        misses.push(row.action_index + ' derived ' + row.action +
                                    ' action_format ' + row.action_format + ' != wire ' + wire[1]);
                } else if (Number(row.action_format) !== Number(wire[1])) {
                    misses.push(row.action_index + ' indexer action_format ' + row.action_format +
                                ' != wire ' + wire[1]);
                }
                if (!indexerNameMatches(row, parsed))
                    misses.push(row.action_index + ' indexer action ' + row.action +
                                ' unrelated to parsed ' + parsed.action);
            }
            expect(misses, 'parse/indexer disagreements').to.deep.equal([]);
        });

        it('parse is a canonicalization fixpoint on real wire bytes', function () {
            const misses = [];
            for (const row of rows) {
                const p1 = decoder.parse(row.tx_data);
                if (!p1.ok) continue;
                const p2 = decoder.parse(p1.actionString);
                if (!p2.ok) { misses.push(row.action_index + ' re-parse refused: ' + p2.reason); continue; }
                if (p2.actionString !== p1.actionString)
                    misses.push(row.action_index + ' canonical drift ' +
                                JSON.stringify(p1.actionString) + ' -> ' + JSON.stringify(p2.actionString));
                try { expect(p2.params).to.deep.equal(p1.params); }
                catch (e) { misses.push(row.action_index + ' param drift on re-parse'); }
            }
            expect(misses, 'fixpoint violations').to.deep.equal([]);
        });

        it('parsed field values agree with the values the indexer recorded', function () {
            const misses = [];
            for (const row of rows) {
                const parsed = decoder.parse(row.tx_data);
                if (!parsed.ok || parsed.action === 'BATCH') continue;
                // A derived row's columns describe the DERIVED action, not the wire
                // one whose bytes it borrowed; see DERIVED_ROW_ACTIONS. The wire
                // fields are checked against the parent row in the next test.
                if (isDerivedRow(row, parsed)) continue;
                const check = (field, indexed) => {
                    const got = firstOf(parsed.params[field]);
                    if (got === undefined || got === '' || compacted(got)) return;
                    if (indexed === null || indexed === undefined || indexed === '') return;
                    if (String(got) !== String(indexed))
                        misses.push(row.action_index + ' ' + parsed.action + ' ' + field + ' wire=' +
                                    JSON.stringify(got) + ' indexer=' + JSON.stringify(indexed));
                };
                check('TICK', row.tick);
                check('DESTINATION', row.destination);
                check('MEMO', row.memo);
            }
            expect(misses, 'wire/indexer field disagreements').to.deep.equal([]);
        });

        // The check the previous test hands off. Skipping a derived row there
        // would otherwise buy silence: the wire bytes still have to agree with
        // SOMETHING the indexer recorded, and the row they belong to is the
        // parent on the same tx_hash. This is where a real SDK-vs-indexer
        // divergence on a dispenser-triggering SEND would surface - the wire
        // DESTINATION must equal the destination the parent SEND row resolved,
        // one destination on both sides, even though the DISPENSE row beside it
        // names the buyer instead.
        it('derived rows agree with the parent row the wire bytes belong to', function () {
            const byTx    = new Map();
            const byIndex = new Map();
            for (const row of rows) {
                const key = String(row.tx_hash);
                if (!byTx.has(key)) byTx.set(key, []);
                byTx.get(key).push(row);
                byIndex.set(String(row.action_index), row);
            }

            const misses = [];
            let anchored = 0, emissions = 0;
            for (const row of rows) {
                const parsed = decoder.parse(row.tx_data);
                if (!parsed.ok) continue;
                if (!isDerivedRow(row, parsed)) continue;

                // A VM emission names its parent outright. The parent EXECUTE is
                // only in the corpus when the window reached back far enough; a
                // truncated window is not a failure.
                const execIndex = emittedFrom(row);
                if (execIndex) {
                    const parent = byIndex.get(execIndex);
                    if (!parent) continue;
                    emissions++;
                    if (String(parent.tx_data) !== String(row.tx_data))
                        misses.push(row.action_index + ' emission carries tx_data its EXECUTE (' +
                                    execIndex + ') does not: ' + JSON.stringify(row.tx_data) +
                                    ' vs ' + JSON.stringify(parent.tx_data));
                    if (String(parent.action) !== parsed.action)
                        misses.push(row.action_index + ' emission parent ' + execIndex +
                                    ' is a ' + parent.action + ', not the wire ' + parsed.action);
                    // The parent's emission manifest has to claim this row, or the
                    // bytes and the row were joined by nothing but a shared tx_hash.
                    const manifest = Array.isArray(parent.emissions) ? parent.emissions : [];
                    const claim = manifest.find(m => String(m.action_index) === String(row.action_index));
                    if (!claim)
                        misses.push(row.action_index + ' ' + row.action +
                                    ' claims emission from EXECUTE ' + execIndex +
                                    ' but that row lists ' + JSON.stringify(manifest.map(m => m.action_index)));
                    else if (String(claim.emitted_action) !== String(row.action))
                        misses.push(row.action_index + ' EXECUTE ' + execIndex + ' lists it as ' +
                                    claim.emitted_action + ', indexed as ' + row.action);
                    continue;
                }

                // An indexer-derived row has no such marker: its parent is the row
                // on the same transaction whose action IS the wire action.
                const siblings = byTx.get(String(row.tx_hash)) || [];
                const parent = siblings.find(r => String(r.action) === parsed.action);
                if (!parent) continue;

                if (String(parent.tx_data) !== String(row.tx_data)) {
                    misses.push(row.action_index + ' derived ' + row.action +
                                ' carries tx_data the parent ' + parent.action + ' (' +
                                parent.action_index + ') does not: ' +
                                JSON.stringify(row.tx_data) + ' vs ' + JSON.stringify(parent.tx_data));
                    continue;
                }

                anchored++;
                const check = (field, indexed) => {
                    const got = firstOf(parsed.params[field]);
                    if (got === undefined || got === '' || compacted(got)) return;
                    if (indexed === null || indexed === undefined || indexed === '') return;
                    if (String(got) !== String(indexed))
                        misses.push(row.action_index + ' derived ' + row.action + ': wire ' + field +
                                    '=' + JSON.stringify(got) + ' but parent ' + parsed.action + ' (' +
                                    parent.action_index + ') recorded ' + JSON.stringify(indexed));
                };
                check('TICK', parent.tick);
                check('DESTINATION', parent.destination);
                check('MEMO', parent.memo);
            }
            if (anchored || emissions)
                console.log('    [sdk] corpus [' + label + ']: ' + anchored +
                            ' indexer-derived row(s) anchored to their parent, ' +
                            emissions + ' VM emission(s) pinned to their EXECUTE');
            expect(misses, 'derived-row/parent disagreements').to.deep.equal([]);
        });

        it('describe() renders every on-chain action', function () {
            const misses = [];
            for (const row of rows) {
                const parsed = decoder.parse(row.tx_data);
                if (!parsed.ok) continue;
                let d;
                try { d = decoder.describe(parsed); }
                catch (e) { misses.push(row.action_index + ' describe threw: ' + e.message); continue; }
                if (!d || typeof d.summary !== 'string' || d.summary === '')
                    misses.push(row.action_index + ' ' + parsed.action + ' empty summary');
                if (!Array.isArray(d.details) || !Array.isArray(d.warnings))
                    misses.push(row.action_index + ' ' + parsed.action + ' malformed describe result');
            }
            expect(misses, 'describe failures on live actions').to.deep.equal([]);
        });
    });
    }

    // The chain this run is pointed at, then the venue's other two.
    corpusLane('run network', null);
    corpusLane('litecoin-regtest', 'litecoin-regtest');
    corpusLane('dogecoin-regtest', 'dogecoin-regtest');

    // =====================================================================
    // Lane 2: live round-trip (compose -> encoder -> PSBT -> chain)
    // =====================================================================
    describe('live round-trip: compose -> encoder PSBT -> parse -> chain', function () {

        let issuer, recipient, tick;

        before(async function () {
            if (!haveConnectors()) this.skip();
            issuer    = await fundedGasAddress(sdk, 1);
            recipient = await fundedSdkAddress(sdk, 1);
            tick      = uniqueTick('DEC');
            const res = await roundTrip('ISSUE',
                { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'decoder round-trip', mintSupply: 1000 });
            expect(res.indexed.status, 'ISSUE indexed').to.equal('valid');
            console.log('    [sdk] issuer=' + issuer.address + ' tick=' + tick);
        });

        // Submit through the SDK with a signer that intercepts the unsigned PSBT
        // the encoder built, recovers the action string from it exactly as the
        // co-signer does, and only then signs. Every decoder assertion is made
        // against bytes that really went on chain.
        async function roundTrip(action, params) {
            const capture = {};
            const res = await submit(sdk,
                { action, params },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({
                    wif: issuer.wif,
                    signer: function (psbtHex, meta) {
                        capture.psbtHex  = psbtHex;
                        capture.encoding = meta && meta.encoding;
                        capture.extract  = decoder.decodeActionStringFromPsbt(psbtHex);
                        capture.full     = decoder.decodeActionFromPsbt(psbtHex);
                        return sdk.wallet.signPsbt(psbtHex, issuer.wif);
                    },
                }));

            // The co-signer's byte recovery must succeed on the encoder's real output.
            expect(capture.extract && capture.extract.ok,
                'PSBT extraction: ' + JSON.stringify(capture.extract)).to.equal(true);
            // and it must be exactly what the SDK composed - no encoder-side rewrite.
            expect(capture.extract.actionString, 'wire bytes == composed action string')
                .to.equal(res.actionString);

            const parsed = decoder.parse(capture.extract.actionString);
            expect(parsed.ok, 'parse of the on-wire bytes: ' + JSON.stringify(parsed)).to.equal(true);
            expect(parsed.action,  'parsed action').to.equal(res.action);
            expect(parsed.version, 'parsed version').to.equal(res.version);
            // Canonicalization is a fixpoint on the real wire bytes.
            expect(parsed.actionString, 'canonical == wire').to.equal(capture.extract.actionString);

            // The full co-signer decode either agrees or fails closed; it must
            // never report a DIFFERENT action from the one that indexes.
            if (capture.full && capture.full.ok) {
                expect(capture.full.action,  'co-signer decode action').to.equal(parsed.action);
                expect(capture.full.version, 'co-signer decode version').to.equal(parsed.version);
            }

            // And the authoritative on-chain decoder recovered the same bytes.
            expect(res.indexed.tx_data, 'indexer tx_data == wire bytes')
                .to.equal(capture.extract.actionString);

            const described = decoder.describe(parsed);
            expect(described.summary, 'describe summary').to.be.a('string').and.to.not.equal('');

            res.capture = capture;
            res.parsed  = parsed;
            return res;
        }

        it('MINT round-trips through the encoder, the PSBT and the indexer', async function () {
            const res = await roundTrip('MINT', { tick, amount: 500, destination: issuer.address });
            expect(res.indexed.status).to.equal('valid');
            expect(Number(firstOf(res.parsed.params.AMOUNT))).to.equal(500);
            // Ticker compaction is on by default, so the wire carries `^<id>`;
            // what matters is that the id the chain resolved is our token.
            const wireTick = firstOf(res.parsed.params.TICK);
            if (compacted(wireTick)) expect(indexedDetails(res).tick, 'compacted tick resolved').to.equal(tick);
            else expect(wireTick).to.equal(tick);
        });

        it('SEND with a memo round-trips (multi-field, rest-of-string memo)', async function () {
            const res = await roundTrip('SEND',
                { tick, amount: 100, destination: recipient.address, memo: 'xc549 round trip' });
            expect(res.indexed.status).to.equal('valid');
            expect(firstOf(res.parsed.params.DESTINATION)).to.equal(recipient.address);
            expect(res.parsed.params.MEMO).to.equal('xc549 round trip');
        });

        it('BROADCAST round-trips (free-text payload)', async function () {
            const res = await roundTrip('BROADCAST',
                { message: 'xc549 decoder verification', value: 0 });
            expect(res.indexed.status).to.equal('valid');
        });

        it('DESTROY round-trips', async function () {
            const res = await roundTrip('DESTROY', { tick, amount: 50, memo: 'xc549 burn' });
            expect(res.indexed.status).to.equal('valid');
        });

        it('ADDRESS round-trips (numeric-only fields)', async function () {
            const res = await roundTrip('ADDRESS', { feePreference: 2, requireMemo: 1 });
            expect(res.indexed.status).to.equal('valid');
        });

        it('BATCH round-trips and every sub-action survives the nested blob', async function () {
            // A MINT plus a DESTROY, not two SENDs: a batch of SENDs carries
            // two addresses and no longer fits an inline OP_RETURN, and the
            // encoder then switches to the P2SH two-phase carrier the PSBT
            // decoder refuses by design (covered on the chain lane below).
            // Two MINTs are not an option either - BATCH allows only one.
            const built = await sdk.batch()
                .mint({ tick, amount: 10 })
                .destroy({ tick, amount: 20 })
                .build();

            const res = await roundTrip('BATCH', { command: built.fields.COMMAND });
            expect(res.indexed.status).to.equal('valid');
            expect(res.parsed.commands, 'two sub-actions parsed').to.have.length(2);
            for (const cmd of res.parsed.commands) expect(cmd.ok, JSON.stringify(cmd)).to.equal(true);
            expect(res.parsed.commands.map(c => c.action)).to.deep.equal(['MINT', 'DESTROY']);
            expect(Number(firstOf(res.parsed.commands[0].params.AMOUNT))).to.equal(10);
            expect(Number(firstOf(res.parsed.commands[1].params.AMOUNT))).to.equal(20);
        });

        it('a P2SH-carried BATCH of SENDs still parses off the chain', async function () {
            // Oversized actions ride the P2SH two-phase carrier, which the
            // co-signer's PSBT decoder fails closed on (the params live in the
            // reveal, not the funding PSBT). parse() still has to agree with
            // what the indexer recovered from the reveal transaction.
            const r1 = sdk.generateKeyPair();
            const a1 = sdk.deriveAddress(r1.publicKey, { type: 'p2pkh' });
            const r2 = sdk.generateKeyPair();
            const a2 = sdk.deriveAddress(r2.publicKey, { type: 'p2pkh' });

            const built = await sdk.batch()
                .send({ tick, amount: 10, destination: a1 })
                .send({ tick, amount: 20, destination: a2 })
                .build();

            const res = await submit(sdk,
                { action: 'BATCH', params: { command: built.fields.COMMAND } },
                { pubkey: issuer.address, change: issuer.address },
                submitOpts({ wif: issuer.wif }));
            expect(res.indexed.status, 'BATCH indexed').to.equal('valid');
            expect(res.indexed.tx_data, 'indexer recovered the composed wire bytes')
                .to.equal(res.actionString);

            const parsed = decoder.parse(res.indexed.tx_data);
            expect(parsed.ok, JSON.stringify(parsed)).to.equal(true);
            expect(parsed.action).to.equal('BATCH');
            expect(parsed.commands).to.have.length(2);
            expect(parsed.commands.map(c => c.action)).to.deep.equal(['SEND', 'SEND']);
            expect(firstOf(parsed.commands[0].params.DESTINATION)).to.equal(a1);
            expect(firstOf(parsed.commands[1].params.DESTINATION)).to.equal(a2);
            expect(parsed.actionString, 'canonical == wire').to.equal(res.indexed.tx_data);
        });

        it('the indexer decoded the same actions parse() reported', async function () {
            // Re-read each action this suite put on chain straight from the
            // explorer and re-parse its recorded wire bytes: the chain's own
            // copy, not the one held in memory since compose time.
            const list = await sdk.explorer.getActions({ limit: 100 });
            const recent = ((list && list.data) || list || [])
                .filter(r => r.source === issuer.address);
            expect(recent.length, 'explorer sees this suite\'s actions').to.be.greaterThan(0);
            for (const row of recent) {
                const full = await sdk.explorer.getAction(row.action_index);
                if (!full || !full.tx_data) continue;
                const parsed = decoder.parse(full.tx_data);
                expect(parsed.ok, full.action_index + ' ' + full.tx_data).to.equal(true);
                expect(indexerNameMatches(full, parsed),
                    full.action_index + ' indexer=' + full.action + ' parsed=' + parsed.action).to.equal(true);
                expect(parsed.version, full.action_index + ' version').to.equal(Number(full.action_format));
            }
        });
    });
});
