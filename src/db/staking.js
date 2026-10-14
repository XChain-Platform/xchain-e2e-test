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
 * Attestation lookups, delegation, contract stake and reward checks
 *
 ********************************************************************/

const { rethrowInsideWait, logger } = require('./shared')

class StakingChecks {
    async getAttestationRequestsByContract(contractIndex){
        const query = `SELECT ar.*, ist.status AS status
            FROM attests ar
            LEFT JOIN index_statuses ist ON ist.id = ar.status_id
            WHERE ar.version = 0 AND ar.contract_index = ?
            ORDER BY ar.action_index ASC`
        const connection = await this.getConnection()
        try {
            return await connection.query(query, [contractIndex])
        } catch(err){ this['_warnOnSchemaError']('getAttestationRequestsByContract', err); return rethrowInsideWait(err, []) } finally { await connection.release() }
    }

    // Distinguish a schema drift (missing table / renamed column) from a normal
    // "no rows yet" poll. The attestation helpers above poll and legitimately
    // return null/[] while waiting, so a swallowed SQL error can otherwise
    // masquerade as a benign timeout instead of the schema mismatch it is, which
    // is exactly how a table renamed or merged into another one goes unnoticed.
    // Surface those loudly.
    ['_warnOnSchemaError'](where, err){
        if(err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')){
            logger.error('[db] ' + where + ': attestation schema drift: ' + err.message +
                ' (a query references a table/column that no longer exists)')
        }
    }

    // Read the current value of one contract state key, with the SAME key
    // semantics the serving indexer uses.
    // contract_state is COLLATE=utf8_general_ci, so matching on state_key folds
    // "Key" and "key" into one key and an assertion can read another key's row
    // (or read a stale row and hide a write that never landed). The schema
    // carries state_key_bin, a utf8_bin generated shadow of state_key backed by
    // idx_latest_bin, and that is what the indexer keys current state on
    // (xchain-indexer/src/db/contracts.js getContractState, armed from genesis on regtest
    // by state_key_collation_activation.js). Match the shadow column here for the
    // same reason xchain-explorer's proof reader does.
    // Latest row is id DESC, the tiebreak the writer and the schema's own
    // read-current comment use; block_index/action_index is a second ordering of
    // the same append-only sequence, so aligning removes a needless divergence.
    async getContractState(contractIndex, stateKey){
        const query = `SELECT * FROM contract_state WHERE contract_index = ? AND state_key_bin = ? ORDER BY id DESC LIMIT 1`
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, [contractIndex, stateKey])
            return rows.length > 0 ? rows[0] : null
        } catch(err){ this['_warnOnSchemaError']('getContractState', err); return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForDelegation(params, timeMax = 60000){ return this['_waitFor'](this.checkDelegation, params, timeMax) }

    // `signingPubkey` and `deactivated` exist for the DEL-1 revoke shape:
    // at/after DELEGATE_REVOKE_NO_REINSERT (armed from genesis on regtest) a revoke
    // writes NO row of its own, it only stamps deactivation_block on the PARENT
    // delegation, so the only way to observe one is to look the parent up by
    // (source, pubkey) and read that column. A txHash filter can never see it: the
    // parent row carries the DELEGATE v0 transaction, not the revoke's.
    async checkDelegation({source, signingPubkey, txHash, status, deactivated}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(deactivated === true)  w.push("d.deactivation_block IS NOT NULL")
        if(deactivated === false) w.push("d.deactivation_block IS NULL")
        if(w.length === 0) return null
        const query = `SELECT d.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM delegations d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = d.source_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = d.signing_pubkey_id
            WHERE ` + w.join(" AND ") + ` ORDER BY d.action_index DESC`
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    // ── Stake-key revocations (DELEGATE v2 against the ORIGINAL stake key) ──
    // Stake-key-mode revokes write ONLY stake_key_revocations (a delegations
    // row would read as an active delegation and re-add the key to the
    // effective signer set), so they are invisible to checkDelegation.

    async waitForStakeKeyRevocation(params, timeMax = 60000){ return this['_waitFor'](this.checkStakeKeyRevocation, params, timeMax) }

    async checkStakeKeyRevocation({source, signingPubkey, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT r.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM stake_key_revocations r
            LEFT JOIN actions act ON act.action_index = r.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = r.source_id
            LEFT JOIN index_statuses ist ON ist.id = r.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = r.signing_pubkey_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    // ── Contract-targeted staking (STAKE v3 / UNSTAKE v1 / DELEGATE v1) ──

    async waitForContractStake(params, timeMax = 60000){ return this['_waitFor'](this.checkContractStake, params, timeMax) }

    async checkContractStake({source, signingPubkey, contractIndex, tick, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source) }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()) }
        if(contractIndex !== undefined && contractIndex !== null){ w.push("cs.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash) }
        if(status){ w.push("ist.status = ?"); v.push(status) }
        if(w.length === 0) return null
        const query = `SELECT cs.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status,
                            ip.pubkey AS signing_pubkey, t.tick AS tick
            FROM contract_stakes cs
            LEFT JOIN actions act ON act.action_index = cs.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = cs.source_id
            LEFT JOIN index_statuses ist ON ist.id = cs.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = cs.signing_pubkey_id
            LEFT JOIN index_tickers t ON t.id = cs.tick_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForContractUnstake(params, timeMax = 60000){ return this['_waitFor'](this.checkContractUnstake, params, timeMax) }

    async checkContractUnstake({source, signingPubkey, contractIndex, tick, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source) }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()) }
        if(contractIndex !== undefined && contractIndex !== null){ w.push("cu.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash) }
        if(status){ w.push("ist.status = ?"); v.push(status) }
        if(w.length === 0) return null
        const query = `SELECT cu.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status,
                            ip.pubkey AS signing_pubkey, t.tick AS tick
            FROM contract_unstakes cu
            LEFT JOIN actions act ON act.action_index = cu.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = cu.source_id
            LEFT JOIN index_statuses ist ON ist.id = cu.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = cu.signing_pubkey_id
            LEFT JOIN index_tickers t ON t.id = cu.tick_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForContractDelegation(params, timeMax = 60000){ return this['_waitFor'](this.checkContractDelegation, params, timeMax) }

    async checkContractDelegation({source, contractIndex, tick, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source) }
        if(contractIndex !== undefined && contractIndex !== null){ w.push("cd.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash) }
        if(status){ w.push("ist.status = ?"); v.push(status) }
        if(w.length === 0) return null
        const query = `SELECT cd.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, t.tick AS tick
            FROM contract_delegations cd
            LEFT JOIN actions act ON act.action_index = cd.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = cd.source_id
            LEFT JOIN index_statuses ist ON ist.id = cd.status_id
            LEFT JOIN index_tickers t ON t.id = cd.tick_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForSlashEvent(params, timeMax = 60000){ return this['_waitFor'](this.checkSlashEvent, params, timeMax) }

    async checkSlashEvent({contractIndex, signingPubkey, tick, executionIndex}){
        const w = [], v = []
        if(contractIndex !== undefined && contractIndex !== null){ w.push("se.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(executionIndex !== undefined && executionIndex !== null){ w.push("se.execution_index = ?"); v.push(Number(executionIndex)) }
        if(w.length === 0) return null
        const query = `SELECT se.*, ip.pubkey AS signing_pubkey, t.tick AS tick, ia.address AS destination_address
            FROM slash_events se
            LEFT JOIN index_pubkeys ip ON ip.id = se.signing_pubkey_id
            LEFT JOIN index_tickers t ON t.id = se.tick_id
            LEFT JOIN index_addresses ia ON ia.id = se.destination_id
            WHERE ` + w.join(" AND ") + ` ORDER BY se.id ASC LIMIT 1`
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForRewardClaim(params, timeMax = 60000){ return this['_waitFor'](this.checkRewardClaim, params, timeMax) }

    async checkRewardClaim({source, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT rc.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status
            FROM reward_claims rc
            LEFT JOIN actions act ON act.action_index = rc.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = rc.source_id
            LEFT JOIN index_statuses ist ON ist.id = rc.status_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }
}

module.exports = StakingChecks
