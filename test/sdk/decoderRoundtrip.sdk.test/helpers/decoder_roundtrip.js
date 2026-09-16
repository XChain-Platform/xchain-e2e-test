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

module.exports = {
    haveConnectors, compacted, firstOf, indexedDetails,
    emittedFrom, derivedActionsFor, isDerivedRow, indexerNameMatches,
};
