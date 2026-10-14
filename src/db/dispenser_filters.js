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
 * Row filter and query builders: dispenser filters
 *
 ********************************************************************/

function addDispenserWhereValue(database, whereClauses, whereValues, value, clause){
    if (!database.isNullOrNullString(value)){
        whereClauses.push(clause)
        whereValues.push(value)
    }
}

function addDispenserIdentityFilters(database, params, whereClauses, whereValues){
    addDispenserWhereValue(database, whereClauses, whereValues, params.blockIndex, "tr.block_index = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.txHash, "itx.hash = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.source, "ias.address = ?")
}

function addDispenserGiveFilters(database, params, whereClauses, whereValues){
    addDispenserWhereValue(database, whereClauses, whereValues, params.giveCoin, "give_ic.coin = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.giveTick, "give_it.tick = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.giveAmount, "d.give_amount = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.giveEscrow, "d.give_escrow = ?")
    // Bypass isNullOrNullString, which reads 0 as unset, so giveOwnership 0 still pins the flag
    if (params.giveOwnership != null && params.giveOwnership !== ""){
        whereClauses.push("d.give_ownership = ?")
        whereValues.push(Number(params.giveOwnership))
    }
}

function addDispenserGetFilters(database, params, whereClauses, whereValues){
    addDispenserWhereValue(database, whereClauses, whereValues, params.getCoin, "get_ic.coin = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.getTick, "get_it.tick = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.getAmount, "d.get_amount = ?")
    if (!database.isNullOrNullString(params.getAddress)){
        whereClauses.push("get_ia.address = ?")
        whereValues.push(params.getAddress)
    } else {
        whereClauses.push("get_ia.address = ias.address")
    }
}

function addDispenserConstraintFilters(database, params, whereClauses, whereValues){
    addDispenserWhereValue(database, whereClauses, whereValues, params.fiatCode, "ifs.code = ?")
    // Match the fiat amount the caller named; the indexer stores the wire string verbatim
    addDispenserWhereValue(database, whereClauses, whereValues, params.fiatAmount, "d.fiat_amount = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.oracleAddress, "oracle_ia.address = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.expiration, "d.expiration = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.allowList, "d.allow_list = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.blockList, "d.block_list = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.memo, "im.memo = ?")
    addDispenserWhereValue(database, whereClauses, whereValues, params.status, "ist.status = ?")
}

function buildDispenserFilters(database, params){
    const whereClauses = []
    const whereValues = []
    addDispenserIdentityFilters(database, params, whereClauses, whereValues)
    addDispenserGiveFilters(database, params, whereClauses, whereValues)
    addDispenserGetFilters(database, params, whereClauses, whereValues)
    addDispenserConstraintFilters(database, params, whereClauses, whereValues)
    return {whereClauses, whereValues}
}

function buildDispenserQuery(whereClauses){
    return `
            SELECT${' '}
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                d.action_index,
                give_ic.coin AS give_coin,
                give_it.tick AS give_tick,
                d.give_amount,
                d.give_escrow,
                d.give_ownership,
                get_ic.coin AS get_coin,
                get_it.tick AS get_tick,
                d.get_amount,
                get_ia.address AS get_address,
                ifs.code AS fiat_code,
                d.fiat_amount,
                oracle_ia.address AS oracle_address,
                d.expiration,
                d.allow_list,
                d.block_list,
                im.memo AS memo,
                ist.status AS status${' '}
            FROM dispensers d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = d.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = d.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = d.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = d.get_tick_id
            LEFT JOIN index_addresses get_ia ON get_ia.id = d.get_address_id
            LEFT JOIN index_fiats ifs ON ifs.id = d.fiat_id
            LEFT JOIN index_addresses oracle_ia ON oracle_ia.id = d.oracle_address_id
            LEFT JOIN index_memos im ON im.id = d.memo_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+whereClauses.join(" AND ");
}

module.exports = { addDispenserWhereValue, addDispenserIdentityFilters, addDispenserGiveFilters, addDispenserGetFilters, addDispenserConstraintFilters, buildDispenserFilters, buildDispenserQuery }
