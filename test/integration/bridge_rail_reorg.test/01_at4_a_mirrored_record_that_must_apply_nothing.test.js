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
 ********************************************************************/

'use strict';

const assert      = require('assert');
const chainRail   = require('../../helpers/chainRail');
const cryptoHelper = require('../../cryptoHelper');
const bridgeParts = require('./helpers/fixture');

const GAS_TICK = 'XCHAIN';
const GROUP = 'AT4: a mirrored record that must apply nothing';

let venue = null;
let dogeRail = null;
let blocked = null;
let evidence = null;
let needsFederation = null;

function bindBridgeState(state) {
    ({ venue, dogeRail, blocked, evidence, needsFederation } = state);
}

function registerBridgeTest(title, callback) {
    describe('XBRIDGE acceptance drive: reorg and falsification (AT3, AT4)', function () {
        bridgeParts.install(bindBridgeState);
        describe(GROUP, function () {
            it(title, callback);
        });
    });
}

// Each perturbation is a DIFFERENT refusal path in bridge_settle.js, and the set is
// the spec's own list. They share one shape: take a row the federation really
// signed, change one thing, inject it into the mirror, and assert that the
// destination ledger is untouched and that exactly ONE refusal line names the id.
const CASES = [
    { name: 'a bad signature',                mutate: (r) => ({ validator_signatures: flipLastHexNibble(r.validator_signatures) }) },
    { name: 'a pubkey outside the snapshot',  mutate: (r) => ({ validator_signatures: resignWithStranger(r) }) },
    // The two FOREIGN rows are refused before the settle pass ever examines them, so
    // no per-row line exists to count and the case asserts the refusal's own witness
    // instead: a foreign btc_chain_id is turned away at ingest by the chain-identity
    // guard (counted by table and hash by design, never per row) and never reaches the
    // mirror; a foreign network lands in the mirror and is never selected by the due
    // read's network scope, so it sits there unsettled through every pass.
    { name: 'a foreign network',              mutate: () => ({ network: 'testnet' }),     refusedBefore: 'due' },
    { name: 'a foreign btc_chain_id',         mutate: () => ({ btc_chain_id: 'ffffffff' }), refusedBefore: 'ingest' },
    { name: 'an unwrapped canonical',         mutate: (r) => ({ finalizing_view: String(Number(r.finalizing_view || 0) + 1) }) },
    // BTC IS the escrow chain (bridge_checkpoint_check ESCROW_CHAIN), so a row whose
    // src_chain is anything else settles as an OUT leg on BTC, never on DOGE: the
    // settle pass's screenRow refuses any row whose dest_chain is not ITS OWN chain
    // (NOT_OURS), so this case's forged record has to be injected into, and watched
    // on, the BTC venue rather than the DOGE default every other case uses.
    { name: 'an out leg over the escrow',     destChain: 'BTC',
      mutate: (r) => ({ src_chain: 'DOGE', dest_chain: 'BTC',
                         amount: String(Number(r.amount) + 1000000) }) },
];

function flipLastHexNibble(sigs) {
    const parsed = JSON.parse(sigs || '[]');
    if (!parsed.length) return sigs;
    const s = String(parsed[0].sig);
    parsed[0].sig = s.slice(0, -1) + (s.slice(-1) === '0' ? '1' : '0');
    return JSON.stringify(parsed);
}
function resignWithStranger(r) {
    const parsed = JSON.parse(r.validator_signatures || '[]');
    if (!parsed.length) return r.validator_signatures;
    parsed[0].pubkey = 'a'.repeat(64);
    return JSON.stringify(parsed);
}

// WHICH CHAIN'S ADDRESS the forged record must credit: every case but the out leg is
// DOGE-bound; the out leg is BTC-bound (BTC is the escrow chain per bridge_checkpoint_check),
// so its dest address has to be real on BTC, not DOGE, or the refusal would be about a
// malformed address rather than about the escrow.
async function fundDestAddress(label, destChain) {
    return venue.funded(label, destChain === 'BTC'
        ? () => cryptoHelper.getNewFundedAddress(label, 'bitcoin', NETWORK, null, 'legacy', 0, 1, false)
        : () => chainRail.withRail(dogeRail,
            () => cryptoHelper.getNewFundedAddress(label, 'dogecoin', NETWORK, null, 'legacy', 0, 1, false)));
}

async function buildRefusal(c) {
// WHICH VENUE IS THE DESTINATION, per case: the settle pass refuses any row whose
// dest_chain is not ITS OWN chain (screenRow's NOT_OURS), so the injection target has
// to follow c.destChain or the row lands on a mirror its destination indexer never reads.
const destChain = c.destChain || 'DOGE';
const destVenue = destChain === 'BTC' ? venue.btcVenue : venue.dogeVenue;
const label = 'AT4.' + c.name.replace(/[^A-Za-z]/g, '');
const dest = await fundDestAddress(label, destChain);
// A ROW THE FEDERATION REALLY SIGNED, which the newest row is not once this suite has
// run a case: drive 18's third case copied the second case's injected foreign
// btc_chain_id row as its template, and so did the fourth, which is why the destination
// logged `refused 1, 2, 3 bridge_transfers row(s) carrying btc_chain_id ffffffff` and
// never examined either of them.
const template = await venue.queryHubDb(venue.hubs[0].dbName,
    "SELECT * FROM bridge_transfers WHERE transfer_id NOT LIKE 'at4%' AND status = 'finalized' " +
    'ORDER BY id DESC LIMIT 1');
assert.ok(template.length,
    'AT4 perturbs a row the federation really signed, so a real one must exist first');

// A SOURCE LEG THIS CHAIN HAS NOT SETTLED, or the settle pass never looks at the row.
// Its due read (xchain-indexer src/consensus/bridge_settle/pass.js dueBridgeTransfers)
// drops any row whose (src_chain, src_action_index) this chain already settled under
// another transfer id, silently and by design, so a copy of an applied row is not a
// refusal the pass logs: drive 18's bad-signature and stranger-pubkey rows sat in the
// DOGE mirror, finalized and due, and no line ever named them. An index no real lock
// carries keeps the row in the due set, where the perturbation is judged. The escrow
// proof the pass fetches first is keyed on the escrow address and the checkpoint, not
// on this index, so the copy cannot park the block on the proof barrier.
const unsettledLeg = 700000 + CASES.indexOf(c) + Number(template[0].src_action_index || 0);

const row = Object.assign({}, template[0], {
    src_action_index: unsettledLeg,
    // DISTINCTIVE IN ITS PREFIX, and the first cut padded the other way:
    // `padStart` put the timestamp at the END, so every AT4 case's id began
    // `at40000000000000` and a log line naming a shortened id could not be
    // attributed to the case that caused it. The id is matched against the
    // destination's log by its leading 16 characters, so that is where the
    // per-case entropy has to be.
    transfer_id: ('at4' + Date.now().toString(16) +
        c.name.replace(/[^a-f0-9]/g, '')).padEnd(64, '0').slice(0, 64),
    dest_address: dest.address,
}, c.mutate(template[0]));
delete row.id;

// THROUGH THE DESTINATION'S OWN VENUE, and that is not a detail: the injector
// writes to the hubs that ITS venue's indexers follow, and an attached indexer is
// on the mesh rather than owning it, so injecting through the WRONG venue can land
// the row on a hub the actual destination indexer does not follow and it never sees
// the record at all. The first run of the out-leg case waited 180 s for a refusal
// that could not arrive, because it went through the DOGE venue for a BTC-bound
// row. `bridge_transfers` is deliberately NOT a full-repage mirror table, so
// delivery is the ordinary id cursor: the row has to be on the followed hub.
//
// The table AND its natural key: a bridge transfer is keyed by `transfer_id`
// alone, where the injector's default table is keyed by three columns.
await destVenue.injectMirrorRow(row,
    { table: 'bridge_transfers', key: ['transfer_id'] });
    return { dest, row };

}

async function observeRefusal(c, row, dest) {
// THE SAME destChain buildRefusal picked: the tip that has to move twice, and the
// ledger the credit is checked on, are the destination's, not always DOGE's.
const destChain = c.destChain || 'DOGE';
// TWO CONDITIONS, NOT A FIXED WAIT, and the second one is the assertion's
// whole point. First the destination has to SEE the record and say so, which
// is a poll on its own log. Then the ledger has to move two more blocks, so
// the settle pass has run again over a record it already refused: "exactly
// one refusal" is a claim about repetition, and a fixed sleep that happened to
// span one pass would pass this case without ever testing it.
// COUNTED BY THE ID, NOT BY A DIFF OF TWO TAILS. The first cut sliced the
// "after" tail by the "before" tail's string LENGTH, and `indexerTails` returns
// the last 200 lines of two scrolling logs: once lines scroll off, that offset
// cuts mid-line and the comparison is meaningless. This id exists only in this
// case, so every line naming it is this case's by construction.
const idPrefix = row.transfer_id.slice(0, 16);
const refusalsNow = () => venue.indexerTails(400)
    .split('\n').filter((l) => l.includes(idPrefix));
const mirrorHolds = async () => (await venue.queryMirrorDb('DOGE',
    'SELECT transfer_id FROM bridge_transfers WHERE transfer_id = ?', [row.transfer_id])).length;
if (c.refusedBefore === 'due') {
    // The witness that the row REACHED the destination is the mirror itself.
    await venue.waitUntil('the destination mirror to hold ' + idPrefix,
        async () => (await mirrorHolds()) === 1, { timeoutMs: 180000 });
} else if (c.refusedBefore === 'ingest') {
    // The chain-identity guard reports its refusals per table and foreign hash,
    // so the witness is that summary line naming the hash this case planted.
    await venue.waitUntil('the destination to report a refused bridge_transfers row carrying ' +
        row.btc_chain_id,
        () => venue.indexerTails(400).split('\n').some((l) =>
            l.includes('refused') && l.includes('bridge_transfers row') &&
            l.includes('btc_chain_id ' + row.btc_chain_id)),
        { timeoutMs: 180000 });
} else {
    await venue.waitUntil('the destination to log a refusal naming ' + idPrefix,
        () => refusalsNow().length >= 1, { timeoutMs: 180000 });
}
const atRefusal = Number((await venue.venueTips())[destChain]);
await venue.waitUntil('two more ' + destChain + ' blocks after the refusal, so the settle pass ' +
    'has run again over a record it already refused',
    async () => Number((await venue.venueTips())[destChain]) >= atRefusal + 2,
    { timeoutMs: 300000 });

const balance = await venue.addressBalance(destChain, dest.address, GAS_TICK);
const refusals = refusalsNow();
// The line itself is kept, not just its count: with the source leg moved off a settled
// index every perturbation is judged by the pass, and WHICH guard refused it (quorum,
// escrow proof, escrow short) is the reading that says the right guard fired.
evidence['at4_' + c.name.replace(/[^A-Za-z]/g, '')] = { transferId: row.transfer_id, balance,
    srcActionIndex: row.src_action_index,
    refusalLines: refusals.length, refusals: refusals.map((l) => l.trim().slice(0, 220)) };
    return { balance, mirrorHolds, refusals };

}

for (const c of CASES) {
    registerBridgeTest((c.refusedBefore ? 'applies nothing and is refused before the settle pass for '
                                       : 'applies nothing and logs exactly one refusal naming the id for ') + c.name, async function () {
        this.timeout(0);
        if (needsFederation(this, 'AT4 (' + c.name + ')')) return;

        const { dest, row } = await buildRefusal(c);
        const { balance, mirrorHolds, refusals } = await observeRefusal(c, row, dest);

assert.strictEqual(balance, '0',
    dest.address + ' was credited from a record carrying ' + c.name);
const settled = await venue.queryIndexerDb(c.destChain || 'DOGE',
    'SELECT transfer_id FROM bridge_settlements WHERE transfer_id = ?', [row.transfer_id]);
assert.strictEqual(settled.length, 0,
    'the destination recorded a settlement for a record carrying ' + c.name);
if (c.refusedBefore === 'due') {
    assert.strictEqual(await mirrorHolds(), 1,
        'the foreign-network row must sit in the mirror, unselected, through every pass');
    return;
}
if (c.refusedBefore === 'ingest') {
    assert.strictEqual(await mirrorHolds(), 0,
        'a foreign btc_chain_id row must be turned away at ingest and never reach the mirror');
    return;
}
assert.strictEqual(refusals.length, 1,
    'the destination logged ' + refusals.length + ' line(s) naming ' +
    row.transfer_id.slice(0, 16) + '; the spec asks for exactly one, because a ' +
    'refusal repeated every pass is a log flood and a silent one is unauditable');
    });
}
