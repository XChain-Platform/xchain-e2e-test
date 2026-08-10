/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * bin/contracts/spvSeed.js under the REAL VM .
 *
 * WHY THIS EXISTS. That contract's whole job is to put a known, shaped key set
 * onto a live chain before its armed `contract_state_root` height, so the
 * arming block commits a real sub-root instead of EMPTY_SMT_ROOT. It gets one
 * attempt per chain per height: BTC:testnet crosses 146500 once, and a contract
 * that turns out to write the wrong shape (or to revert on its second EXECUTE)
 * cannot be fixed retroactively. The linter proves it compiles. Only running it
 * proves it does what the seeding tool's plan says it does.
 *
 * What is asserted, and why each one is here rather than "it ran":
 *   - initialize writes the base set, so a DEPLOY alone leaves a non-empty tree;
 *   - fill is ADDITIVE and RESUMABLE across calls, which is the property the
 *     seeding tool depends on when it batches (each EXECUTE is a separate
 *     transaction, minutes apart, and a second call that reset or duplicated
 *     would silently produce the wrong live key count);
 *   - fill's key count is EXACT, because that count is what the arming block
 *     pays 42-53 ms and 256 node rows apiece for (spec §7 step 4), so an
 *     off-by-N here is an off-by-N in the arming budget;
 *   - remove emits a DELETE and not an empty write, which is the SQL-NULL
 *     tombstone case frozen in spec §3 Stage A and the one case the whole
 *     contract exists to put on a real chain;
 *   - owner gating holds, because this contract sits on a public testnet
 *     forever and an open `fill` is a free way for anyone to push the live key
 *     count past the arming budget;
 *   - the input guards reject rather than revert obscurely.
 *
 * Runs in-process (no isolated-vm), so it is portable to macOS where the
 * isolate binary is Linux-only.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

function loadVM() {
    for (const c of ['xchain-vm', '../../../xchain-vm', '../../../../xchain-vm']) {
        try { return require(c); } catch (e) { /* next */ }
    }
    return null;
}

const vmModule = loadVM();
const XChainVM = vmModule && (vmModule.XChainVM || vmModule);

const CODE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'bin', 'contracts', 'spvSeed.js'), 'utf8');

const OWNER  = 'mownerXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const STRANGER = 'mstrangerXXXXXXXXXXXXXXXXXXXXXXXXX';

// The REAL BTC gas schedule, not a hand-written subset. The VM validates the
// schedule against its own canonical key list, so a hand list rots the moment a
// key is added; more to the point, this contract will run on BTC:testnet under
// exactly these numbers, and a seed rehearsal priced differently from the chain
// is not a rehearsal.
function loadGasSchedule() {
    for (const c of ['../../../xchain-indexer/src/coins/BTC.js',
                     '../../../../xchain-indexer/src/coins/BTC.js']) {
        try { return require(path.resolve(__dirname, c)).GAS_SCHEDULE; } catch (e) { /* next */ }
    }
    return null;
}
const GAS_SCHEDULE = loadGasSchedule();

function createVM() {
    return new XChainVM({
        execution: 'in-process',
        gasSchedule: GAS_SCHEDULE,
        gasCeiling: 1000000,
        limits: {
            maxCpuTimeMs: 5000, maxMemory: 8, maxEmissions: 50,
            maxStateKeys: 10000, maxStateValueSize: 65536, maxCodeSize: 65536
        }
    });
}

function opts(method, params, state, caller) {
    return {
        code: CODE, method, params: params || [],
        state: state || {},
        caller: caller || OWNER,
        contractAddress: 'C:BTC:100',
        blockContext: { height: 146400, timestamp: 1785400000, hash: 'blockhash' }
    };
}

// The VM reports writes and deletes separately; a test that only looked at the
// merged state could not tell a delete from a write of ''. That distinction is
// the entire point of the tombstone case, so it is read off the raw result.
//
// `stateChanges` is an ARRAY of {key, value}, not a map. Folding it to a map
// here keeps the assertions readable, but the fold is deliberately strict: an
// unexpected shape must not quietly become an empty map and let every
// "wrote nothing" assertion pass for the wrong reason.
function changesOf(res) {
    const raw = res && res.stateChanges;
    if (raw === undefined || raw === null) return {};
    assert.ok(Array.isArray(raw), 'stateChanges should be an array, got ' + typeof raw);
    const out = {};
    for (const c of raw) out[c.key] = c.value;
    return out;
}
function deletesOf(res) {
    const raw = (res && res.stateDeletes) || [];
    assert.ok(Array.isArray(raw), 'stateDeletes should be an array');
    return raw;
}

// Apply a result onto a state object the way the indexer does, so a second call
// sees what the first one wrote.
function applied(state, res) {
    const next = Object.assign({}, state, changesOf(res));
    for (const k of deletesOf(res)) delete next[k];
    return next;
}

// Skipping on a missing VM is legitimate (the isolate binary is Linux-only), but
// skipping on a missing gas schedule would hide a broken resolve, so that is a
// failure instead.
(XChainVM ? describe : describe.skip)('spvSeed contract ( arming seed)', function () {

    it('resolved the real BTC gas schedule', function () {
        assert.ok(GAS_SCHEDULE, 'could not resolve xchain-indexer/src/coins/BTC.js GAS_SCHEDULE');
        assert.strictEqual(GAS_SCHEDULE.VM_STATE_WRITE, 200, 'sanity: the schedule is the real one');
    });

    this.timeout(30000);
    let vm;
    before(function () { vm = createVM(); });

    it('initialize writes the base key set, so a DEPLOY alone leaves a non-empty tree', async function () {
        const res = await vm.execute(opts('initialize', [], {}));
        assert.strictEqual(res.success, true, 'initialize should succeed: ' + (res.error || ''));
        const c = changesOf(res);
        assert.strictEqual(c['owner'], OWNER, 'owner is the deploying source');
        assert.strictEqual(c['seed/version'], '1');
        assert.ok(c['seed/purpose'], 'seed/purpose');
        assert.strictEqual(c['seed/count'], '0');
        assert.strictEqual(c['seed/doomed'], 'delete me', 'the key remove() will tombstone must exist first');
        assert.ok(c['seed/prefix/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/1'], 'prefix-sharing key 1');
        assert.ok(c['seed/prefix/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2'], 'prefix-sharing key 2');
        assert.strictEqual(Object.keys(c).length, 7, 'exactly the 7 documented base keys');
        assert.strictEqual(deletesOf(res).length, 0, 'initialize deletes nothing');
    });

    it('fill writes EXACTLY the requested number of keys (the arming budget depends on it)', async function () {
        const base = await vm.execute(opts('initialize', [], {}));
        const s0   = applied({}, base);

        const res = await vm.execute(opts('fill', ['seed/bulk/', '0', '25'], s0));
        assert.strictEqual(res.success, true, 'fill should succeed: ' + (res.error || ''));

        const c    = changesOf(res);
        const bulk = Object.keys(c).filter(k => k.indexOf('seed/bulk/') === 0);
        assert.strictEqual(bulk.length, 25, 'exactly 25 bulk keys, not 24 or 26');
        assert.strictEqual(c['seed/bulk/0'], '0', 'first key holds its own index');
        assert.strictEqual(c['seed/bulk/24'], '24', 'last key holds its own index');
        assert.strictEqual(c['seed/bulk/25'], undefined, 'and no key past the count');
        assert.strictEqual(c['seed/count'], '25', 'the counter tracks the high-water mark');
    });

    it('fill is additive and resumable across calls, which is what batching relies on', async function () {
        // Each batch is its own EXECUTE, minutes apart on a live chain. A second
        // call that reset the range, or re-wrote the first batch, would leave the
        // live key count silently wrong and the arming budget mis-sized.
        let s = applied({}, await vm.execute(opts('initialize', [], {})));
        s = applied(s, await vm.execute(opts('fill', ['seed/bulk/', '0', '10'], s)));
        const afterFirst = Object.keys(s).filter(k => k.indexOf('seed/bulk/') === 0).length;

        const second = await vm.execute(opts('fill', ['seed/bulk/', '10', '10'], s));
        assert.strictEqual(second.success, true, 'second batch should succeed: ' + (second.error || ''));
        s = applied(s, second);

        const bulk = Object.keys(s).filter(k => k.indexOf('seed/bulk/') === 0);
        assert.strictEqual(afterFirst, 10, 'first batch wrote 10');
        assert.strictEqual(bulk.length, 20, 'second batch ADDED 10 rather than replacing');
        assert.strictEqual(s['seed/bulk/0'], '0',  'the first batch survived the second');
        assert.strictEqual(s['seed/bulk/19'], '19', 'the second batch landed at its own offset');
        assert.strictEqual(s['seed/count'], '20');
    });

    it('remove emits a DELETE, not a write of an empty value (the SQL-NULL tombstone)', async function () {
        // Spec §3 Stage A: a tombstone maps to NO leaf. Writing '' instead would
        // commit leafHash('') and be a different, wrong, committed set. This is
        // the one case the contract exists to put on a real chain, so the test
        // reads the delete list rather than the merged state.
        const s = applied({}, await vm.execute(opts('initialize', [], {})));
        assert.strictEqual(s['seed/doomed'], 'delete me', 'precondition: the key is live');

        const res = await vm.execute(opts('remove', ['seed/doomed'], s));
        assert.strictEqual(res.success, true, 'remove should succeed: ' + (res.error || ''));
        assert.ok(deletesOf(res).indexOf('seed/doomed') !== -1, 'seed/doomed is DELETED');
        assert.strictEqual(changesOf(res)['seed/doomed'], undefined,
            'and is NOT written as an empty value, which would commit a leaf');
        assert.strictEqual(applied(s, res)['seed/doomed'], undefined, 'gone from live state');
    });

    it('write stores the raw string, which is what the leaf hashes', async function () {
        const s = applied({}, await vm.execute(opts('initialize', [], {})));
        const res = await vm.execute(opts('write', ['seed/manual', '7000'], s));
        assert.strictEqual(res.success, true, 'write should succeed: ' + (res.error || ''));
        assert.strictEqual(changesOf(res)['seed/manual'], '7000');
    });

    it('every mutating method is owner-gated (an open fill is an arming-budget hole)', async function () {
        const s = applied({}, await vm.execute(opts('initialize', [], {})));
        for (const [m, p] of [['fill', ['seed/bulk/', '0', '5']],
                              ['write', ['k', 'v']],
                              ['remove', ['seed/doomed']]]) {
            const res = await vm.execute(opts(m, p, s, STRANGER));
            assert.strictEqual(res.success, false, m + ' must reject a non-owner caller');
            assert.strictEqual(Object.keys(changesOf(res)).length, 0, m + ' wrote nothing on rejection');
            assert.strictEqual(deletesOf(res).length, 0, m + ' deleted nothing on rejection');
        }
    });

    it('fill rejects out-of-range counts rather than writing a partial batch', async function () {
        const s = applied({}, await vm.execute(opts('initialize', [], {})));
        for (const bad of [['seed/bulk/', '0', '0'], ['seed/bulk/', '0', '1001'], ['seed/bulk/', '-1', '5']]) {
            const res = await vm.execute(opts('fill', bad, s));
            assert.strictEqual(res.success, false, 'fill ' + JSON.stringify(bad) + ' must revert');
            assert.strictEqual(Object.keys(changesOf(res)).length, 0, 'and write nothing');
        }
    });
});
