// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Delegated-reward SOURCE RESOLUTION drill (BTC regtest).
//
// Validates the indexer reward-source resolver against REAL on-chain
// delegated-key data, covering the fixes in:
//   - xchain-indexer src/stake-source.js   (d0abcfd: archive/recovery leg)
//   - xchain-indexer src/db.js             (828db2d: reward-writer leg shares
//                                            the identical active-row predicates)
//
// The hub's StateAnchorPublisher pins each reward's earn-time staking source
// via getStakeSourceByPubkey (archive leg); the reward writer resolves the same
// source via _resolveActiveStakeSourceId. Both MUST agree, and a key COUNTED in
// the effective set must always resolve, or the publisher defers a reward it can
// never settle and suppresses the whole V1 archive batch.
//
// Two pre-fix divergences this drill exercises live:
//   1. Happy path: a delegated key resolves to its staking source via the
//      delegations fallback (also covered by the live RPC).
//   2. Slash edge: the pre-fix archive leg OMITTED the permanent-slash
//      (capability_slash_events) exclusion, so a slashed delegated key (dropped
//      from the effective set, hence NOT earning) would still RESOLVE pre-fix.
//      The fixed resolver excludes it, matching effective-set membership.
//
// We exercise the MASTER (fixed) resolver directly (it is pure SQL over a passed
// db, so it runs against the live indexer DB through the e2e connection), then
// contrast it with the pre-fix delegations SQL inline. This proves the fix on
// real data regardless of the running indexer service's code version. The
// writer leg (_resolveActiveStakeSourceId) uses these identical predicates,
// locked by xchain-indexer/test/unit/reward-source-resolution.test.js.

const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const cryptoHelper = require('../cryptoHelper')
const stakeHelper = require('../helpers/stakeHelper')
const gasHelper = require('../helpers/gasHelper')

// Load the MASTER (fixed) xchain-indexer stake-source resolver. Prefer a
// co-located copy (used inside the e2e image, where the monorepo layout is not
// present); otherwise fall back to the adjacent xchain-indexer source for
// host/monorepo runs. stake-source.js is pure SQL over a passed db, so it has
// no deps and runs against the live indexer DB through the e2e connection,
// independent of the deployed indexer service's code version.
function loadStakeSourceModule() {
    const localFixture = path.resolve(__dirname, 'stakeSourceMaster.fixture.js')
    if (fs.existsSync(localFixture)) return require(localFixture)
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH && path.join(process.env.XCHAIN_INDEXER_PATH, 'src/stake-source.js'),
        path.resolve(__dirname, '../../../xchain-indexer/src/stake-source.js'),
        path.resolve(__dirname, '../../../../xchain-indexer/src/stake-source.js'),
        path.resolve(__dirname, '../../../../../modules/xchain-indexer/src/stake-source.js')
    ].filter(Boolean)
    for (const p of candidates) if (fs.existsSync(p)) return require(p)
    throw new Error('cannot load master stake-source.js; place stakeSourceMaster.fixture.js beside this test or set XCHAIN_INDEXER_PATH')
}
const { getStakeSourceByPubkey } = loadStakeSourceModule()

// Load the MASTER xchain-indexer Database class so we can run the REAL
// reward-writer leg (_resolveActiveStakeSourceId, 828db2d) against the live DB.
// That method only uses this.doQuery + this.getStatusId, so we bind it to the
// same adapter rather than constructing a full Database. Requires the master
// src dir to be present (XCHAIN_INDEXER_PATH inside the e2e image, or adjacent
// in the monorepo); db.js's only non-builtin deps are mariadb + ./stateHash.
function loadIndexerDbModule() {
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH && path.join(process.env.XCHAIN_INDEXER_PATH, 'src/db.js'),
        path.resolve(__dirname, '../../../xchain-indexer/src/db.js'),
        path.resolve(__dirname, '../../../../xchain-indexer/src/db.js'),
        path.resolve(__dirname, '../../../../../modules/xchain-indexer/src/db.js')
    ].filter(Boolean)
    for (const p of candidates) if (fs.existsSync(p)) return require(p)
    throw new Error('cannot load master xchain-indexer db.js; set XCHAIN_INDEXER_PATH or run in the monorepo')
}
const MasterIndexerDb = loadIndexerDbModule()

describe('Delegated reward SOURCE RESOLUTION on real on-chain data (d0abcfd / 828db2d)', function () {

    const CAPABILITY = 'price'
    // Caller-supplied threshold (getcapabilityvalidators honours it over the
    // venue MIN_STAKE config), so the drill is independent of per-venue config.
    const MIN_STAKE = '1000'
    const STAKE_AMOUNT = '1000.00000000'

    let addrA = null        // stakes pubkeyA, delegates pubkeyB
    let pubkeyA = null      // original stake signing key
    let pubkeyB = null      // delegated signing key (the d0abcfd-relevant path)
    let blockB = null       // block at which we resolve (latest indexed)
    let createdSlashTable = false  // true if this drill created capability_slash_events (older DB)

    // Minimal db adapter satisfying stake-source.js's contract, backed by the
    // e2e indexer DB connection. Mirrors the master Database getPubkeyId /
    // getStatusId / doQuery exactly.
    const idxDb = {
        async doQuery(sql, params) {
            const conn = await indexerDatabase.getConnection()
            try { return await conn.query(sql, params) }
            finally { await conn.release() }
        },
        async getPubkeyId(pubkey) {
            const r = await this.doQuery('SELECT id FROM index_pubkeys WHERE `pubkey`=? LIMIT 1', [pubkey])
            return r.length > 0 ? Number(r[0].id) : null
        },
        async getStatusId(status) {
            const r = await this.doQuery('SELECT id FROM index_statuses WHERE status=? LIMIT 1', [status])
            return r.length > 0 ? Number(r[0].id) : null
        },
        // stake-source.js resolves through apiView() so federation READS draw an
        // independent pooled connection and never adopt an open block transaction
        // (H2). This adapter already has that property by construction:
        // every doQuery takes a fresh connection from the pool and releases it, so
        // it is never inside anyone's transaction. Returning `this` is therefore the
        // honest view here, not a stub that papers over the isolation the real
        // apiView provides. Without it the drill dies on
        // `indexer.indexerDb.apiView is not a function`.
        apiView() { return this }
    }
    const indexerLike = { indexerDb: idxDb }

    function newPubkey() {
        let { publicKey } = crypto.generateKeyPairSync('ed25519')
        return publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')
    }

    async function syncPast(blockIndex) {
        await regtestMinerConnector.generateBlocks(7)
        let ok = await indexerConnector.waitForIndexedBlock(Number(blockIndex), 90000)
        assert(ok, 'indexer did not reach block ' + blockIndex + ' in time')
    }

    async function effectivePubkeys() {
        let health = await indexerConnector.health()
        assert(health && health.lastIndexedBlock !== null, 'indexer health should report lastIndexedBlock')
        let result = await indexerConnector.getCapabilityValidators(CAPABILITY, health.lastIndexedBlock, MIN_STAKE)
        assert(result && !result.error, 'getcapabilityvalidators should answer; got: ' + (result && result.error))
        return result.validators.map(v => String(v.pubkey).toLowerCase())
    }

    // The master resolver references capability_slash_events (WI-2 permanent
    // slash). Older indexer DBs predate that migration, so create the table for
    // the drill if absent (mirrors src/sql/capability_slash_events.sql) and drop
    // it afterwards if we created it, leaving the venue as found. Inert to a
    // pre-WI-2 indexer, which never queries it.
    async function ensureSlashTable() {
        let exists = await idxDb.doQuery(
            "SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='capability_slash_events'")
        if (Number(exists[0].c) > 0) return false
        await idxDb.doQuery(`CREATE TABLE capability_slash_events (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            slash_action_index BIGINT UNSIGNED NOT NULL,
            signing_pubkey_id BIGINT UNSIGNED NOT NULL,
            capability VARCHAR(64) NOT NULL,
            equiv_key VARCHAR(250) NOT NULL,
            amount VARCHAR(250) NOT NULL,
            bounty_amount VARCHAR(250) NOT NULL DEFAULT '0',
            treasury_amount VARCHAR(250) NOT NULL DEFAULT '0',
            submitter_id BIGINT UNSIGNED,
            destination_id BIGINT UNSIGNED,
            block_index BIGINT UNSIGNED NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci`)
        await idxDb.doQuery('CREATE INDEX signing_pubkey_id ON capability_slash_events (signing_pubkey_id)')
        await idxDb.doQuery('CREATE INDEX block_index ON capability_slash_events (block_index)')
        return true
    }

    before(async function () {
        // Capability STAKE/DELEGATE v0 are BTC-only by protocol design.
        if (COIN_CODE !== 'BTC') {
            console.log('Reward-source resolution drill is BTC-only; skipping on ' + COIN_CODE)
            this.skip()
            return
        }
        createdSlashTable = await ensureSlashTable()
        addrA = await cryptoHelper.getNewFundedAddress('delreward-staker', COIN, NETWORK, null, 'legacy', 0, 1)
        await gasHelper.ensureGasBalance(addrA, '2000')
        pubkeyA = newPubkey()
        pubkeyB = newPubkey()
    })

    after(async function () {
        if (createdSlashTable) {
            try { await idxDb.doQuery('DROP TABLE IF EXISTS capability_slash_events') }
            catch (e) { console.log('cleanup: could not drop capability_slash_events: ' + e.message) }
        }
    })

    it('STAKE v1 (pubkeyA) then DELEGATE v0 (pubkeyB): both land in the effective set', async function () {
        let staked = await stakeHelper.sendStakeV1(addrA, STAKE_AMOUNT, pubkeyA)
        assert(staked.stake && staked.stake.status === 'valid', 'stake should be valid')
        await syncPast(staked.stake.activation_block)
        let set1 = await effectivePubkeys()
        assert(set1.includes(pubkeyA), 'pubkeyA should be effective after stake activation')

        let delegated = await stakeHelper.sendDelegateV0(addrA, pubkeyB)
        assert(delegated.delegation && delegated.delegation.status === 'valid', 'delegation should be valid')
        await syncPast(delegated.delegation.activation_block)
        let set2 = await effectivePubkeys()
        assert(set2.includes(pubkeyA), 'pubkeyA must remain effective (additive-until-revoked)')
        assert(set2.includes(pubkeyB), 'delegated pubkeyB must be effective after activation')

        let health = await indexerConnector.health()
        blockB = Number(health.lastIndexedBlock)
    })

    it('FIXED resolver resolves the delegated key to its staking source (and agrees with the live RPC)', async function () {
        // Master stake-source.js (the archive/recovery leg d0abcfd fixed),
        // run directly against the real indexer DB.
        let viaStake = await getStakeSourceByPubkey(indexerLike, { pubkey: pubkeyA, block_index: blockB })
        assert(!viaStake.error, 'pubkeyA resolution should not error: ' + viaStake.error)
        assert.strictEqual(viaStake.source, addrA.address, 'pubkeyA resolves via its stakes row')

        let viaDelegation = await getStakeSourceByPubkey(indexerLike, { pubkey: pubkeyB, block_index: blockB })
        assert(!viaDelegation.error, 'pubkeyB resolution should not error: ' + viaDelegation.error)
        assert.strictEqual(viaDelegation.source, addrA.address,
            'delegated pubkeyB resolves to addrA via the delegations fallback (counted -> must resolve)')

        // Live RPC sanity: in the happy path pre- and post-fix agree; this
        // guards that the master resolver matches the deployed service here.
        let rpc = await indexerConnector.getStakeSourceByPubkey(pubkeyB, blockB)
        assert(rpc && !rpc.error, 'live RPC resolution should answer')
        assert.strictEqual(rpc.source, addrA.address, 'live RPC also resolves pubkeyB to addrA')
    })

    it('recovery byte-identity: the reward-writer leg and the archive/recovery leg resolve the SAME source (828db2d)', async function () {
        // Archive/recovery leg: getStakeSourceByPubkey is what the hub pins into
        // the ANCHOR archive, and what recovery.js restores as source_id via
        // createAddress(r.source) (xchain-indexer/src/recovery.js:280-288).
        let archive = await getStakeSourceByPubkey(indexerLike, { pubkey: pubkeyB, block_index: blockB })
        assert(!archive.error, 'archive-leg resolution should not error: ' + archive.error)
        assert.strictEqual(archive.source, addrA.address, 'archive leg resolves delegated pubkeyB to addrA')

        // Normal-write leg: the REAL master _resolveActiveStakeSourceId, bound to
        // our DB adapter (it uses only this.doQuery + this.getStatusId).
        // createValidatorReward stores exactly this source_id.
        let pubkeyBId = await idxDb.getPubkeyId(pubkeyB.toLowerCase())
        assert(pubkeyBId, 'pubkeyB must have an index_pubkeys id')
        let writerSourceId = await MasterIndexerDb.prototype._resolveActiveStakeSourceId.call(idxDb, pubkeyBId, blockB)
        assert(writerSourceId !== null && writerSourceId !== undefined,
            'writer leg must resolve a source_id (a counted key must resolve)')
        let writerRow = await idxDb.doQuery('SELECT address FROM index_addresses WHERE id=?', [writerSourceId])
        let writerAddr = writerRow.length ? String(writerRow[0].address) : null

        // The invariant ANCHOR recovery relies on: the source_id the normal path
        // STORED must equal the source the archive PINS (and recovery restores),
        // so a recovery rewrite is byte-identical. Pre-828db2d the normal path
        // used a loose latest-by-action_index resolve that could diverge.
        assert.strictEqual(writerAddr, archive.source,
            'normal-write source_id must resolve to the same address the archive/recovery leg pins')
        assert.strictEqual(writerAddr, addrA.address, 'both legs resolve to addrA')
        console.log('    recovery byte-identity proven: writer=' + writerAddr + ' archive=' + archive.source)
    })

    it('slash exclusion: the FIXED resolver drops a slashed delegated key; the pre-fix SQL would still resolve it', async function () {
        let pubkeyBId = await idxDb.getPubkeyId(pubkeyB.toLowerCase())
        assert(pubkeyBId, 'pubkeyB must have an index_pubkeys id')
        let validId = await idxDb.getStatusId('valid')
        assert(validId, 'valid status id must exist')

        // Throwaway-regtest fixture: a permanent-slash event for pubkeyB at a
        // block <= our resolution block. Mirrors what the SLASH handler writes;
        // we insert it directly because driving full EQUIV slashing is out of
        // scope, and remove it in finally to leave the shared DB clean.
        let equivKey = 'drill-' + crypto.randomBytes(8).toString('hex')
        await idxDb.doQuery(
            `INSERT INTO capability_slash_events
                (slash_action_index, signing_pubkey_id, capability, equiv_key, amount,
                 bounty_amount, treasury_amount, submitter_id, destination_id, block_index)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [999999999, pubkeyBId, CAPABILITY, equivKey, '0', '0', '0', null, null, blockB])

        try {
            // FIXED resolver: excludes the slashed key, matching effective-set membership.
            let fixed = await getStakeSourceByPubkey(indexerLike, { pubkey: pubkeyB, block_index: blockB })
            assert(!fixed.error, 'fixed resolver should not error: ' + fixed.error)
            assert.strictEqual(fixed.source, null,
                'fixed resolver must EXCLUDE a slashed delegated key (got ' + fixed.source + ')')

            // PRE-FIX delegations leg (no capability_slash_events exclusion): still resolves.
            let preFix = await idxDb.doQuery(
                `SELECT ia.address AS source FROM delegations d
                 JOIN index_addresses ia ON ia.id = d.source_id
                 WHERE d.signing_pubkey_id = ? AND d.status_id = ?
                   AND d.activation_block <= ?
                   AND (d.deactivation_block IS NULL OR d.deactivation_block > ?)
                 ORDER BY d.action_index DESC LIMIT 1`,
                [pubkeyBId, validId, blockB, blockB])
            let preFixSource = (preFix && preFix.length > 0) ? String(preFix[0].source) : null
            assert.strictEqual(preFixSource, addrA.address,
                'pre-fix delegations SQL would still resolve the slashed key (the bug)')

            console.log('    slash divergence proven: fixed=null, pre-fix=' + preFixSource +
                ' (d0abcfd permanent-slash exclusion)')
        } finally {
            await idxDb.doQuery('DELETE FROM capability_slash_events WHERE equiv_key=?', [equivKey])
        }
    })
})
