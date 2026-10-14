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
 * Coinpay, contract, deposit, withdrawal, stake and attestation checks
 *
 ********************************************************************/

const { rethrowInsideWait, logger } = require('./shared')

class ContractChecks {
    // ─── COINPAY ──────────────────────────────────────────────────────
    async waitForCoinpay(obj, timeMax = 60000){ return this['_waitFor'](this.checkCoinpay, obj, timeMax) }

    async checkCoinpay({txHash, obligationActionIndex, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (obligationActionIndex != null){ w.push("m.obligation_action_index = ?"); v.push(obligationActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT m.*, itx.hash AS tx_hash, ist.status AS status
            FROM coinpays m
            LEFT JOIN actions act ON act.action_index = m.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_statuses ist ON ist.id = m.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (coinpay):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── COINPAY_OBLIGATION ───────────────────────────────────────────
    async waitForCoinpayObligation(obj, timeMax = 60000){ return this['_waitFor'](this.checkCoinpayObligation, obj, timeMax) }

    async checkCoinpayObligation({actionIndex, coinpayStatus}){
        const w = [], v = []
        if (actionIndex != null){ w.push("co.action_index = ?"); v.push(actionIndex) }
        if (coinpayStatus != null){ w.push("ist.status = ?"); v.push(coinpayStatus) }
        const query = `
            SELECT co.*, ia1.address AS payer_address, ia2.address AS payee_address, c1.coin, ist.status AS coinpay_status
            FROM coinpay_obligations co
            INNER JOIN index_addresses ia1 ON ia1.id = co.payer_address_id
            INNER JOIN index_addresses ia2 ON ia2.id = co.payee_address_id
            INNER JOIN index_coins c1 ON c1.id = co.coin_id
            INNER JOIN coinpay_statuses cs ON cs.coinpay_action_index = co.action_index
            INNER JOIN index_statuses ist ON ist.id = cs.status_id
            WHERE cs.action_index = (SELECT MAX(cs2.action_index) FROM coinpay_statuses cs2 WHERE cs2.coinpay_action_index = co.action_index)
              AND `+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (coinpay_obligation):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ── VM / Contract Methods ──

    async waitForContract(params, timeMax = 60000){ return this['_waitFor'](this.checkContract, params, timeMax) }

    async checkContract({source, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT c.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status
            FROM contracts c
            LEFT JOIN actions act ON act.action_index = c.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = c.source_id
            LEFT JOIN index_statuses ist ON ist.id = c.status_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForExecution(params, timeMax = 60000){ return this['_waitFor'](this.checkExecution, params, timeMax) }

    async checkExecution({contractIndex, caller, methodName, txHash, status}){
        const w = [], v = []
        if(contractIndex){ w.push("e.contract_index = ?"); v.push(contractIndex); }
        if(caller){ w.push("ia.address = ?"); v.push(caller); }
        if(methodName){ w.push("e.method_name = ?"); v.push(methodName); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT e.*, ia.address AS caller, itx.hash AS tx_hash, ist.status AS status
            FROM contract_executions e
            LEFT JOIN actions act ON act.action_index = e.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = e.caller_id
            LEFT JOIN index_statuses ist ON ist.id = e.status_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForDeposit(params, timeMax = 60000){ return this['_waitFor'](this.checkDeposit, params, timeMax) }

    async checkDeposit({source, contractIndex, tick, amount, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(contractIndex){ w.push("d.contract_index = ?"); v.push(contractIndex); }
        if(tick){ w.push("itick.tick = ?"); v.push(tick); }
        if(amount){ w.push("d.amount = ?"); v.push(amount); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT d.*, ia.address AS source, itick.tick AS tick, itx.hash AS tx_hash, ist.status AS status
            FROM deposits d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = d.source_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForWithdrawal(params, timeMax = 60000){ return this['_waitFor'](this.checkWithdrawal, params, timeMax) }

    async checkWithdrawal({source, contractIndex, tick, amount, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(contractIndex){ w.push("wd.contract_index = ?"); v.push(contractIndex); }
        if(tick){ w.push("itick.tick = ?"); v.push(tick); }
        if(amount){ w.push("wd.amount = ?"); v.push(amount); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT wd.*, ia.address AS source, itick.tick AS tick, itx.hash AS tx_hash, ist.status AS status
            FROM withdrawals wd
            LEFT JOIN actions act ON act.action_index = wd.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = wd.source_id
            LEFT JOIN index_tickers itick ON itick.id = wd.tick_id
            LEFT JOIN index_statuses ist ON ist.id = wd.status_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    // ── Staking Methods ──

    async waitForStake(params, timeMax = 60000){ return this['_waitFor'](this.checkStake, params, timeMax) }

    async checkStake({source, signingPubkey, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT s.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM stakes s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = s.source_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    // Count currently-active, valid stakes (those still in the validator
    // snapshot, not deactivated). Used by the hub-federation tests to assert a
    // clean validator set before staking their own hubs: leftover stakes would
    // skew the deterministic responsible-set selection and make those tests
    // flaky. Zero on a freshly-reset regtest chain.
    async getActiveStakeCount(){
        const query = `SELECT COUNT(*) AS n
            FROM stakes s
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            WHERE ist.status = 'valid'
              AND (s.deactivation_block IS NULL OR s.deactivation_block = 0)`
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query)
            return rows.length > 0 ? Number(rows[0].n) : 0
        } finally { await connection.release() }
    }

    async waitForUnstake(params, timeMax = 60000){ return this['_waitFor'](this.checkUnstake, params, timeMax) }

    async checkUnstake({source, signingPubkey, txHash, status}){
        const w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        const query = `SELECT u.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM unstakes u
            LEFT JOIN actions act ON act.action_index = u.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = u.source_id
            LEFT JOIN index_statuses ist ON ist.id = u.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = u.signing_pubkey_id
            WHERE ` + w.join(" AND ")
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return rethrowInsideWait(err) } finally { await connection.release() }
    }

    // ── Attestation Methods ──

    async waitForAttestationRequest(params, timeMax = 60000){ return this['_waitFor'](this.checkAttestationRequest, params, timeMax) }

    async checkAttestationRequest({requestId, txHash, requestStatus}){
        const w = [], v = []
        if(requestId){     w.push("ar.request_id = ?");      v.push(String(requestId).toLowerCase()); }
        if(txHash){        w.push("itx.hash = ?");           v.push(txHash); }
        if(requestStatus){ w.push("ar.request_status = ?");  v.push(requestStatus); }
        if(w.length === 0) return null
        // ATTEST request + response rows now share the consolidated `attests`
        // table, version-discriminated (0 = request, 1 = response).
        const query = `SELECT ar.*, itx.hash AS tx_hash
            FROM attests ar
            LEFT JOIN actions act ON act.action_index = ar.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            WHERE ar.version = 0 AND ` + w.join(" AND ") + `
            LIMIT 1`
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ this['_warnOnSchemaError']('checkAttestationRequest', err); return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async waitForAttestationResponse(params, timeMax = 60000){ return this['_waitFor'](this.checkAttestationResponse, params, timeMax) }

    async checkAttestationResponse({requestId, txHash, responseStatus, status}){
        const w = [], v = []
        if(requestId){       w.push("ar.request_id = ?");       v.push(String(requestId).toLowerCase()); }
        if(txHash){          w.push("itx.hash = ?");            v.push(txHash); }
        if(responseStatus){  w.push("ar.response_status = ?");  v.push(responseStatus); }
        if(status){          w.push("ist.status = ?");          v.push(status); }
        if(w.length === 0) return null
        // Response rows live in the consolidated `attests` table as version = 1.
        const query = `SELECT ar.*, itx.hash AS tx_hash, ist.status AS status
            FROM attests ar
            LEFT JOIN actions act ON act.action_index = ar.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_statuses ist ON ist.id = ar.status_id
            WHERE ar.version = 1 AND ` + w.join(" AND ") + `
            LIMIT 1`
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ this['_warnOnSchemaError']('checkAttestationResponse', err); return rethrowInsideWait(err) } finally { await connection.release() }
    }

    async getAttestationValidatorSignatures(responseActionIndex){
        // Verified federation sigs are no longer a separate table; they're
        // inlined as a JSON array (`[{pubkey, sig}, ...]`) on the version = 1
        // response row. Parse + reshape to the prior {validator_pubkey, validator_sig} form.
        const query = `SELECT validator_signatures FROM attests WHERE action_index = ? AND version = 1 LIMIT 1`
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, [responseActionIndex])
            // No response row yet, or one with nothing recorded: report no
            // signatures rather than throw, so a caller can keep polling.
            if(rows.length === 0 || !rows[0].validator_signatures) return []
            let parsed
            // Malformed JSON in the column is a data problem, not a
            // missing-row one; treat it the same as "no signatures".
            try { parsed = JSON.parse(rows[0].validator_signatures) } catch(e){ return [] }
            // The column is JSON-typed but not schema-enforced to hold an
            // array; guard the shape before mapping it below.
            if(!Array.isArray(parsed)) return []
            return parsed.map(s => ({ validator_pubkey: s.pubkey, validator_sig: s.sig }))
        } catch(err){ this['_warnOnSchemaError']('getAttestationValidatorSignatures', err); return rethrowInsideWait(err, []) } finally { await connection.release() }
    }

    async waitForAttestationRequestCount(params, timeMax = 60000){ return this['_waitFor'](this.checkAttestationRequestCount, params, timeMax) }

    // EVERY ATTEST v0 (request) row a contract has emitted, oldest first, with the
    // action-level verdict text joined in; null until there are at least `count` of
    // them, so it composes with _waitFor.
    //
    // checkAttestationRequest answers ONE row and filters by request_status, which
    // cannot express the question an admission cap poses: what did the OTHER requests
    // of this same block do, and in what order. The per-block caps
    // (actions/attest/gates/attest_request_cap_gate.js) are decided from the count of admissions
    // EARLIER IN THE SAME BLOCK, so a test of them has to see the whole set, and it
    // has to see the verdict STRING - request_status only says pending/rejected, it
    // never says which rule refused the row.
    async checkAttestationRequestCount({contractIndex, count}){
        const rows = await this.getAttestationRequestsByContract(contractIndex)
        if(rows.length < (Number(count) || 1)) return null
        return rows
    }
}

module.exports = ContractChecks
