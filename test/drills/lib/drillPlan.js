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
 * Topology planner for the PHYSICAL multi-box byzantine drill .
 *
 * The in-process suite (test/integration/multiHubByzantineF2) already proves
 * f=2 at N=7 and f=3 at N=10, but every validator there shares one process,
 * one event loop, one 127.0.0.1 and one MariaDB connection pool. An auditor
 * reading that suite can fairly say the faults were injected by reaching into
 * the victim's memory. This planner is the first half of the answer: it lays
 * out the SAME two scales as separate OS processes on separate boxes, and
 * refuses layouts that would only look distributed.
 *
 * Pure: no I/O, no clock, no randomness. Same inputs, same plan, every run,
 * which is what makes a drill result reproducible by a third party.
 ********************************************************************/

'use strict';

// Below N=4 there is no fault budget at all (quorum == N), so a "byzantine
// drill" at N<4 can only ever prove the trivial case.
const MIN_COUNT = 4;

// Classic PBFT: N = 3f+1 gives f = floor((N-1)/3) and quorum = 2f+1. Stated as
// the two derived numbers rather than assuming N is exactly 3f+1, because the
// drill runs at N=7 and N=10 where the floor actually bites.
function faultBudgetFor(count) {
    return Math.floor((count - 1) / 3);
}

function quorumFor(count) {
    return 2 * faultBudgetFor(count) + 1;
}

// Accept a host as either a bare string ('jdog@test-host.dankest.io', or an
// address for a local run) or a descriptor. `advertise` is what the OTHER
// boxes dial, so it must be routable from them: a loopback alias is only ever
// valid on a single-host shakedown, which is why the multi-host guard below
// rejects one.
function normalizeHosts(hosts) {
    if (!Array.isArray(hosts) || hosts.length === 0) {
        throw new Error('planDrill: `hosts` must be a non-empty array of host descriptors');
    }
    const seen = new Set();
    return hosts.map((h, i) => {
        const raw = (typeof h === 'string') ? { advertise: h } : (h || {});
        const advertise = raw.advertise || raw.host || null;
        if (!advertise) {
            throw new Error('planDrill: host[' + i + '] has no `advertise` address; the other boxes need something to dial');
        }
        const id = raw.id || advertise;
        if (seen.has(id)) {
            throw new Error('planDrill: duplicate host id "' + id + '"; each box must appear once');
        }
        seen.add(id);
        return {
            index:     i,
            id:        id,
            ssh:       raw.ssh || null,                  // null means "run here"
            advertise: advertise,
            // Extra bind addresses on this box (loopback aliases). Only meaningful
            // on a single-host shakedown; ignored once there are peers to dial.
            addresses: Array.isArray(raw.addresses) ? raw.addresses.slice() : [],
            // Path on the remote box to a file of `KEY=value` DB credentials the
            // child sources for itself. Credentials never travel through the
            // harness (and so never through an agent transcript).
            envFile:   raw.envFile || null,
            // Where xchain-hub lives on that box.
            hubPath:   raw.hubPath || null,
            nodePath:  raw.nodePath || 'node'
        };
    });
}

/**
 * Lay out a physical byzantine drill.
 *
 * @param {object}   opts
 * @param {number}   opts.count            validator count (N), >= 4
 * @param {number}  [opts.faults]          faults to inject (defaults to the full budget f)
 * @param {Array}    opts.hosts            host descriptors, see normalizeHosts
 * @param {number}  [opts.basePort]        first P2P port; ports are basePort+i, globally unique
 * @param {string}  [opts.dbPrefix]        per-node hub DB name prefix
 * @param {string}  [opts.runId]           run discriminator baked into DB names
 * @param {boolean} [opts.allowSingleHost] permit a one-box out-of-process shakedown
 * @returns {object} plan
 */
function planDrill(opts) {
    opts = opts || {};
    const count = opts.count;
    if (!Number.isInteger(count) || count < MIN_COUNT) {
        throw new Error('planDrill: count must be an integer >= ' + MIN_COUNT + ' (got ' + count + ')');
    }

    const quorum = quorumFor(count);
    const budget = faultBudgetFor(count);
    const faults = (opts.faults == null) ? budget : opts.faults;
    if (!Number.isInteger(faults) || faults < 1 || faults > budget) {
        throw new Error('planDrill: faults must be an integer in 1..' + budget + ' for N=' + count + ' (got ' + faults + ')');
    }

    const hosts = normalizeHosts(opts.hosts);
    const allowSingleHost = opts.allowSingleHost === true;
    if (hosts.length < 2 && !allowSingleHost) {
        throw new Error(
            'planDrill: one host is not a multi-box drill. Pass at least two boxes, or set ' +
            'allowSingleHost:true to run the out-of-process shakedown and label the result as such.'
        );
    }

    const basePort = Number.isInteger(opts.basePort) ? opts.basePort : 41000;
    const runId    = opts.runId || 'drill';
    const dbPrefix = opts.dbPrefix || 'XChain_BTC_Regtest_Drill_';

    // Round-robin so consecutive validators land on different boxes. Any
    // contiguous-block assignment would put a quorum-sized slab on box 0 at
    // small host counts, which is the exact layout the guards below reject.
    const nodes = [];
    const perHostIndexes = hosts.map(() => []);
    for (let i = 0; i < count; i++) {
        const host = hosts[i % hosts.length];
        const ordinalOnHost = Math.floor(i / hosts.length);
        const address = (hosts.length === 1 && host.addresses.length)
            ? host.addresses[ordinalOnHost % host.addresses.length]
            : host.advertise;
        const port = basePort + i;
        nodes.push({
            index:     i,
            id:        'v' + i,
            hostIndex: host.index,
            hostId:    host.id,
            ssh:       host.ssh,
            address:   address,
            port:      port,
            endpoint:  address + ':' + port,
            dbName:    dbPrefix + runId + '_' + i,
            role:      'honest'
        });
        perHostIndexes[host.index].push(i);
    }

    // Fault placement: take from the TAIL of each box in turn, so the faulty
    // set is spread over as many boxes as there are faults. A drill whose
    // faults all sit on one box is really a one-box-down test wearing a
    // byzantine label, and it would pass even against an implementation that
    // trusts every peer sharing its own host.
    const pools = perHostIndexes.map((g) => g.slice());
    const byzantineIndexes = [];
    let cursor = 0;
    while (byzantineIndexes.length < faults) {
        if (pools.every((p) => p.length === 0)) break;
        const pool = pools[cursor % pools.length];
        if (pool.length > 0) byzantineIndexes.push(pool.pop());
        cursor++;
    }
    byzantineIndexes.sort((a, b) => a - b);
    for (const i of byzantineIndexes) nodes[i].role = 'byzantine';

    const perHost = hosts.map((h, hi) => ({
        hostId:    h.id,
        validators: perHostIndexes[hi].length,
        byzantine:  perHostIndexes[hi].filter((i) => byzantineIndexes.includes(i)).length
    }));

    // Guard 1: no single box may hold quorum-many validators. If one box can
    // assemble a quorum by itself, the drill proves nothing about consensus
    // between boxes: a compromised host would carry the round alone.
    if (hosts.length >= 2) {
        const fat = perHost.find((h) => h.validators >= quorum);
        if (fat) {
            throw new Error(
                'planDrill: host "' + fat.hostId + '" holds ' + fat.validators + ' of ' + count +
                ' validators, which is >= quorum ' + quorum + '. That box could form a quorum alone. ' +
                'Add a box or lower N.'
            );
        }
    }

    // Guard 2: with two or more boxes and two or more faults, the faulty set
    // must straddle at least two boxes (see the placement note above).
    const byzantineHostCount = perHost.filter((h) => h.byzantine > 0).length;
    if (hosts.length >= 2 && faults >= 2 && byzantineHostCount < 2) {
        throw new Error('planDrill: internal placement error, all ' + faults + ' faults landed on one box');
    }

    // Not a guard, an audit fact: at N=7 over two boxes, losing the 4-validator
    // box leaves 3 live against a quorum of 5, so the federation stalls. True
    // box-loss survival needs enough boxes that count - max(perHost) >= quorum.
    const largestHost = perHost.reduce((m, h) => Math.max(m, h.validators), 0);
    const survivesHostLoss = (count - largestHost) >= quorum;

    return {
        count:              count,
        quorum:             quorum,
        faultBudget:        budget,
        faults:             faults,
        hosts:              hosts,
        nodes:              nodes,
        perHost:            perHost,
        byzantineIndexes:   byzantineIndexes,
        honestIndexes:      nodes.filter((n) => n.role === 'honest').map((n) => n.index),
        byzantineHostCount: byzantineHostCount,
        physicalMultiBox:   hosts.length >= 2,
        survivesHostLoss:   survivesHostLoss,
        // Seed list for node i: every other node's endpoint.
        seedsFor: function (i) {
            return this.nodes.filter((n) => n.index !== i).map((n) => n.endpoint);
        }
    };
}

// One-screen summary for the drill log and the eventual audit bundle.
function describePlan(plan) {
    const lines = [];
    lines.push('N=' + plan.count + '  quorum=' + plan.quorum + '  f=' + plan.faults + ' (budget ' + plan.faultBudget + ')');
    lines.push('boxes=' + plan.hosts.length + (plan.physicalMultiBox ? '' : '  [SINGLE-HOST SHAKEDOWN, not a multi-box result]'));
    for (const h of plan.perHost) {
        lines.push('  ' + h.hostId + ': ' + h.validators + ' validators, ' + h.byzantine + ' byzantine');
    }
    lines.push('survives loss of any one box: ' + (plan.survivesHostLoss ? 'yes' : 'no'));
    lines.push('byzantine: ' + plan.byzantineIndexes.map((i) => plan.nodes[i].id + '@' + plan.nodes[i].hostId).join(', '));
    return lines.join('\n');
}

module.exports = { planDrill, describePlan, quorumFor, faultBudgetFor, normalizeHosts, MIN_COUNT };
