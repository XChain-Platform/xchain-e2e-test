/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * LIVE cross-repo drift-lock for the consensus hash CONFORMANCE PAIR.
 *
 * xchain-sync validators independently recompute each block's ledger/actions/
 * contract hashes via src/BlockHasher.js, and HALT if they disagree with the
 * source. That only stays correct while BlockHasher is byte-identical to the
 * indexer's xchain-indexer/src/db.js getBlockHashes(). The unit golden in each
 * repo locks the serialization, but only THIS test exercises the full pipeline
 * (the 8 gathering queries + chaining + getDataHash) against REAL indexer-
 * produced data on the running stack.
 *
 * For every block the e2e stack has indexed, recompute the three hashes with
 * sync's BlockHasher against the indexer DB and assert they equal the indexer's
 * COMMITTED hashes (blocks -> index_transactions). Any drift between the two
 * implementations reddens here. Sync is not otherwise wired into the e2e stack;
 * this needs only the indexer DB (global.indexerDatabase) + the sibling sync repo.
 ********************************************************************/

const assert = require('assert');
const path   = require('path');

// Sibling xchain-sync (monorepo layout). If it's not present (sync excluded from
// a given checkout), skip rather than fail.
let BlockHasher, SyncUtility, SyncStateCommitment, SyncDatabase;
try {
    BlockHasher = require(path.join(__dirname, '../../../xchain-sync/src/BlockHasher.js'));
    SyncUtility = require(path.join(__dirname, '../../../xchain-sync/src/utility.js'));
    SyncStateCommitment = require(path.join(__dirname, '../../../xchain-sync/src/stateCommitment.js'));
    SyncDatabase        = require(path.join(__dirname, '../../../xchain-sync/src/db.js'));
} catch (e) { /* handled in before() */ }

const COMMITTED_HASH_SQL =
    'SELECT t1.hash AS ledger_hash, t2.hash AS actions_hash, t3.hash AS contract_hash ' +
    'FROM blocks b ' +
    'LEFT JOIN index_transactions t1 ON (t1.id = b.ledger_hash_id) ' +
    'LEFT JOIN index_transactions t2 ON (t2.id = b.actions_hash_id) ' +
    'LEFT JOIN index_transactions t3 ON (t3.id = b.contract_hash_id) ' +
    'WHERE b.block_index = ?';

describe('consensus hash conformance: sync BlockHasher == indexer committed hashes @regression', function () {
    this.timeout(0);

    let dbAdapter, hasher, blockIndexes;

    before(async function () {
        if (!BlockHasher || !SyncUtility) {
            console.log('xchain-sync not present alongside e2e; skipping conformance drift-lock');
            this.skip();
        }
        if (!global.indexerDatabase || !global.indexerDatabase.pool) {
            console.log('indexer DB not available; skipping conformance drift-lock');
            this.skip();
        }
        const pool = global.indexerDatabase.pool;
        // BlockHasher needs a `doQuery(sql, params)` over the INDEXER db.
        dbAdapter = {
            doQuery: async (sql, params) => {
                const conn = await pool.getConnection();
                try { return await conn.query(sql, params); }
                finally { conn.release(); }
            }
        };
        hasher = new BlockHasher(dbAdapter, new SyncUtility());
        const rows = await dbAdapter.doQuery('SELECT block_index FROM blocks ORDER BY block_index ASC', []);
        blockIndexes = rows.map(r => Number(r.block_index));
    });

    it('has indexed blocks to verify', function () {
        assert.ok(blockIndexes && blockIndexes.length > 0,
            'no blocks indexed: the e2e stack must have processed blocks before this runs');
    });

    it('every indexed block recomputes to its committed ledger/actions/contract hash', async function () {
        const mismatches = [];
        for (const idx of blockIndexes) {
            const computed = await hasher.computeBlockHashes(idx);
            const rows = await dbAdapter.doQuery(COMMITTED_HASH_SQL, [idx]);
            const committed = rows[0] || {};
            for (const f of ['ledger_hash', 'actions_hash', 'contract_hash']) {
                if (computed[f] !== committed[f]) {
                    mismatches.push({ block: idx, field: f, computed: computed[f], committed: committed[f] });
                }
            }
        }
        assert.strictEqual(mismatches.length, 0,
            'sync BlockHasher diverged from indexer committed hashes (conformance pair drifted). ' +
            'Update BOTH xchain-sync/src/BlockHasher.js and xchain-indexer/src/db.js getBlockHashes + ' +
            'regenerate the golden, and bump CONSENSUS_VERSION:\n' +
            JSON.stringify(mismatches.slice(0, 10), null, 2));
    });
});

// Load the protocol special-address map from xchain-sync (same frozen set used by
// the follower's getBlockLeafRows canonicalization). Used below to build the SQL
// IN-list that proves at least one canonicalized ledger row appeared during the run.
let ROLE_BY_ADDRESS;
try {
    ({ ROLE_BY_ADDRESS } = require(path.join(__dirname, '../../../xchain-sync/src/protocolAddressRoles.js')));
} catch (e) { /* handled in before() alongside the other sync guards */ }

// Light-client state-commitment conformance (SPV spec sec.4-5). The follower
// recomputes block_merkle_root from src/stateCommitment.js + db.getBlockLeafRows
// (a copy of BlockHasher's 10 content queries) and HALTs if it disagrees with the
// indexer's committed root. The unit golden locks the leaf serialization, but only
// THIS test exercises getBlockLeafRows + computeBlockMerkleRoot against REAL
// indexer-produced rows. Read-only: it never writes the indexer DB. (balances_root
// is covered by the persistent-vs-reference unit fuzz + the live regtest follower
// halt drill; stakes_root/state_root verification are deferred in Phase 1.)
describe('state commitment conformance: sync block_merkle_root == indexer committed roots @regression', function () {
    this.timeout(0);

    let dbAdapter, rootRows;

    before(async function () {
        if (!SyncStateCommitment || !SyncDatabase) {
            console.log('xchain-sync not present alongside e2e; skipping state-commitment drift-lock');
            this.skip();
        }
        if (!global.indexerDatabase || !global.indexerDatabase.pool) {
            console.log('indexer DB not available; skipping state-commitment drift-lock');
            this.skip();
        }
        const pool = global.indexerDatabase.pool;
        dbAdapter = {
            doQuery: async (sql, params) => {
                const conn = await pool.getConnection();
                try { return await conn.query(sql, params); }
                finally { conn.release(); }
            }
        };
        // computeBlockMerkleRoot reads its rows via db.getBlockLeafRows; bind the
        // follower Database method onto the read-only adapter (it only doQuery's).
        dbAdapter.getBlockLeafRows = SyncDatabase.prototype.getBlockLeafRows.bind(dbAdapter);
        rootRows = await dbAdapter.doQuery(
            'SELECT block_index, block_merkle_root FROM state_tree_roots ORDER BY block_index ASC', []);
    });

    it('has committed state_tree_roots to verify', function () {
        if (!rootRows || !rootRows.length) {
            console.log('no state_tree_roots rows (indexer build predates the light-client commitment or runs below the flag-day); skipping');
            this.skip();
        }
        assert.ok(rootRows.length > 0);
    });

    it('every block block_merkle_root recomputes to the indexer committed value', async function () {
        if (!rootRows || !rootRows.length) this.skip();
        const mismatches = [];
        for (const r of rootRows) {
            const computed = await SyncStateCommitment.computeBlockMerkleRoot(dbAdapter, Number(r.block_index));
            if (computed !== r.block_merkle_root) {
                mismatches.push({ block: Number(r.block_index), computed, committed: r.block_merkle_root });
            }
        }
        assert.strictEqual(mismatches.length, 0,
            'sync block_merkle_root diverged from indexer committed roots (block-content conformance pair drifted). ' +
            'Update BOTH xchain-sync/src/db.js getBlockLeafRows / stateCommitment.js and the indexer side, then ' +
            'regenerate the golden:\n' + JSON.stringify(mismatches.slice(0, 10), null, 2));
    });

    // Guard that the canonicalization path was actually exercised. Without at least
    // one special-address ledger row (BURN/GAS/DONATE/REWARD) in the indexed blocks,
    // the recompute loop above can pass while never touching the canonicalization code
    // that the consensus fix introduced. This assertion makes the guard fail-meaningful
    // rather than vacuously green on a run that never credited a protocol address.
    // The e2e suite's ISSUE/SEND/etc. actions generate protocol fees credited to
    // DONATE1/DONATE2; the MINT gas bootstrap credits GAS. Both paths are exercised
    // before this test file runs, so skipping here is a signal worth surfacing.
    it('at least one indexed block credits a protocol special address (canonicalization was exercised)', async function () {
        if (!rootRows || !rootRows.length) this.skip();
        if (!ROLE_BY_ADDRESS) {
            console.log('protocolAddressRoles not available; skipping special-address coverage check');
            this.skip();
        }
        const specialAddresses = Object.keys(ROLE_BY_ADDRESS);
        // Build a parameterized IN-list so no address is hardcoded here.
        const placeholders = specialAddresses.map(() => '?').join(', ');
        // credits/debits store the address as a normalized integer FK
        // (address_id -> index_addresses.id), not a raw `address` column, so the
        // coverage probe must join through index_addresses. ROLE_BY_ADDRESS is
        // all-chain (it carries the LTC/DOGE regtest forms too), so the IN-list
        // matches whichever coin/network this DB belongs to.
        const creditsRows = await dbAdapter.doQuery(
            'SELECT ia.address FROM credits c JOIN index_addresses ia ON ia.id = c.address_id ' +
            'WHERE ia.address IN (' + placeholders + ') LIMIT 1',
            specialAddresses
        );
        const debitsRows  = creditsRows.length ? creditsRows : await dbAdapter.doQuery(
            'SELECT ia.address FROM debits d JOIN index_addresses ia ON ia.id = d.address_id ' +
            'WHERE ia.address IN (' + placeholders + ') LIMIT 1',
            specialAddresses
        );
        assert.ok(
            creditsRows.length > 0 || debitsRows.length > 0,
            'no protocol special-address ledger row found in credits or debits; the suite ran without ' +
            'exercising special-address canonicalization. Ensure at least one ISSUE/SEND/fee-paying ' +
            'action precedes this test so the block_merkle_root conformance check is not vacuously green.'
        );
    });
});
