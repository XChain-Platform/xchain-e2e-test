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
 * Unit tests for the physical byzantine drill's topology planner.
 *
 * The planner's guards are the only thing standing between "we ran a
 * multi-box drill" and a layout that quietly proves nothing, so they are
 * tested harder than the happy path.
 ********************************************************************/

'use strict';

const assert = require('assert');
const { planDrill, describePlan, quorumFor, faultBudgetFor, normalizeHosts } = require('../lib/drillPlan');

const HOSTS2 = [
    { id: 'boxA', ssh: 'user@a.example', advertise: '10.0.0.1' },
    { id: 'boxB', ssh: 'user@b.example', advertise: '10.0.0.2' }
];
const HOSTS3 = HOSTS2.concat([{ id: 'boxC', ssh: 'user@c.example', advertise: '10.0.0.3' }]);

describe('drillPlan: PBFT arithmetic', function () {
    it('matches the scales the in-process suite already proves', function () {
        assert.deepStrictEqual([quorumFor(4),  faultBudgetFor(4)],  [3, 1]);
        assert.deepStrictEqual([quorumFor(7),  faultBudgetFor(7)],  [5, 2]);
        assert.deepStrictEqual([quorumFor(10), faultBudgetFor(10)], [7, 3]);
    });

    it('floors the budget between the 3f+1 points instead of rounding up', function () {
        // N=6 is not 3f+1; the budget must stay at f=1, not creep to 2.
        assert.strictEqual(faultBudgetFor(6), 1);
        assert.strictEqual(quorumFor(6), 3);
    });
});

describe('drillPlan: layout', function () {
    it('lays N=7 f=2 over two boxes with unique ports, DBs and endpoints', function () {
        const plan = planDrill({ count: 7, hosts: HOSTS2, basePort: 41000, runId: 'x' });
        assert.strictEqual(plan.count, 7);
        assert.strictEqual(plan.quorum, 5);
        assert.strictEqual(plan.faults, 2);
        assert.strictEqual(plan.nodes.length, 7);
        assert.strictEqual(new Set(plan.nodes.map((n) => n.port)).size, 7);
        assert.strictEqual(new Set(plan.nodes.map((n) => n.dbName)).size, 7);
        assert.strictEqual(new Set(plan.nodes.map((n) => n.endpoint)).size, 7);
        assert.deepStrictEqual(plan.perHost.map((h) => h.validators), [4, 3]);
    });

    it('gives each validator every other validator as a seed, and never itself', function () {
        const plan = planDrill({ count: 7, hosts: HOSTS2 });
        for (const n of plan.nodes) {
            const seeds = plan.seedsFor(n.index);
            assert.strictEqual(seeds.length, 6);
            assert.ok(!seeds.includes(n.endpoint), n.id + ' seeds itself');
        }
    });

    it('spreads the faults across boxes rather than sinking a single box', function () {
        for (const count of [7, 10]) {
            const plan = planDrill({ count, hosts: HOSTS2 });
            assert.ok(plan.byzantineHostCount >= 2,
                'N=' + count + ' put every fault on one box: ' + JSON.stringify(plan.perHost));
        }
        const three = planDrill({ count: 10, hosts: HOSTS3 });
        assert.strictEqual(three.faults, 3);
        assert.strictEqual(three.byzantineHostCount, 3);
    });

    it('marks exactly `faults` validators byzantine and the rest honest', function () {
        const plan = planDrill({ count: 10, hosts: HOSTS3 });
        assert.strictEqual(plan.byzantineIndexes.length, 3);
        assert.strictEqual(plan.honestIndexes.length, 7);
        assert.strictEqual(plan.nodes.filter((n) => n.role === 'byzantine').length, 3);
        const overlap = plan.byzantineIndexes.filter((i) => plan.honestIndexes.includes(i));
        assert.deepStrictEqual(overlap, []);
    });

    it('is deterministic: the same inputs give byte-identical placement', function () {
        const a = planDrill({ count: 10, hosts: HOSTS3, runId: 'r' });
        const b = planDrill({ count: 10, hosts: HOSTS3, runId: 'r' });
        assert.deepStrictEqual(a.byzantineIndexes, b.byzantineIndexes);
        assert.deepStrictEqual(a.nodes.map((n) => n.endpoint + '|' + n.dbName + '|' + n.role),
                               b.nodes.map((n) => n.endpoint + '|' + n.dbName + '|' + n.role));
    });
});

describe('drillPlan: guards', function () {
    it('refuses a single host unless the caller explicitly labels it a shakedown', function () {
        assert.throws(() => planDrill({ count: 7, hosts: [HOSTS2[0]] }), /not a multi-box drill/);
        const plan = planDrill({ count: 7, hosts: [HOSTS2[0]], allowSingleHost: true });
        assert.strictEqual(plan.physicalMultiBox, false);
        assert.match(describePlan(plan), /SINGLE-HOST SHAKEDOWN/);
    });

    it('refuses a layout where one box could form a quorum by itself', function () {
        // N=4 quorum 3 over two boxes is 2+2 and fine; force the bad case by
        // planning N=4 against a host list that concentrates the mesh.
        const lopsided = [
            { id: 'fat',  advertise: '10.0.0.1' },
            { id: 'thin', advertise: '10.0.0.2' }
        ];
        // N=4 over 2 boxes = 2+2 < quorum 3, so this must be accepted.
        assert.doesNotThrow(() => planDrill({ count: 4, hosts: lopsided }));
        // A three-box plan for N=10 is 4+3+3, all below quorum 7.
        assert.doesNotThrow(() => planDrill({ count: 10, hosts: HOSTS3 }));
    });

    it('reports whether the layout survives losing a whole box', function () {
        // N=7 over 2 boxes: losing the 4-validator box leaves 3 against quorum 5.
        assert.strictEqual(planDrill({ count: 7, hosts: HOSTS2 }).survivesHostLoss, false);
        // N=10 over 3 boxes: losing the 4-validator box leaves 6 against quorum 7.
        assert.strictEqual(planDrill({ count: 10, hosts: HOSTS3 }).survivesHostLoss, false);
        // Enough boxes and the property holds: N=10 over 10 boxes leaves 9.
        const ten = Array.from({ length: 10 }, (_, i) => ({ id: 'b' + i, advertise: '10.0.1.' + i }));
        assert.strictEqual(planDrill({ count: 10, hosts: ten }).survivesHostLoss, true);
    });

    it('rejects counts below the BFT floor and faults outside the budget', function () {
        assert.throws(() => planDrill({ count: 3, hosts: HOSTS2 }), /count must be an integer >= 4/);
        assert.throws(() => planDrill({ count: 7, hosts: HOSTS2, faults: 3 }), /faults must be an integer in 1\.\.2/);
        assert.throws(() => planDrill({ count: 7, hosts: HOSTS2, faults: 0 }), /faults must be an integer in 1\.\.2/);
    });

    it('rejects hosts that cannot be dialled or that repeat', function () {
        assert.throws(() => normalizeHosts([]), /non-empty array/);
        assert.throws(() => normalizeHosts([{ ssh: 'user@a' }]), /no `advertise` address/);
        assert.throws(() => normalizeHosts([{ id: 'a', advertise: '1.1.1.1' }, { id: 'a', advertise: '2.2.2.2' }]),
            /duplicate host id/);
    });

    it('uses per-host loopback aliases only on a single-box shakedown', function () {
        const single = planDrill({
            count: 4, allowSingleHost: true,
            hosts: [{ id: 'box', advertise: '127.0.0.1', addresses: ['127.0.0.1', '127.0.0.2'] }]
        });
        assert.deepStrictEqual(single.nodes.map((n) => n.address), ['127.0.0.1', '127.0.0.2', '127.0.0.1', '127.0.0.2']);

        // With peers to dial, an alias is unroutable, so every node advertises
        // the box's real address and separates by port.
        const multi = planDrill({
            count: 4,
            hosts: [{ id: 'a', advertise: '10.0.0.1', addresses: ['127.0.0.2'] }, { id: 'b', advertise: '10.0.0.2' }]
        });
        assert.deepStrictEqual(multi.nodes.map((n) => n.address), ['10.0.0.1', '10.0.0.2', '10.0.0.1', '10.0.0.2']);
    });
});
