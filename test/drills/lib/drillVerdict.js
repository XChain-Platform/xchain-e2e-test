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
 * Verdict engine for the physical multi-box byzantine drill.
 *
 * Separated from the drill so the pass/fail rules can be unit-tested without
 * hardware, and so the drill's own report is produced by code an auditor can
 * read in one sitting rather than by prose written after the fact.
 *
 * The rule that shapes everything here: MISSING EVIDENCE IS NEVER A PASS. A
 * node the harness could not read reports INCONCLUSIVE, never a silent skip.
 * A live drill loses nodes for boring reasons (ssh drop, box reboot) and the
 * failure mode to design against is a green result that only means "we did
 * not look".
 ********************************************************************/

'use strict';

const PASS         = 'PASS';
const FAIL         = 'FAIL';
const INCONCLUSIVE = 'INCONCLUSIVE';

function verdict(phase, status, reasons, evidence) {
    return { phase: phase, status: status, reasons: reasons, evidence: evidence || {} };
}

// A reading is usable only if the harness actually got an answer back. `null`
// means "read succeeded, no value set" and is a legitimate observation;
// `undefined` means "no reading", and that is what poisons a verdict.
function unreadable(observations) {
    return (observations || []).filter((o) => !o || o.applied === undefined).map((o, i) => (o && o.id) || ('#' + i));
}

/**
 * LIVENESS: with exactly f faults, the honest remainder still reaches quorum
 * and applies. At the drill's scales the honest remainder is EXACTLY quorum,
 * so this is the zero-slack case: every honest node must apply, or quorum was
 * never truly reached.
 *
 * @param {object} args
 * @param {number} args.quorum
 * @param {*}      args.expectedValue
 * @param {Array}  args.observations  [{ id, role:'honest'|'byzantine', applied }]
 */
function evaluateLiveness(args) {
    const { quorum, expectedValue, observations } = args;
    const missing = unreadable(observations);
    if (missing.length) {
        return verdict('liveness', INCONCLUSIVE, ['no reading from: ' + missing.join(', ')], { missing });
    }

    const honest = observations.filter((o) => o.role === 'honest');
    const faulty = observations.filter((o) => o.role !== 'honest');
    const reasons = [];

    if (honest.length < quorum) {
        reasons.push('only ' + honest.length + ' honest validators against quorum ' + quorum +
                     '; the plan cannot reach quorum, so this round tests nothing');
    }
    const laggards = honest.filter((o) => o.applied !== expectedValue).map((o) => o.id);
    if (laggards.length) {
        reasons.push('honest validators did not apply the committed value: ' + laggards.join(', '));
    }
    const infected = faulty.filter((o) => o.applied === expectedValue).map((o) => o.id);
    if (infected.length) {
        reasons.push('faulty validators applied despite being silenced (fault injection did not take): ' + infected.join(', '));
    }

    return verdict('liveness', reasons.length ? FAIL : PASS, reasons, {
        quorum, honest: honest.length, faulty: faulty.length, expectedValue
    });
}

/**
 * LIVENESS BOUNDARY: with f+1 faults the live set falls below quorum, so the
 * change must apply NOWHERE. This is what pins f as the exact tolerance rather
 * than a lower bound nobody tested past.
 */
function evaluateBoundary(args) {
    const { expectedValue, observations } = args;
    const missing = unreadable(observations);
    if (missing.length) {
        return verdict('boundary', INCONCLUSIVE, ['no reading from: ' + missing.join(', ')], { missing });
    }
    const applied = observations.filter((o) => o.applied === expectedValue).map((o) => o.id);
    const reasons = applied.length
        ? ['validators applied a change that never had quorum: ' + applied.join(', ')]
        : [];
    return verdict('boundary', reasons.length ? FAIL : PASS, reasons, { expectedValue, appliedBy: applied });
}

/**
 * SAFETY (forged proposal): a PRE_PREPARE whose digest does not match its
 * config must create no pending proposal and change no state, on every honest
 * node that received it.
 *
 * @param {Array} args.observations [{ id, pendingCreated:boolean, applied }]
 */
function evaluateSafetyForge(args) {
    const { forgedValue, observations } = args;
    const missing = (observations || [])
        .filter((o) => !o || o.pendingCreated === undefined || o.applied === undefined)
        .map((o, i) => (o && o.id) || ('#' + i));
    if (missing.length) {
        return verdict('safety-forge', INCONCLUSIVE, ['incomplete reading from: ' + missing.join(', ')], { missing });
    }
    const reasons = [];
    const pended  = observations.filter((o) => o.pendingCreated).map((o) => o.id);
    const applied = observations.filter((o) => o.applied === forgedValue).map((o) => o.id);
    if (pended.length)  reasons.push('forged PRE_PREPARE created a pending proposal on: ' + pended.join(', '));
    if (applied.length) reasons.push('forged config was applied on: ' + applied.join(', '));
    return verdict('safety-forge', reasons.length ? FAIL : PASS, reasons, { forgedValue, pended, applied });
}

/**
 * SAFETY (signature exclusion): the decisive evidence from the N=3 relay
 * drill, generalised. An ACTIVE byzantine validator that forges its consensus
 * signatures still votes: honest peers must reject those votes, so the
 * finalized round on an honest node carries >= quorum signatures and NONE of
 * them belong to a byzantine key. The byzantine node's own view counting
 * itself is the divergence that proves it was voting, not crashed.
 *
 * @param {object} args
 * @param {number} args.quorum
 * @param {Array}  args.byzantinePubkeys
 * @param {object} args.honestView     { id, signers:[pubkeyHex] } from an honest node
 * @param {object} [args.byzantineView] { id, signers:[pubkeyHex] } from the byzantine node
 */
function evaluateSignatureExclusion(args) {
    const { quorum, byzantinePubkeys, honestView, byzantineView } = args;
    const lower = (a) => (a || []).map((s) => String(s).toLowerCase());
    if (!honestView || !Array.isArray(honestView.signers)) {
        return verdict('safety-exclusion', INCONCLUSIVE,
            ['no signature set read from an honest validator'], {});
    }

    const byz     = new Set(lower(byzantinePubkeys));
    const signers = lower(honestView.signers);
    const reasons = [];

    const intruders = signers.filter((s) => byz.has(s));
    if (intruders.length) {
        reasons.push('the honest view of the finalized round accepted ' + intruders.length +
                     ' byzantine signature(s); a forged vote was counted');
    }
    if (signers.length < quorum) {
        reasons.push('the finalized round carries ' + signers.length + ' signatures against quorum ' + quorum);
    }

    // Not a pass condition: absence only means the byzantine node did not
    // record its own vote, which a crashed node also produces. Reported so a
    // reader can tell an ACTIVE byzantine run from an accidental crash run.
    const byzSigners = (byzantineView && Array.isArray(byzantineView.signers)) ? lower(byzantineView.signers) : null;
    const divergence = !!(byzSigners && byzSigners.some((s) => byz.has(s)) && !intruders.length);

    return verdict('safety-exclusion', reasons.length ? FAIL : PASS, reasons, {
        quorum,
        honestSigners:    signers.length,
        byzantineSigners: byzSigners ? byzSigners.length : null,
        divergence:       divergence,
        activeByzantineProven: divergence
    });
}

/**
 * Roll a phase list into one drill result. An empty list is INCONCLUSIVE: a
 * drill that ran no phases has not proven anything, and must never print PASS.
 */
function summarize(verdicts) {
    const list = Array.isArray(verdicts) ? verdicts : [];
    let status = PASS;
    if (list.length === 0) {
        status = INCONCLUSIVE;
    } else if (list.some((v) => v.status === FAIL)) {
        status = FAIL;
    } else if (list.some((v) => v.status === INCONCLUSIVE)) {
        status = INCONCLUSIVE;
    }
    const lines = list.map((v) => {
        const head = v.status.padEnd(12) + v.phase;
        return v.reasons.length ? head + '\n    - ' + v.reasons.join('\n    - ') : head;
    });
    return { status: status, phases: list.length, lines: lines, verdicts: list };
}

// Render a drill result plus its plan as the text block that goes into the
// audit bundle. Keeping this next to the rules means the report cannot drift
// from what was actually asserted.
function renderReport(plan, summary, meta) {
    const { describePlan } = require('./drillPlan');
    const m = meta || {};
    const out = [];
    out.push('XChain physical multi-box byzantine drill');
    out.push('=========================================');
    if (m.startedAt) out.push('started: ' + m.startedAt);
    if (m.runId)     out.push('run id : ' + m.runId);
    out.push('');
    out.push(describePlan(plan));
    out.push('');
    out.push('RESULT: ' + summary.status + ' (' + summary.phases + ' phases)');
    out.push('');
    out.push(summary.lines.join('\n'));
    if (!plan.physicalMultiBox) {
        out.push('');
        out.push('NOTE: this run used a single box. It proves the out-of-process harness, ' +
                 'not multi-box byzantine tolerance.');
    }
    return out.join('\n');
}

module.exports = {
    PASS, FAIL, INCONCLUSIVE,
    evaluateLiveness, evaluateBoundary, evaluateSafetyForge, evaluateSignatureExclusion,
    summarize, renderReport
};
