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
 * Broadcast, list and airdrop checks
 *
 ********************************************************************/

const { buildAirdropFilter, buildAirdropQuery } = require('./tx_filters')
const { buildBroadcastFilter, getListWhere, getListQuery, findListRow, checkListItems } = require('./list_filters')
const { rethrowInsideWait, logger } = require('./shared')

class BroadcastListChecks {
    async waitForBroadcast(broadcastObject, timeMax = 60000){ return this['_waitFor'](this.checkBroadcast, broadcastObject, timeMax) }

    async checkBroadcast({blockIndex,txHash,source,message,value,fee,memo,broadcastActionIndex,status}){
        const { whereClauses, whereValues } = buildBroadcastFilter({
            blockIndex, txHash, source, message, value, fee, memo, broadcastActionIndex, status
        })

        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                b.action_index,
                ia.address AS source,
                b.message,
                b.value,
                b.fee,
                im.memo AS memo, 
                b.broadcast_action_index,
                ist.status AS status 
            FROM broadcasts b
            LEFT JOIN actions act ON act.action_index = b.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_memos im ON im.id = b.memo_id
            LEFT JOIN index_statuses ist ON ist.id = b.status_id
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
            logger.error('Error with database query (broadcast):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    async waitForList(listObject, timeMax = 60000){ return this['_waitFor'](this.checkList, listObject, timeMax) }
    
    async checkList({blockIndex,txHash,source,type,edit,listActionIndex,memo,status,items}){
        const {whereClauses, whereValues} = getListWhere({
            blockIndex, txHash, source, type, edit, listActionIndex, memo, status
        })
        const query = getListQuery(whereClauses)
        const {listRow, finished} = await findListRow(this, query, whereValues)

        if (finished){
            return null
        }
        if (!listRow){
            logger.error("ERROR! Couldn't find the new list action index");
            return null
        }
        return await checkListItems(this, listRow, type, items)
    }
    
    async waitForAirdrop(airdropObject, timeMax = 60000){ return this['_waitFor'](this.checkAirdrop, airdropObject, timeMax) }

    async getListType(listActionIndex){
        const queryList = "SELECT type FROM lists WHERE action_index = ?"
        const connection = await this.getConnection()

        try {
            const rows = await connection.query(queryList, [listActionIndex])
            if (rows.length > 0){
                return { found: true, listType: parseInt(rows[0]["type"]) }
            }
            logger.info("ERROR! Couldn't get the type of a list")
            return { found: false }
        } catch (err) {
            logger.info(err)
            return { found: false }
        } finally {
            await connection.release()
        }
    }

    getListAddressesQuery(listType){
        switch (listType){
            case 1: //TICK
                return `
                        WITH totalCredits AS (
                        SELECT address_id, tick_id, SUM(amount) AS total
                        FROM credits
                        GROUP BY address_id, tick_id
                    ),
                    totalDebits AS (
                        SELECT address_id, tick_id, SUM(amount) AS total
                        FROM debits
                        GROUP BY address_id, tick_id
                    )
                    SELECT
                        DISTINCT(ia.id) AS address `+
                    `FROM index_addresses ia 
                    LEFT JOIN index_tickers it ON it.id IN (SELECT item_id FROM list_items WHERE action_index = ?)
                    LEFT JOIN totalCredits tc ON tc.tick_id = it.id AND tc.address_id = ia.id
                    LEFT JOIN totalDebits td ON td.tick_id = it.id AND td.address_id = ia.id
                    WHERE
                        COALESCE(tc.total, 0) > 0 OR COALESCE(td.total, 0) > 0;
                    `
            case 2: //address
                return `
                        SELECT 
                            ia.id AS address
                        FROM list_items li
                        LEFT JOIN index_addresses ia ON ia.id = li.item_id
                        WHERE li.action_index = ?
                    `
        }
        return null
    }

    async queryListAddresses(addressesQuery, listActionIndex){
        let connection = null
        try {
            connection = await this.getConnection()
            const rows = await connection.query(addressesQuery, [listActionIndex])
            const addresses = this.addressIdsFromRows(rows)
            return { succeeded: true, addresses }
        } catch (err) {
            logger.error("Couldn't get a list of addresses from a list:", err);
            return { succeeded: false }
        } finally {
            // Return the pooled connection on every path, as every other query here does
            if (connection) await connection.release()
        }
    }

    addressIdsFromRows(rows){
        const result = []
        for (const nextRowIndex in rows){
            result.push(rows[nextRowIndex]["address"])
        }
        return result
    }

    async getListAddresses(listActionIndex){
        const list = await this.getListType(listActionIndex)
        if (!list.found) return null

        if (list.listType){
            const addressesQuery = this.getListAddressesQuery(list.listType)
            const queryResult = await this.queryListAddresses(addressesQuery, listActionIndex)
            if (queryResult.succeeded) return queryResult.addresses
        }

        logger.info("ERROR: there is no list with action index "+listActionIndex)
        return null
    }

    async checkAirdrop({blockIndex,txHash,source,tick,amount,listActionIndex,memo,status}){
        const {whereClauses, whereValues} = buildAirdropFilter({
            blockIndex, txHash, source, tick, amount, listActionIndex, memo, status
        })
        const query = buildAirdropQuery(whereClauses)

        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error('Error with database query (airdrop):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
}

module.exports = BroadcastListChecks
