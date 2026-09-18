/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 * Cross-service TRAIN_ACTIVATION parity, and the byte twin that carries it.
 *
 * TRAIN_ACTIVATION is the rolling-upgrade boundary: keyed by platform version, then
 * network, to a BTC height at which the fleet switches rule sets. A node that does
 * not implement the rule set the map requires at the height it has reached HALTS
 * (train_gate.evaluateTrainActivation), so a single height disagreeing between two
 * services splits the fleet at a boundary neither operator chose: one half grades the
 * new rules, the other halts, and the halting half is the one whose copy is stale.
 *
 * The row lives in the SHARED registry block part 5, which is a registered byte twin
 * (claude/bin/frozen-twins.json, canonical xchain-indexer) copied into xchain-hub,
 * xchain-sync, xchain-explorer, xchain-sdk and the xchain-documentation reference
 * implementation. Until this file existed nothing in the parity tier read part 5 at
 * all: reverting a TRAIN_ACTIVATION testnet height in one consumer left the tier at
 * 45 passing, while the same experiment on part 2's CHECKPOINT_COMMITMENT row went
 * red. That gap is what this file closes, in the shape the part 2 coverage already
 * uses (value equality against the canonical SoT, key-set shape, verdict agreement)
 * plus a whole-file byte grade so EVERY row in part 5 is guarded, not just this one.
 *
 * Only xchain-indexer and xchain-sync carry train_gate.js; hub, sdk and explorer carry
 * the row and no resolver. The verdict case therefore drives BOTH resolvers over EVERY
 * repo's copy of the map, which is the pairing that actually matters: the resolver is
 * itself a twin, so what can disagree is the map each service feeds it.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const protocolConstants = require(path.join(ROOT, 'xchain-documentation/protocol/constants.js'));

const TRAIN_KEY      = 'train_activation.TRAIN_ACTIVATION';
const REGISTRY_ENTRY = 'src/consensus/gate_registry.js';

const hubTrain  = require(path.join(ROOT, 'xchain-hub',      REGISTRY_ENTRY));
const idxTrain  = require(path.join(ROOT, 'xchain-indexer',  REGISTRY_ENTRY));
const sdkTrain  = require(path.join(ROOT, 'xchain-sdk',      REGISTRY_ENTRY));
const expTrain  = require(path.join(ROOT, 'xchain-explorer', REGISTRY_ENTRY));
const syncTrain = require(path.join(ROOT, 'xchain-sync',     REGISTRY_ENTRY));

const REGISTRIES = [
    ['hub',      hubTrain],
    ['indexer',  idxTrain],
    ['sdk',      sdkTrain],
    ['explorer', expTrain],
    ['sync',     syncTrain]
];

// The two train gates on the fleet. Each is a twin of the other; each takes the map as
// an argument, so either can be driven over any service's copy of the row.
const RESOLVERS = [
    ['indexer', require(path.join(ROOT, 'xchain-indexer/src/consensus/gates/train_gate.js'))],
    ['sync',    require(path.join(ROOT, 'xchain-sync/src/consensus/gates/train_gate.js'))]
];

// The registry part that carries the row. The indexer is canonical under
// src/protocol_changes/; every consumer keeps the same bytes under its own
// gate_registry/ directory. Two candidate spellings are read for the canonical so the
// guard survives a layout move, and a checkout with neither FAILS naming both rather
// than skipping, because a skipped twin guard is how a copy drifts without a red run.
const PART = 'shared_rows_5.js';
const CANONICAL_CANDIDATES = [
    'xchain-indexer/src/protocol_changes/' + PART,
    'xchain-indexer/src/consensus/gate_registry/' + PART
];
const COPY_PATHS = [
    ['hub',           'xchain-hub/src/consensus/gate_registry/' + PART],
    ['sync',          'xchain-sync/src/consensus/gate_registry/' + PART],
    ['explorer',      'xchain-explorer/src/consensus/gate_registry/' + PART],
    ['sdk',           'xchain-sdk/src/consensus/gate_registry/' + PART],
    ['documentation', 'xchain-documentation/protocol/reference-impl/consensus/gate_registry/' + PART]
];

// Probe heights derived FROM the canonical map rather than written here, so a row added
// at a later cut is probed at its own boundary with no edit to this file: every height
// in the map is probed one below, at, and one above, which is where an off-by-one
// divergence between two copies shows up as a different rule set.
function probeHeights(map) {
    const out = new Set([0, 1, 999999999999]);
    for (const perNetwork of Object.values(map)) {
        for (const h of Object.values(perNetwork)) {
            if (typeof h !== 'number') continue;
            out.add(Math.max(0, h - 1));
            out.add(h);
            out.add(h + 1);
        }
    }
    return [...out].sort((a, b) => a - b);
}

describe('TRAIN_ACTIVATION cross-service parity (SHARED registry part 5)', function () {

    it('the TRAIN_ACTIVATION row is value-equal across all five local registries and the canonical SoT', function () {
        const canonical = protocolConstants.TRAIN_ACTIVATION;
        assert.ok(canonical, 'documentation/protocol/constants.js must export TRAIN_ACTIVATION');
        for (const [name, mod] of REGISTRIES) {
            assert.deepStrictEqual(mod.copy(TRAIN_KEY), canonical,
                name + ' TRAIN_ACTIVATION drifted from the canonical protocol constant');
        }
    });

    it('every registry names the same rule-set versions, and the same networks within each version', function () {
        // The value case above holds the heights; this pins the SHAPE. A rule set present
        // in one copy and absent in another resolves to a DIFFERENT active rule set on the
        // same chain even when every shared height reads equal, and a network slot added on
        // one side only leaves that network resolving to nothing on the other.
        const canonical = protocolConstants.TRAIN_ACTIVATION;
        const versions  = Object.keys(canonical).sort();
        for (const [name, mod] of REGISTRIES) {
            const row = mod.copy(TRAIN_KEY);
            assert.deepStrictEqual(Object.keys(row).sort(), versions,
                name + ' TRAIN_ACTIVATION names a different rule-set version set from the canonical map');
            for (const version of versions) {
                assert.deepStrictEqual(Object.keys(row[version]).sort(), Object.keys(canonical[version]).sort(),
                    name + ' TRAIN_ACTIVATION rule set ' + version + ' names a different network set from the canonical map');
            }
        }
    });

    it('both train gates return the same halt verdict for every copy of the map', function () {
        // This is the behaviour the row exists to drive. evaluateTrainActivation halts a
        // node whose map does not CONTAIN the rule set the signed release manifest requires
        // (implementedRuleSets is read off the map, so the map is the record of what the
        // binary can apply), and otherwise clears it. A rule set present in one service's
        // copy and missing from another therefore splits the fleet at that manifest: half
        // clears and grades the new rules, half halts. Drive both twins of the gate over
        // every service's copy at every rule set the canon names, at its own boundary and
        // one block either side, and require one status everywhere.
        const canonical = protocolConstants.TRAIN_ACTIVATION;
        const networks  = [...new Set(Object.values(canonical).flatMap((v) => Object.keys(v)))].sort();
        for (const version of Object.keys(canonical)) {
            const required = { ruleSetVersion: version, heights: canonical[version] };
            for (const network of networks) {
                const at = canonical[version][network];
                for (const height of [0, at - 1, at, at + 1, 999999999999]) {
                    const expected = RESOLVERS[0][1].evaluateTrainActivation(
                        { network, height, required, activation: canonical }).status;
                    for (const [resolverName, gate] of RESOLVERS) {
                        for (const [name, mod] of REGISTRIES) {
                            const got = gate.evaluateTrainActivation(
                                { network, height, required, activation: mod.copy(TRAIN_KEY) }).status;
                            assert.strictEqual(got, expected,
                                'train-gate verdict disagreement for rule set ' + version + ' on '
                                + network + '@' + height + ': the ' + resolverName + ' gate over the '
                                + name + ' TRAIN_ACTIVATION map says ' + JSON.stringify(got)
                                + ', the canonical map says ' + JSON.stringify(expected));
                        }
                    }
                }
            }
        }
    });

    it('shared_rows_5.js is byte-identical across the indexer canonical and all five copies', function () {
        // The cases above grade ONE row. This grades the whole part, which is what
        // frozen-twins.json actually registers: every other row in part 5
        // (TOKEN_POLICY_INHERITANCE_ACTIVATION, XCHAIN_BRIDGE_ACTIVATION) is a
        // consensus boundary too, and a value-level case per row would be added a cut
        // late every time. The consumers replace nothing: the require line, the header
        // and the SHARED-GATES block are the same bytes in all six checkouts.
        const canonRel = CANONICAL_CANDIDATES.find((p) => fs.existsSync(path.join(ROOT, p)));
        assert.ok(canonRel, 'the canonical ' + PART + ' resolved at neither '
            + CANONICAL_CANDIDATES.map((p) => path.join(ROOT, p)).join(' nor '));
        const canon = fs.readFileSync(path.join(ROOT, canonRel), 'utf8');
        for (const [name, rel] of COPY_PATHS) {
            const abs = path.join(ROOT, rel);
            assert.ok(fs.existsSync(abs), name + ' is registered as a ' + PART + ' twin but ' + abs + ' does not exist');
            assert.strictEqual(fs.readFileSync(abs, 'utf8'), canon,
                rel + ' drifted from the canonical ' + canonRel);
        }
    });
});
