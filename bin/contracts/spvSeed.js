// @ts-nocheck
//
// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// SPV sub-tree seed contract (, spec claude/specs/spv-state-subtree-extension.md).
//
// WHY THIS EXISTS. A chain whose `contract_state` table is empty commits
// EMPTY_SMT_ROOT into the armed `contract_state_root` slot, which is
// byte-identical to the padding an ABSENT slot contributes (spec §2). So the
// arming boundary on such a chain exercises the version flip and the deploy
// train and nothing else: no derivation, no proof endpoint, no SDK verifier.
// This contract's only job is to put a known, shaped key set on a live chain
// before its armed height, so the boundary has something real to commit.
//
// WHAT IT WRITES, and why each shape is here rather than "some keys". The
// row-to-leaf mapping frozen in spec §3 Stage A has four cases, and three of
// them are reachable through the VM:
//
//   - an ORDINARY value           -> leafHash(state_value) over the RAW stored
//                                    string, never the JSON.parse'd form;
//   - a TOMBSTONE (state.delete)  -> SQL-NULL state_value, which maps to NO
//                                    leaf: an SMT delete, never leafHash(null);
//   - an ABSENT key               -> no row at all, which a client must be able
//                                    to prove as non-inclusion.
//
// The fourth (`state_value = ''`, distinct from absent) is NOT reachable here
// and deliberately so: values are JSON.stringify'd on the way in, so an empty
// string is stored as the two bytes `""`. Spec §3 records that branch as
// defensive and unreachable through the VM; a contract that pretended to reach
// it would be asserting something false on a live chain.
//
// The `fill` method exists because block time, not gas, is the binding
// constraint on a public testnet: at roughly one block every twenty minutes a
// key-per-transaction seed would take weeks, so one EXECUTE writes a whole
// batch. Keys share a caller-supplied prefix, which also puts the "prefix"
// key-set shape from the §7 step-4 benchmark on a real chain (that measurement
// found the shape does not matter, because the SMT key is a digest and
// copy-on-write writes all 256 levels per key regardless; seeding a clustered
// set is how that stops being a synthetic claim).
//
// Every method is owner-gated except the reads. This contract will sit on a
// public testnet forever, and an unguarded `fill` is a free way for anyone to
// push the chain's live key count past the arming-block budget in §7 step 4.

module.exports = {

    // Base key set, written at DEPLOY. Deliberately small and hand-listed: these
    // are the keys a proof round-trip is run against by hand afterwards, so they
    // need to be predictable rather than generated.
    initialize: function (xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('seed/version', '1');
        xchain.state.set('seed/purpose', ' contract_state_root arming seed');

        // A numeric-looking value, to make it visible that the leaf hashes the
        // STORED STRING and not a parsed number.
        xchain.state.set('seed/count', '0');

        // A key that will be tombstoned by `remove` later, so the deletion case
        // exists on-chain rather than only in the golden vectors.
        xchain.state.set('seed/doomed', 'delete me');

        // Two keys sharing a long prefix, so the committed set is not trivially
        // flat even before `fill` runs.
        xchain.state.set('seed/prefix/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1', 'p1');
        xchain.state.set('seed/prefix/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2', 'p2');
    },

    // Write one key. params: [key, value]
    write: function (xchain) {
        var key = xchain.getInputParam(0);
        var val = xchain.getInputParam(1);
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'only owner');
        xchain.require(key, 'key required');
        xchain.require(val !== null && val !== undefined, 'value required');
        xchain.state.set(key, val);
        return key;
    },

    // Tombstone one key: the SQL-NULL `state_value` row that spec §3 maps to NO
    // leaf. Distinct from writing an empty value, which is why it is its own
    // method rather than `write(key, '')`.
    // params: [key]
    remove: function (xchain) {
        var key = xchain.getInputParam(0);
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'only owner');
        xchain.require(key, 'key required');
        xchain.state.delete(key);
        return key;
    },

    // Write `count` keys named <prefix><start+i>, each holding its own index as
    // a decimal string. One transaction, many leaves. params: [prefix, start, count]
    //
    // The caller sizes the batch: gas is charged per write (VM_STATE_WRITE), and
    // the LIVE key total it produces is what the arming block's buildFull has to
    // pay for at ~42-53 ms and 256 node rows per key (spec §7 step 4). The
    // seeding tool projects that cost before it broadcasts; this method just
    // refuses the obviously-wrong inputs.
    fill: function (xchain) {
        var prefix = xchain.getInputParam(0);
        var start  = parseInt(xchain.getInputParam(1), 10);
        var count  = parseInt(xchain.getInputParam(2), 10);

        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'only owner');
        xchain.require(prefix, 'prefix required');
        xchain.require(start >= 0, 'start must be >= 0');
        xchain.require(count > 0 && count <= 1000, 'count must be 1..1000');

        for (var i = 0; i < count; i++) {
            var n = start + i;
            xchain.state.set(prefix + n, String(n));
        }
        xchain.state.set('seed/count', String(start + count));
        return String(count);
    },

    // Reads, for a by-hand sanity check against a served proof.
    get: function (xchain) {
        var key = xchain.getInputParam(0);
        xchain.require(key, 'key required');
        return xchain.state.get(key);
    },

    getCount: function (xchain) {
        return xchain.state.get('seed/count');
    }
};
