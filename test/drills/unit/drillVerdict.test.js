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
 * Unit tests for the drill verdict engine.
 *
 * The property under test throughout: a drill result may be PASS, FAIL or
 * INCONCLUSIVE, and evidence the harness never collected must land in the
 * third bucket. A live drill loses nodes for boring reasons, and the failure
 * this suite exists to prevent is a green result that only means nobody looked.
 ********************************************************************/

'use strict';

const assert = require('assert');
const V = require('../lib/drillVerdict');

const obs = (id, role, applied) => ({ id, role, applied });

describe('drillVerdict: liveness', function () {
    const quorum = 5, value = '7B';

    it('passes when every honest validator applied and no faulty one did', function () {
        const observations = [
            obs('v0', 'honest', value), obs('v1', 'honest', value), obs('v2', 'honest', value),
            obs('v3', 'honest', value), obs('v4', 'honest', value),
            obs('v5', 'byzantine', null), obs('v6', 'byzantine', null)
        ];
        const v = V.evaluateLiveness({ quorum, expectedValue: value, observations });
        assert.strictEqual(v.status, V.PASS, v.reasons.join('; '));
    });

    it('fails when an honest validator missed the committed value', function () {
        const observations = [
            obs('v0', 'honest', value), obs('v1', 'honest', value), obs('v2', 'honest', value),
            obs('v3', 'honest', value), obs('v4', 'honest', 'stale'),
            obs('v5', 'byzantine', null), obs('v6', 'byzantine', null)
        ];
        const v = V.evaluateLiveness({ quorum, expectedValue: value, observations });
        assert.strictEqual(v.status, V.FAIL);
        assert.match(v.reasons.join(' '), /v4/);
    });

    it('fails when a silenced validator applied, because the fault never took', function () {
        const observations = [
            obs('v0', 'honest', value), obs('v1', 'honest', value), obs('v2', 'honest', value),
            obs('v3', 'honest', value), obs('v4', 'honest', value),
            obs('v5', 'byzantine', value), obs('v6', 'byzantine', null)
        ];
        const v = V.evaluateLiveness({ quorum, expectedValue: value, observations });
        assert.strictEqual(v.status, V.FAIL);
        assert.match(v.reasons.join(' '), /fault injection did not take/);
    });

    it('fails a plan that cannot reach quorum instead of quietly passing it', function () {
        const observations = [obs('v0', 'honest', value), obs('v1', 'honest', value), obs('v2', 'byzantine', null)];
        const v = V.evaluateLiveness({ quorum: 5, expectedValue: value, observations });
        assert.strictEqual(v.status, V.FAIL);
        assert.match(v.reasons.join(' '), /cannot reach quorum/);
    });

    it('is INCONCLUSIVE, not PASS, when a validator could not be read', function () {
        const observations = [
            obs('v0', 'honest', value), obs('v1', 'honest', value), obs('v2', 'honest', value),
            obs('v3', 'honest', value), obs('v4', 'honest', undefined),
            obs('v5', 'byzantine', null), obs('v6', 'byzantine', null)
        ];
        const v = V.evaluateLiveness({ quorum, expectedValue: value, observations });
        assert.strictEqual(v.status, V.INCONCLUSIVE);
        assert.deepStrictEqual(v.evidence.missing, ['v4']);
    });

    it('treats a null reading as a real observation, not a missing one', function () {
        const observations = [
            obs('v0', 'honest', value), obs('v1', 'honest', value), obs('v2', 'honest', value),
            obs('v3', 'honest', value), obs('v4', 'honest', value),
            obs('v5', 'byzantine', null), obs('v6', 'byzantine', null)
        ];
        assert.strictEqual(V.evaluateLiveness({ quorum, expectedValue: value, observations }).status, V.PASS);
    });
});

describe('drillVerdict: liveness boundary', function () {
    it('passes only when the change applied nowhere', function () {
        const v = V.evaluateBoundary({
            expectedValue: 'X',
            observations: [obs('v0', 'honest', null), obs('v1', 'honest', 'old'), obs('v2', 'byzantine', null)]
        });
        assert.strictEqual(v.status, V.PASS);
    });

    it('fails when any validator applied a change that never had quorum', function () {
        const v = V.evaluateBoundary({
            expectedValue: 'X',
            observations: [obs('v0', 'honest', 'X'), obs('v1', 'honest', null)]
        });
        assert.strictEqual(v.status, V.FAIL);
        assert.deepStrictEqual(v.evidence.appliedBy, ['v0']);
    });

    it('is INCONCLUSIVE when a validator could not be read', function () {
        const v = V.evaluateBoundary({
            expectedValue: 'X',
            observations: [obs('v0', 'honest', null), obs('v1', 'honest', undefined)]
        });
        assert.strictEqual(v.status, V.INCONCLUSIVE);
    });
});

describe('drillVerdict: forged proposal safety', function () {
    it('passes when no honest node pended or applied the forgery', function () {
        const v = V.evaluateSafetyForge({
            forgedValue: 'F',
            observations: [{ id: 'v0', pendingCreated: false, applied: null }, { id: 'v1', pendingCreated: false, applied: 'old' }]
        });
        assert.strictEqual(v.status, V.PASS);
    });

    it('fails on a pending proposal even when nothing was applied', function () {
        const v = V.evaluateSafetyForge({
            forgedValue: 'F',
            observations: [{ id: 'v0', pendingCreated: true, applied: null }]
        });
        assert.strictEqual(v.status, V.FAIL);
        assert.match(v.reasons.join(' '), /created a pending proposal/);
    });

    it('fails when the forged config reached the database', function () {
        const v = V.evaluateSafetyForge({
            forgedValue: 'F',
            observations: [{ id: 'v0', pendingCreated: false, applied: 'F' }]
        });
        assert.strictEqual(v.status, V.FAIL);
        assert.match(v.reasons.join(' '), /was applied/);
    });

    it('is INCONCLUSIVE when either half of a reading is missing', function () {
        assert.strictEqual(V.evaluateSafetyForge({
            forgedValue: 'F', observations: [{ id: 'v0', pendingCreated: undefined, applied: null }]
        }).status, V.INCONCLUSIVE);
        assert.strictEqual(V.evaluateSafetyForge({
            forgedValue: 'F', observations: [{ id: 'v0', pendingCreated: false, applied: undefined }]
        }).status, V.INCONCLUSIVE);
    });
});

describe('drillVerdict: signature exclusion', function () {
    const byzantinePubkeys = ['AABB'];

    it('passes when the honest view reached quorum with no byzantine signer', function () {
        const v = V.evaluateSignatureExclusion({
            quorum: 3,
            byzantinePubkeys,
            honestView:    { id: 'v0', signers: ['1111', '2222', '3333'] },
            byzantineView: { id: 'v2', signers: ['1111', '2222', '3333', 'aabb'] }
        });
        assert.strictEqual(v.status, V.PASS, v.reasons.join('; '));
        // The byzantine node counting its own rejected vote is what shows it was
        // voting rather than crashed.
        assert.strictEqual(v.evidence.activeByzantineProven, true);
    });

    it('fails when a byzantine signature was counted, whatever its case', function () {
        const v = V.evaluateSignatureExclusion({
            quorum: 3, byzantinePubkeys,
            honestView: { id: 'v0', signers: ['1111', '2222', 'aabb'] }
        });
        assert.strictEqual(v.status, V.FAIL);
        assert.match(v.reasons.join(' '), /byzantine signature/);
    });

    it('fails a finalized round that is short of quorum', function () {
        const v = V.evaluateSignatureExclusion({
            quorum: 5, byzantinePubkeys, honestView: { id: 'v0', signers: ['1111', '2222'] }
        });
        assert.strictEqual(v.status, V.FAIL);
        assert.match(v.reasons.join(' '), /against quorum 5/);
    });

    it('reports no active-byzantine proof when the victim recorded nothing', function () {
        const v = V.evaluateSignatureExclusion({
            quorum: 3, byzantinePubkeys, honestView: { id: 'v0', signers: ['1111', '2222', '3333'] }
        });
        assert.strictEqual(v.status, V.PASS);
        assert.strictEqual(v.evidence.activeByzantineProven, false);
    });

    it('is INCONCLUSIVE with no honest view at all', function () {
        assert.strictEqual(V.evaluateSignatureExclusion({ quorum: 3, byzantinePubkeys }).status, V.INCONCLUSIVE);
    });
});

describe('drillVerdict: summary', function () {
    const mk = (status) => ({ phase: 'p', status, reasons: [], evidence: {} });

    it('never calls a drill that ran no phases a pass', function () {
        const s = V.summarize([]);
        assert.strictEqual(s.status, V.INCONCLUSIVE);
        assert.strictEqual(s.phases, 0);
    });

    it('lets one FAIL outrank everything else', function () {
        assert.strictEqual(V.summarize([mk(V.PASS), mk(V.INCONCLUSIVE), mk(V.FAIL)]).status, V.FAIL);
    });

    it('lets one INCONCLUSIVE outrank a field of passes', function () {
        assert.strictEqual(V.summarize([mk(V.PASS), mk(V.PASS), mk(V.INCONCLUSIVE)]).status, V.INCONCLUSIVE);
    });

    it('passes only when every phase passed', function () {
        assert.strictEqual(V.summarize([mk(V.PASS), mk(V.PASS)]).status, V.PASS);
    });
});

describe('drillVerdict: report', function () {
    const { planDrill } = require('../lib/drillPlan');

    it('carries the verdict, the layout and the fault placement', function () {
        const plan = planDrill({
            count: 7,
            hosts: [{ id: 'boxA', advertise: '10.0.0.1' }, { id: 'boxB', advertise: '10.0.0.2' }]
        });
        const text = V.renderReport(plan, V.summarize([
            { phase: 'liveness', status: V.PASS, reasons: [], evidence: {} },
            { phase: 'boundary', status: V.FAIL, reasons: ['v1 applied'], evidence: {} }
        ]), { runId: 'N7' });
        assert.match(text, /RESULT: FAIL/);
        assert.match(text, /N=7 {2}quorum=5 {2}f=2/);
        assert.match(text, /boxA: 4 validators/);
        assert.match(text, /v1 applied/);
    });

    it('stamps a single-box run so the result cannot be read as multi-box', function () {
        const plan = planDrill({ count: 4, hosts: [{ id: 'only', advertise: '127.0.0.1' }], allowSingleHost: true });
        const text = V.renderReport(plan, V.summarize([{ phase: 'liveness', status: V.PASS, reasons: [], evidence: {} }]), {});
        assert.match(text, /NOTE: this run used a single box/);
    });
});
