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
 * XChain Platform E2E - chunked DEPLOY, the CLIENT side (AT9a / AT9b)
 *
 * Consensus deploys a chunk group at whichever piece completes it
 * (chunkedDeployDeferred.sdk.test.js pins that rule). This drill pins the half
 * a client owns: after DEPLOY_DEFERRED_ASSEMBLY the contract's action_index is
 * NOT knowable from the assembling DEPLOY's own indexed row any more, so a
 * client that reads it there deposits into the wrong index, or into none. The
 * SDK therefore asks the EXPLORER: `deployed_contract_index` on /api/action/A,
 * polled by `workflows.resolveDeployedContract(A)` until it is non-null, or
 * until `assembly_status` stops matching /^pending/ (a terminal failure).
 *
 *   AT9a  workflows.deployContract deploys a chunked contract sequentially, so
 *         the group is complete from lower carriers and deploys at the
 *         assembler's own index (R2.1). The returned `contractActionIndex`
 *         must be THAT index, read through the explorer field rather than off
 *         the indexed row, and the deposit passed in the same call must land
 *         on that contract.
 *   AT9b  occurrence 2, the case no client-side discipline closes: a correctly
 *         SEQUENCED group is orphaned and re-packed assembler-first by a
 *         reorg. The contract now rebuilds at the completing carrier C, and
 *         `resolveDeployedContract(A)` must answer C (not A, not the pending
 *         status), with the contract's state readable at the index it answered.
 *
 * WHY AT9b DOES NOT SUBMIT THROUGH workflows.deployContract (D55, and measured
 * against the reorg drill's contract (b)). The re-pack is only drivable when
 * the pieces are independent transactions: a block must list a parent before
 * its child, so pieces chained through change have exactly ONE legal order and
 * "re-packed assembler-first" is not a block a node would accept. Consecutive
 * submits from one walletSession spend speculative change, so the workflow's
 * own legs may chain. AT9b therefore funds one confirmed input per piece and
 * broadcasts them by hand (the deferred drill's plumbing, and independence is
 * ASSERTED off the mempool, not assumed), places them in the correct sequential
 * order so the first deploy is exactly what a correct client produces, and only
 * then reorgs. Everything the acceptance test is about - resolveDeployedContract
 * answering C - is driven through the SDK.
 *
 * ORDER OWNERSHIP, inherited from the deferred drill: for AT9b auto-mining is
 * HELD and every block is placed by raw hex (helpers/rawHexBlocks.js), the
 * whole acceptance test lives in ONE `it` (initialCheck's root afterEach
 * quiesce mines the mempool between tests, which would hand the ordering to the
 * packer), and indexer waits poll without nudging a block. AT9a owns no
 * ordering at all, so it runs with the auto-miner live.
 *
 * VENUE: BTC regtest (raw-hex placement plus an empty competing chain is the
 * BTC/LTC mechanism, and BTC is gas mode, so no native fee output is needed on
 * the workflow legs, which do not thread one). Needs the indexer's
 * DEPLOY_DEFERRED_ASSEMBLY gate (active from height 0 on regtest) AND the
 * explorer's `deployed_contract_index` field: without the field the SDK helper
 * cannot answer at all, so these two tests fail rather than self-skip, which is
 * the point of the rung. Node 22.
 *
 * Run (host with regtest stack + Node 22). It rides `npm run test:sdk`; on its own:
 *     COIN=bitcoin NETWORK=regtest npm run test:sdk:chunked-clients
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

// Spelled out rather than imported: a test that reads the string from the code
// that writes it proves nothing.
const PENDING_STATUS = 'pending: CODE_HASH (awaiting chunks)';

const GAS_LIMIT = 400000;
const START     = 5;

// Measured against chunkHelper.planDeploy (2026-09-07, gasLimit 400000, one
// constructor param): 7000 source bytes plan to 2 chunks. Each test asserts the
// count it got, so an SDK change to the per-carrier budget fails here instead of
// quietly reducing the drill to a single-action deploy that tests nothing.
const PAD_2CHUNK = 7000;

// Orphan-depth ceiling, same reasoning as the reorg and deferred drills: past
// the utxo-tracker's UNDO_BLOCKS=12 spent-output recovery window a rollback
// halts the tracker fail-closed and wedges the venue for every other suite, so
// the guard fires before any invalidateblock. AT9b orphans exactly one block.
const ORPHAN_DEPTH_LIMIT = 12;

// A contract too large for a single DEPLOY: the string literal survives (it is
// code, not a comment), `padlen` proves byte-exact reassembly and `run` proves
// the rebuilt contract is THIS run's source. The per-run marker makes the
// code_hash - and so the group every query below resolves - unique to one test.
function sourceFor(run, padBytes) {
    return [
        'var PAD = "' + 'x'.repeat(padBytes) + '";',
        'var RUN = "' + run + '";',
        'module.exports = {',
        "  meta: { name: 'Chunked Counter Clients', description: 'Per-run padded counter reassembled from a chunked DEPLOY group.', version: '1.0.0' },",
        '  initialize: function (xchain) {',
        '    var start = xchain.getInputParam(0);',
        '    xchain.state.set("count", String(parseInt(start) || 0));',
        '    xchain.state.set("padlen", String(PAD.length));',
        '    xchain.state.set("run", RUN);',
        '  },',
        '  increment: function() {',
        '    xchain.state.set("count", String(parseInt(xchain.state.get("count")) + 1));',
        '  }',
        '};'
    ].join('\n');
}

function haveConnectors() {
    return global.nodeConnector && global.regtestMinerConnector &&
           global.utxoTrackerConnector && global.indexerDatabase;
}

async function idxQuery(sql, params) {
    const conn = await global.indexerDatabase.getConnection();
    try { return await conn.query(sql, params); } finally { await conn.release(); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Poll until `fn()` is truthy. Deliberately mines NOTHING: in AT9b pieces of the
// group under test may be sitting unconfirmed while this waits, and a nudge block
// would let the miner pack them in ITS order rather than the one under test.
// Throws so a stall names the step it was waiting on rather than surfacing as a
// later assertion on an empty row set.
async function waitFor(fn, what, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const got = await fn();
        if (got) return got;
        if (Date.now() >= deadline) throw new Error('timed out after ' + (timeoutMs / 1000) + 's waiting for ' + what);
        await sleep(1000);
    }
}

// The e2e fee helper seeds the oracle prices the indexer's fee block reads, and
// sdkHelper.submit() refreshes them on every call. The workflow legs and the
// hand-broadcast pieces below bypass submit(), so the seed is refreshed here
// instead (throttled inside the helper; a no-op while the last one is fresh).
async function seedPrices() {
    try { await require('../../../helpers/nativeFeeHelper').seedGlobalPrices(false); } catch (e) { /* best effort */ }
}

/* ---------------------------------------------------------------- indexer reads */

// The indexer's dense address id; every group query is scoped by it because
// assembly is source-bound and two addresses may hold the same code_hash.
async function addressId(address) {
    const rows = await idxQuery('SELECT id FROM index_addresses WHERE address = ?', [address]);
    return rows.length ? Number(rows[0].id) : null;
}

// action_index of the action carried by a broadcast transaction. Binds every
// assertion below to a transaction this drill signed rather than to whichever
// row happened to match a status - and after a reorg the group's indexes are
// renumbered, so this is the only honest way to name A and C twice.
async function actionIndexOfTx(txid) {
    const rows = await idxQuery(
        'SELECT a.action_index FROM actions a ' +
        'INNER JOIN transactions t ON t.tx_index = a.tx_index ' +
        'INNER JOIN index_transactions it ON it.id = t.tx_hash_id ' +
        'WHERE it.hash = ?', [txid]);
    return rows.length ? Number(rows[0].action_index) : null;
}

async function contractRows(srcId, codeHash) {
    const rows = await idxQuery(
        'SELECT c.action_index, c.code_hash, s.status FROM contracts c ' +
        'LEFT JOIN index_statuses s ON s.id = c.status_id ' +
        'WHERE c.source_id = ? AND c.code_hash = ? ORDER BY c.action_index ASC', [srcId, codeHash]);
    return rows.map(r => ({ action_index: Number(r.action_index), code_hash: r.code_hash, status: r.status }));
}

async function chunkRows(srcId, codeHash) {
    const rows = await idxQuery(
        'SELECT dc.action_index, dc.chunk_index, s.status FROM deploy_chunks dc ' +
        'LEFT JOIN index_statuses s ON s.id = dc.status_id ' +
        'WHERE dc.source_id = ? AND dc.code_hash = ? ORDER BY dc.action_index ASC', [srcId, codeHash]);
    return rows.map(r => ({ action_index: Number(r.action_index), chunk_index: Number(r.chunk_index), status: r.status }));
}

async function executionRow(actionIndex) {
    const rows = await idxQuery(
        'SELECT e.action_index, e.contract_index, e.gas_used, e.assembler_action_index, s.status ' +
        'FROM contract_executions e LEFT JOIN index_statuses s ON s.id = e.status_id ' +
        'WHERE e.action_index = ?', [actionIndex]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
        action_index:           Number(r.action_index),
        contract_index:         r.contract_index === null ? null : Number(r.contract_index),
        gas_used:               Number(r.gas_used),
        assembler_action_index: r.assembler_action_index === null ? null : Number(r.assembler_action_index),
        status:                 r.status,
    };
}

/* ------------------------------------------------------------- explorer reads */

async function readState(sdk, contractIndex, key) {
    const state = await sdk.getContractState(contractIndex, key);
    const rows = (state && state.data) || [];
    const row = rows.find(r => r.state_key === key);
    return row ? JSON.parse(row.state_value) : undefined;
}

// Whatever shape getContractBalance answers in, as a number (same normalisation
// escrowTemplate uses).
async function contractBalance(sdk, contractIndex, tick) {
    const res = await sdk.getContractBalance(contractIndex, tick);
    if (res == null) return 0;
    if (typeof res === 'number' || typeof res === 'string') return Number(res);
    const list = Array.isArray(res) ? res : (Array.isArray(res.data) ? res.data : null);
    if (list) {
        const row = list.find(b => (b.tick || b.TICK) === tick);
        return row ? Number(row.amount ?? row.quantity ?? row.balance) : 0;
    }
    return Number(res.amount ?? res.quantity ?? res.balance ?? 0);
}

// The explorer's action detail, unwrapped from whichever envelope it arrives in
// (D52: the route wraps db.getAction's single-element array).
async function actionDetail(sdk, actionIndex) {
    let body = null;
    try { body = await sdk.getAction(actionIndex); } catch (e) { return null; }
    if (!body) return null;
    let d = (body.data !== undefined && body.data !== null) ? body.data : body;
    // db.getAction answers a single-element array and some envelopes nest the row
    // under `action`; on this explorer `action` is the NAME string ("DEPLOY"), so
    // only an object carrying action_index is the row, never the string.
    if (Array.isArray(d)) d = d.length ? d[0] : null;
    if (d && typeof d === "object" && d.action && typeof d.action === "object"
        && d.action.action_index !== undefined) d = d.action;
    return (d && typeof d === "object") ? d : null;
}

function hasField(detail, name) {
    return !!detail && Object.prototype.hasOwnProperty.call(detail, name);
}

// The D48 field contract, asserted rather than probed: this rung exists to make
// the field answer, so a missing field is a failure here (unlike the deferred
// drill, whose subject is consensus and which self-skips for an older explorer).
function expectResolution(detail, expectedIndex, expectedStatus, label) {
    expect(detail, label + ': explorer action detail').to.not.equal(null);
    expect(hasField(detail, 'deployed_contract_index'),
        label + ': /api/action carries deployed_contract_index (D48)').to.equal(true);
    expect(Number(detail.deployed_contract_index), label + ': deployed_contract_index').to.equal(expectedIndex);
    expect(hasField(detail, 'assembly_status'),
        label + ': /api/action carries assembly_status (D48)').to.equal(true);
    expect(String(detail.assembly_status), label + ': assembly_status').to.equal(expectedStatus);
}

module.exports = {
    PENDING_STATUS,
    GAS_LIMIT,
    START,
    PAD_2CHUNK,
    ORPHAN_DEPTH_LIMIT,
    sourceFor,
    haveConnectors,
    waitFor,
    seedPrices,
    addressId,
    actionIndexOfTx,
    contractRows,
    chunkRows,
    executionRow,
    readState,
    contractBalance,
    actionDetail,
    hasField,
    expectResolution,
};
