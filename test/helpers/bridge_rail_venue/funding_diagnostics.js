'use strict';

function buildFundingDiagnostics(deps) {
const { evidenceJson } = deps;

// How long one funding call may take before the drive calls it a stall.
//
// WHY A BUDGET EXISTS AT ALL, measured rather than guessed: the harness's funding helper
// re-sends and re-waits forever when its transaction does not reach a block, printing the
// same three lines on a loop with no error and no diagnosis, and that loop ended drives 10,
// 11 and 13 (the last one 22 minutes into a single funding call, with every venue process
// alive and the miner answering, each new block carrying only its coinbase). A drive that
// hangs teaches nothing and costs the whole rail: the cases behind it never run, and a
// human has to notice. So the wait is bounded and a breach FAILS the case with the address,
// the transaction and the service it was waiting on.
//
// EIGHT MINUTES, and the number is a measurement: a funding call on this rail needs one
// block for the funding transaction and one for the utxo-tracker to index it, and the
// mining loops add a block every 20 seconds on both chains, so a healthy call is under a
// minute and the three recorded stalls were all past ten. Override per call or through
// BRIDGE_RAIL_FUNDING_BUDGET_MS when a drive deliberately mines slower.
const DEFAULT_FUNDING_BUDGET_MS = 8 * 60 * 1000;

// What each funding progress line means and WHICH SERVICE owns the wait. The helper's own
// console output is the only place this state exists (it returns nothing until it is done),
// so the classifier reads the lines it prints.
const FUNDING_WAIT_STAGES = [
    { re: /Waiting for the utxo-tracker to index confirmed UTXOs from tx ([0-9a-fA-F]+)/,
      stage: 'utxo-tracker indexing the funding transaction',
      service: 'the standing utxo-tracker for this chain', capture: 'txid' },
    { re: /Waiting for the (?:second )?transaction \(([0-9a-fA-F]+)\) to be confirmed/,
      stage: 'the funding transaction reaching a block',
      service: 'the coin node and the regtest mining loop', capture: 'txid' },
    { re: /Waiting for the utxos for ([A-Za-z0-9]+)/,
      stage: 'the funded address showing a spendable utxo',
      service: 'the standing indexer serving this address', capture: 'address' },
    { re: /Sending funds \(([0-9.]+)\) to ([A-Za-z0-9]+)/,
      stage: 'the funding transaction being built and broadcast',
      service: 'the harness funding wallet and the coin node', capture: 'sendTo' },
];

/**
 * What a funding call was waiting for, read off the progress lines it printed.
 *
 * PURE. Takes the lines in the order they were printed and answers the LAST stage any of
 * them names, because the helper prints a line per stage and the most recent one is the
 * one it is stuck in. Returns nulls for output that names no stage at all, which is a
 * different finding (the call never got as far as sending) and must not be reported as a
 * transaction wait.
 *
 * @param {Array<string>} lines the funding call's console output, in order
 * @returns {{stage: (string|null), service: (string|null), txid: (string|null),
 *            address: (string|null), line: (string|null)}}
 */
function classifyFundingWait(lines) {
    const out = { stage: null, service: null, txid: null, address: null, line: null };
    for (const raw of (Array.isArray(lines) ? lines : [])) {
        const line = String(raw === null || raw === undefined ? '' : raw);
        for (const s of FUNDING_WAIT_STAGES) {
            const m = line.match(s.re);
            if (!m) continue;
            out.stage = s.stage;
            out.service = s.service;
            out.line = line.trim();
            if (s.capture === 'txid') out.txid = m[1];
            if (s.capture === 'address') out.address = m[1];
            if (s.capture === 'sendTo') out.address = m[2];
        }
    }
    return out;
}

/**
 * What the chain itself says about a funding transaction, for a breach's diagnosis.
 *
 * Asked of the rail's own node through the harness's `nodeConnector`, because the three
 * services a funding call waits on fail in ways that look identical from the helper's console
 * output: a transaction the node never accepted, one sitting in the mempool that no block
 * includes, and one confirmed but not yet indexed downstream. Never throws, and never assumes
 * the connector exists: this runs on a failure path.
 */
async function nodeDiagnosis(txid) {
    const node = (typeof global !== 'undefined' && global.nodeConnector) ? global.nodeConnector : null;
    if (!node) return { node: 'no rail node connector in scope, so the chain was not asked' };
    if (!txid) return { node: 'no transaction was named, so the chain was not asked' };
    const out = {};
    try {
        const mem = await node.getRawMempool();
        out.mempoolSize = Array.isArray(mem) ? mem.length : null;
        out.inMempool = Array.isArray(mem) ? mem.indexOf(String(txid)) >= 0 : null;
    } catch (e) { out.mempool = 'unreadable: ' + String(e && e.message).slice(0, 60); }
    try {
        const tx = await node.getTransaction(txid);
        out.knownToNode = !!tx;
        out.confirmations = tx ? Number(tx.confirmations || 0) : null;
    } catch (e) { out.knownToNode = 'unreadable: ' + String(e && e.message).slice(0, 60); }
    try { out.nodeHeight = await node.getBlockCount(); } catch (e) { /* height is a nicety */ }
    return out;
}

/**
 * Which service owes the answer, in one sentence, from what the chain said.
 *
 * PURE, and the point of the whole budget: a stall that names the waiting service sends the
 * next reader to the right place, where "funding timed out" sends them to the log.
 */
function interpretFundingNode(wait, node) {
    const n = node || {};
    if (n.knownToNode === false)
        return 'The node has never seen this transaction, so it was never accepted: the fault is ' +
               'upstream of the chain (the sender\'s inputs, the fee, or a refused broadcast), not ' +
               'the miner.';
    if (n.inMempool === true)
        return 'The transaction is in the mempool and no block has included it, so the wait is on ' +
               'the miner and the block cadence.';
    if (Number(n.confirmations) >= 1)
        return 'The transaction is confirmed at depth ' + n.confirmations + ', so the wait is ' +
               'downstream of the chain: whatever indexes it has not caught up.';
    if (n.knownToNode === true)
        return 'The node knows the transaction but reports no confirmation, so it is accepted and ' +
               'unmined.';
    return 'The chain could not be asked about this transaction, so which service owes the answer ' +
           'is undetermined.';
}

/**
 * The message a breached funding budget fails with.
 *
 * PURE, and separate from the wrapper so the unit tier can assert the message names the
 * thing that was waited for rather than asserting on a string the code also writes. Every
 * field it has is stated: a diagnosis that says "funding timed out" sends a reader back to
 * the log, which is the situation this exists to end.
 */
function fundingBudgetMessage(label, budgetMs, elapsedMs, wait, context) {
    const w = wait || {};
    const ctx = context || {};
    const parts = [];
    parts.push('bridge rail funding STALLED for ' + label + ': ' + Math.round(elapsedMs / 1000) +
        's elapsed against a budget of ' + Math.round(budgetMs / 1000) + 's.');
    parts.push('Waiting on: ' + (w.stage || 'no stage was ever printed, so the call never got ' +
        'as far as sending a funding transaction') + '.');
    if (w.service) parts.push('Owned by: ' + w.service + '.');
    if (w.address) parts.push('Address: ' + w.address + '.');
    if (w.txid) parts.push('Transaction: ' + w.txid + '.');
    if (ctx.tipsAtStart || ctx.tipsAtBreach) {
        parts.push('Chain tips at the start ' + JSON.stringify(ctx.tipsAtStart || null) +
            ' and at the breach ' + JSON.stringify(ctx.tipsAtBreach || null) +
            ' (tips that moved while the transaction did not reach a block point at the ' +
            'mempool or the fee, not at a stopped chain).');
    }
    if (ctx.node) {
        parts.push('The chain says ' + JSON.stringify(ctx.node) + '. ' +
            interpretFundingNode(w, ctx.node));
    }
    if (w.line) parts.push('Last progress line: ' + w.line);
    return parts.join(' ');
}

/**
 * Run one funding call under a budget, and fail loudly with what it was waiting for.
 *
 * The helper being wrapped lives in the shared harness (`cryptoHelper.getNewFundedAddress`
 * and the DOGE rail form of it) and cannot be cancelled, so the budget RACES it: on a
 * breach this throws and the underlying call is left to finish or die on its own, with its
 * rejection swallowed so a late failure cannot surface as an unhandled rejection in a
 * later case.
 *
 * The progress lines are captured by wrapping `console.log` for the duration and forwarding
 * every line through to it unchanged, so the drive log reads exactly as it did before.
 *
 * @param {string} label the drive's own name for the address (AT1.SENDER, AT2B.DEST)
 * @param {function(): Promise} fn the funding call, already bound to its rail
 * @param {object} [opts] budgetMs, and diagnose() for the readings to quote on a breach
 */
async function fundUnderBudget(label, fn, opts) {
    const o = opts || {};
    const budgetMs = Number(o.budgetMs || process.env.BRIDGE_RAIL_FUNDING_BUDGET_MS ||
        DEFAULT_FUNDING_BUDGET_MS);
    const lines = [];
    const started = Date.now();
    const original = console.log;
    console.log = function () {
        const text = Array.from(arguments).map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
        // BOUNDED, because a stalled call prints the same three lines for minutes and the
        // classifier only ever needs the latest of each.
        lines.push(text);
        if (lines.length > 200) lines.splice(0, lines.length - 200);
        return original.apply(console, arguments);
    };
    let timer = null;
    try {
        const call = Promise.resolve().then(fn);
        const budget = new Promise((internalResolve, reject) => {
            timer = setTimeout(() => reject(new Error('__BRIDGE_RAIL_FUNDING_BUDGET__')), budgetMs);
        });
        return await Promise.race([call, budget]).catch(async (err) => {
            if (!err || String(err.message) !== '__BRIDGE_RAIL_FUNDING_BUDGET__') throw err;
            // Never let the abandoned call's own later failure land on a different case.
            call.catch(() => {});
            const wait = classifyFundingWait(lines);
            let context = {};
            if (typeof o.diagnose === 'function') {
                try { context = (await o.diagnose(wait)) || {}; } catch (e) {
                    context = { diagnoseFailed: String(e && e.message) };
                }
            }
            const failure = new Error(fundingBudgetMessage(label, budgetMs, Date.now() - started,
                wait, context));
            failure.fundingWait = wait;
            failure.fundingContext = context;
            throw failure;
        });
    } finally {
        if (timer) clearTimeout(timer);
        console.log = original;
    }
}

/**
 * Append one line to the drive's durable case journal, and never throw.
 *
 * WHY IT EXISTS: drive 13's baseline failure message and its whole evidence block were lost
 * because the run was interrupted before mocha printed its epilogue, and the epilogue is
 * the only place a mocha failure message appears. A journal written AS EACH CASE ENDS
 * survives an interrupt, a crash and a kill, so the next reader has the per-case verdicts
 * even when the summary never prints.
 *
 * Silent on a missing directory: a unit run has no log directory and a journal that threw
 * would turn a reporting convenience into a test failure.
 */
function journalCase(entry) {
    const dir = process.env.BRIDGE_RAIL_JOURNAL_DIR || process.env.ATTEST_VENUE_LOG_DIR || null;
    if (!dir) return false;
    try {
        const fs = require('fs');
        const path = require('path');
        fs.appendFileSync(path.join(dir, 'case-journal.jsonl'),
            evidenceJson(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
        return true;
    } catch (e) { return false; }
}

return { DEFAULT_FUNDING_BUDGET_MS, classifyFundingWait, nodeDiagnosis, interpretFundingNode, fundingBudgetMessage, fundUnderBudget, journalCase };
}

module.exports = buildFundingDiagnostics;
