// @ts-nocheck
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2025-2026 Dankest, LLC - https://dankest.llc
//
// SPV sub-tree arming seed (XC-871). Puts a known, shaped contract_state key set
// on a live chain before its armed contract_state_root height, so the arming
// block commits a real sub-root instead of EMPTY_SMT_ROOT.
//
// EVERY BYTE HERE IS ON-CHAIN. The source is base64'd into a single DEPLOY
// action capped at 8192 chars (~6132 source bytes), and it is billed per byte
// (VM_DEPLOY_PER_BYTE). The full reasoning for each method, and the assertions
// that pin it, live in test/unit/spvSeedContract.test.js; keep it there, not here.
//
// Key shapes, per the frozen row-to-leaf mapping in the spec's §3 Stage A:
//   ordinary value -> leafHash(raw stored string)
//   state.delete   -> SQL-NULL state_value, an SMT delete, NO leaf
//   absent key     -> no row, provable as non-inclusion
// The fourth case (state_value = '') is unreachable through the VM, because
// values are JSON.stringify'd, so it is deliberately not attempted.
//
// Mutating methods are owner-gated: this sits on a public testnet forever, and
// an open fill() lets anyone push the live key count past the arming budget.

module.exports = {

    initialize: function (xchain) {
        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('seed/version', '1');
        xchain.state.set('seed/purpose', 'XC-871 arming seed');
        xchain.state.set('seed/count', '0');
        // Tombstoned later by remove(), so the SQL-NULL case exists on-chain.
        xchain.state.set('seed/doomed', 'delete me');
        // Two keys sharing a long prefix, so the set is not trivially flat.
        xchain.state.set('seed/prefix/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1', 'p1');
        xchain.state.set('seed/prefix/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2', 'p2');
    },

    // params: [key, value]
    write: function (xchain) {
        var key = xchain.getInputParam(0);
        var val = xchain.getInputParam(1);
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'only owner');
        xchain.require(key, 'key required');
        xchain.require(val !== null && val !== undefined, 'value required');
        xchain.state.set(key, val);
        return key;
    },

    // params: [key]. A DELETE, never a write of '': the two commit different sets.
    remove: function (xchain) {
        var key = xchain.getInputParam(0);
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'only owner');
        xchain.require(key, 'key required');
        xchain.state.delete(key);
        return key;
    },

    // params: [prefix, start, count]. One transaction, many leaves: block time,
    // not gas, is the binding constraint on a public testnet. The caller sizes
    // the batch; the resulting LIVE key count is what the arming block pays
    // ~42-53 ms and 256 node rows apiece for.
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

    get: function (xchain) {
        var key = xchain.getInputParam(0);
        xchain.require(key, 'key required');
        return xchain.state.get(key);
    },

    getCount: function (xchain) {
        return xchain.state.get('seed/count');
    }
};
