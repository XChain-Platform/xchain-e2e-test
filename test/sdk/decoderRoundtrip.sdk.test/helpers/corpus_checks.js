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
const { compacted, firstOf, emittedFrom, isDerivedRow, indexerNameMatches } =
    require('./decoder_roundtrip');

function validStringsParse (rows, FORMATS, decoder) {
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
}

function actionAndVersionMatch (rows, FORMATS, decoder) {
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
}

function canonicalizationIsStable (rows, FORMATS, decoder) {
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
}

function fieldValuesMatch (rows, FORMATS, decoder) {
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
}

        // The check the previous test hands off. Skipping a derived row there
        // would otherwise buy silence: the wire bytes still have to agree with
        // SOMETHING the indexer recorded, and the row they belong to is the
        // parent on the same tx_hash. This is where a real SDK-vs-indexer
        // divergence on a dispenser-triggering SEND would surface - the wire
        // DESTINATION must equal the destination the parent SEND row resolved,
        // one destination on both sides, even though the DISPENSE row beside it
        // names the buyer instead.
function checkEmissionRow (row, parsed, byIndex, misses) {
    // A VM emission names its parent outright. The parent EXECUTE is
    // only in the corpus when the window reached back far enough; a
    // truncated window is not a failure.
    const execIndex = emittedFrom(row);
    const parent = byIndex.get(execIndex);
    if (!parent) return 0;
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
    return 1;
}

function checkIndexerDerivedRow (row, parsed, byTx, misses) {
    // An indexer-derived row has no such marker: its parent is the row
    // on the same transaction whose action IS the wire action.
    const siblings = byTx.get(String(row.tx_hash)) || [];
    const parent = siblings.find(r => String(r.action) === parsed.action);
    if (!parent) return 0;

    if (String(parent.tx_data) !== String(row.tx_data)) {
        misses.push(row.action_index + ' derived ' + row.action +
                    ' carries tx_data the parent ' + parent.action + ' (' +
                    parent.action_index + ') does not: ' +
                    JSON.stringify(row.tx_data) + ' vs ' + JSON.stringify(parent.tx_data));
        return 0;
    }

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
    return 1;
}

function derivedRowsMatchParents (rows, FORMATS, decoder, label) {
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
    if (emittedFrom(row)) {
        emissions += checkEmissionRow(row, parsed, byIndex, misses);
        continue;
    }
    anchored += checkIndexerDerivedRow(row, parsed, byTx, misses);
}
if (anchored || emissions)
    console.log('    [sdk] corpus [' + label + ']: ' + anchored +
                ' indexer-derived row(s) anchored to their parent, ' +
                emissions + ' VM emission(s) pinned to their EXECUTE');
expect(misses, 'derived-row/parent disagreements').to.deep.equal([]);
}

function descriptionsRender (rows, FORMATS, decoder) {
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
}

module.exports = {
    validStringsParse, actionAndVersionMatch, canonicalizationIsStable,
    fieldValuesMatch, derivedRowsMatchParents, descriptionsRender,
};
