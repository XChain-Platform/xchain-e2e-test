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
 * Row filter and query builders: list filters
 *
 ********************************************************************/

const { rethrowInsideWait, logger } = require('./shared')

function buildBroadcastFilter({blockIndex,txHash,source,message,value,fee,memo,broadcastActionIndex,status}){
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
    if (source != null){
        whereClauses.push("ia.address = ?")
        whereValues.push(source)
    }
    if (message != null){
        whereClauses.push("b.message = ?")
        whereValues.push(message)
    }
    if (value != null){
        whereClauses.push("b.value = ?")
        whereValues.push(value)
    }
    if (fee != null){
        whereClauses.push("b.fee = ?")
        whereValues.push(fee)
    }
    if (memo != null){
        if (memo === ''){
            whereClauses.push("im.memo IS NULL")
        } else {
            whereClauses.push("im.memo = ?")
            whereValues.push(memo)
        }
    }
    if (broadcastActionIndex != null){
        whereClauses.push("b.broadcast_action_index = ?")
        whereValues.push(broadcastActionIndex)
    }
    if (status != null){
        whereClauses.push("ist.status = ?")
        whereValues.push(status)
    }

    return { whereClauses, whereValues }
}

function getListWhere({blockIndex,txHash,source,type,edit,listActionIndex,memo,status}){
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
    if (source != null){
        whereClauses.push("ia.address = ?")
        whereValues.push(source)
    }
    if (type != null){
        whereClauses.push("l.type = ?")
        whereValues.push(type)
    }
    if (edit != null){
        whereClauses.push("l.edit = ?")
        whereValues.push(edit)
    }
    if (listActionIndex != null){
        whereClauses.push("l.list_action_index = ?")
        whereValues.push(listActionIndex)
    }
    if (memo != null){
        if (memo === ''){
            whereClauses.push("im.memo IS NULL")
        } else {
            whereClauses.push("im.memo = ?")
            whereValues.push(memo)
        }
    }
    if (status != null){
        whereClauses.push("ist.status = ?")
        whereValues.push(status)
    }

    return {whereClauses, whereValues}
}

function getListQuery(whereClauses){
    return `
            SELECT
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                l.action_index,
                ia.address AS source,
                l.type,
                l.edit,
                l.list_action_index,
                im.memo AS memo,
                ist.status AS status
            FROM lists l
            LEFT JOIN actions act ON act.action_index = l.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_memos im ON im.id = l.memo_id
            LEFT JOIN index_statuses ist ON ist.id = l.status_id
        `+"WHERE "+whereClauses.join(" AND ");
}

async function findListRow(database, query, whereValues){
    const connection = await database.getConnection()

    try {
        const rows = await connection.query(query, whereValues)
        if (rows.length > 0){
            return {listRow: rows[0], finished: false}
        } else {
            return {listRow: null, finished: true}
        }
    } catch (err) {
        logger.error('Error with database query (list):', err);
        return rethrowInsideWait(err, {listRow: null, finished: true})
    } finally {
        await connection.release()
    }
}

function getListItemsQuery(type){
    let leftJoin = ""
    let field = ""
    switch (type){
        case 1: //TICK
            leftJoin = " LEFT JOIN index_tickers it ON it.id = li.item_id "
            field = " it.tick AS item_name "
            break
        case 2: //address
            leftJoin = " LEFT JOIN index_addresses ia ON ia.id = li.item_id "
            field = " ia.address AS item_name "
            break
    }

    return "SELECT "+field+
        " FROM list_items li "+leftJoin+
        " WHERE li.action_index = ?"
}

function listItemsMatch(rows, items){
    if (rows.length !== items.length){
        logger.info("ERROR! List items don't have the same length as the items in the database")
        return false
    }

    const itemsClone = items.slice()
    for (const nextRowIndex in rows){
        const nextRow = rows[nextRowIndex]
        const itemIndex = itemsClone.indexOf(nextRow["item_name"])
        if (itemIndex >= 0){
            itemsClone.splice(itemIndex, 1)
        }
    }

    if (itemsClone.length === 0){
        return true
    }
    logger.info("ERROR! List items don't match with the items in the database")
    return false
}

async function checkListItems(database, listRow, type, items){
    const queryItems = getListItemsQuery(type)
    const connection = await database.getConnection()

    try {
        const rows = await connection.query(queryItems, [listRow["action_index"]])
        if (listItemsMatch(rows, items)){
            return listRow
        } else {
            return null
        }
    } catch (err) {
        logger.error('Error with database query (list items):', err);
        return rethrowInsideWait(err)
    } finally {
        await connection.release()
    }
}

/**
 * A named-method wrapper around one mariadb connection pool: every query the
 * e2e suites need lives here as a method, never as a literal SQL string at
 * the call site, and the waitFor* helpers below poll these methods for a row
 * the indexer has not written yet.
 */

module.exports = { buildBroadcastFilter, getListWhere, getListQuery, findListRow, getListItemsQuery, listItemsMatch, checkListItems }
