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
 * Token action checks (issue, send, credit, debit, mint)
 *
 ********************************************************************/

const { buildMintWhere, buildMintQuery, buildIssueFilter, buildSendFilters, buildSendQuery, firstSendRow } = require('./tx_filters')
const { rethrowInsideWait, logger } = require('./shared')

class TokenChecks {
    async waitForIssue(issueObject, timeMax = 60000){ return this['_waitFor'](this.checkIssue, issueObject, timeMax) }

    async checkIssue({source, tick, txHash, maxSupply, maxMint, decimals, description, 
            mintSupply, transferAddress, transferMintSupplyAddress, 
            lockMaxSupply, lockMint, lockMintSupply, lockMaxMint, lockDescription, lockRug, lockSleep,
            lockCallback, callbackBlock, callbackTickId, callbackAmount, allowList, blockList, 
            mintAddressMax, mintStartBlock, mintStopBlock, status}){

        const { whereClauses, whereValues } = buildIssueFilter(
            source, tick, txHash, maxSupply, maxMint, decimals, description, mintSupply, status
        )
            
            
        const query = `
            SELECT i.*,
                itick.tick AS tick,
                itx.hash AS tx_hash,
                ia.address AS source,
                ist.status AS status
            FROM issues i
            LEFT JOIN actions act ON act.action_index = i.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = i.tick_id
            LEFT JOIN index_statuses ist ON ist.id = i.status_id
        `+"WHERE "+whereClauses.join(" AND ");
        
        const connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error('Error with database query (issue):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
    
    async waitForSend(sendObject, timeMax = 60000){ return this['_waitFor'](this.checkSend, sendObject, timeMax) }
    
    async checkSend({source,destination,tick,amount,txHash,memo,status}){
        const {whereClauses, whereValues} = buildSendFilters({
            source, destination, tick, amount, txHash, memo, status
        })
        const query = buildSendQuery(whereClauses)

        const connection = await this.getConnection()

        try {
            const rows = await connection.query(query, whereValues)
            return firstSendRow(rows)
        } catch (err) {
            logger.error('Error with database query (send):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    async waitForCredit(creditObject, timeMax = 60000){ return this['_waitFor'](this.checkCredit, creditObject, timeMax) }

    async checkCredit({blockIndex,txHash,tick,address,amount}){
        const whereClauses = []
        const whereValues = []

        if (blockIndex != null){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (address != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(address)
        }
        if (amount != null){
            whereClauses.push("amount = ?")
            whereValues.push(amount)
        }
           
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                c.action_index,
                itick.tick AS tick,
                ia.address AS address,
                c.amount
            FROM credits c
            LEFT JOIN actions act ON act.action_index = c.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = c.address_id
            LEFT JOIN index_tickers itick ON itick.id = c.tick_id 
        `+"WHERE "+whereClauses.join(" AND ");
        
        const connection = await this.getConnection()
        
        try {
        const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error('Error with database query (credit):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    /*
     * The address's settled balance of one ticker, as a string, or "0" when the
     * indexer holds no row for the pair.
     *
     * Returned as a STRING, never a JS number: balances are stored at full ledger
     * precision and a large one loses digits the moment it becomes a double, which
     * is the class of bug the platform's amount handling exists to avoid. Callers
     * that need arithmetic should use BigInt or the same bignumber the indexer does.
     *
     * "No row" is a real zero here, not missing evidence: the indexer deletes a
     * balance row when it drains, so absence and zero are the same state.
     */
    async getBalance({address, tick}){
        const query = `
            SELECT b.amount AS amount
            FROM balances b
            LEFT JOIN index_addresses ia ON ia.id = b.address_id
            LEFT JOIN index_tickers itick ON itick.id = b.tick_id
            WHERE ia.address = ? AND itick.tick = ?
            LIMIT 1
        `

        const connection = await this.getConnection()

        try {
            const rows = await connection.query(query, [address, tick])
            return (rows.length > 0) ? String(rows[0].amount) : "0"
        } catch (err) {
            logger.error('Error with database query (balance):', err);
            return null;
        } finally {
            await connection.release()
        }
    }

    async waitForDebit(debitObject, timeMax = 60000){ return this['_waitFor'](this.checkDebit, debitObject, timeMax) }
    
    async checkDebit({blockIndex,txHash,tick,address,amount}){
        const whereClauses = []
        const whereValues = []
        
        if (blockIndex != null){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (address != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(address)
        }
        if (amount != null){
            whereClauses.push("amount = ?")
            whereValues.push(amount)
        }
           
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                d.action_index,
                itick.tick AS tick,
                ia.address AS address,
                d.amount
            FROM debits d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = d.address_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id 
        `+"WHERE "+whereClauses.join(" AND ");
        
        const connection = await this.getConnection()
        
        try {
        const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error('Error with database query (debit):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
    
    async waitForMint(mintObject, timeMax = 60000){ return this['_waitFor'](this.checkMint, mintObject, timeMax) }
    
    async checkMint({blockIndex,txHash,tick,destination,amount,memo,status}){
        const {whereClauses, whereValues} = buildMintWhere({
            blockIndex, txHash, tick, destination, amount, memo, status
        })
        const query = buildMintQuery(whereClauses)
        
        const connection = await this.getConnection()
        
        try {
        const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error('Error with database query (mint):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
}

module.exports = TokenChecks
