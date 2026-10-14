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
 * Row filter and query builders: tx filters
 *
 ********************************************************************/

function buildMintWhere({blockIndex,txHash,tick,destination,amount,memo,status}){
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
    if (destination != null){
        whereClauses.push("ia.address = ?")
        whereValues.push(destination)
    }
    if (amount != null){
        whereClauses.push("m.amount = ?")
        whereValues.push(amount)
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

function buildMintQuery(whereClauses){
    return [
        '',
        '            SELECT ',
        '                tr.block_index AS block_index,',
        '                itx.hash AS tx_hash,',
        '                m.action_index,',
        '                itick.tick AS tick,',
        '                ia.address AS destination,',
        '                m.amount,',
        '                im.memo AS memo, ',
        '                ist.status AS status ',
        '            FROM mints m',
        '            LEFT JOIN actions act ON act.action_index = m.action_index',
        '            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index',
        '            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id',
        '            LEFT JOIN index_addresses ia ON ia.id = m.destination_id',
        '            LEFT JOIN index_memos im ON im.id = m.memo_id',
        '            LEFT JOIN index_statuses ist ON ist.id = m.status_id',
        '            LEFT JOIN index_tickers itick ON itick.id = m.tick_id ',
        '        '
    ].join('\n')+"WHERE "+whereClauses.join(" AND ");
}

function buildAirdropFilter({blockIndex,txHash,source,tick,amount,listActionIndex,memo,status}){
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
    if (tick != null){
        whereClauses.push("itick.tick = ?")
        whereValues.push(tick)
    }
    if (amount != null){
        whereClauses.push("a.amount = ?")
        whereValues.push(amount)
    }
    if (listActionIndex != null){
        whereClauses.push("a.list_action_index = ?")
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

function buildIssueFilter(source, tick, txHash, maxSupply, maxMint, decimals, description, mintSupply, status){
    const filters = [
        ["ia.address = ?", source],
        ["itick.tick = ?", tick],
        ["itx.hash = ?", txHash],
        ["i.max_supply = ?", maxSupply],
        ["i.max_mint = ?", maxMint],
        ["i.decimals = ?", decimals],
        ["i.description = ?", description],
        ["i.mint_supply = ?", mintSupply],
        ["ist.status = ?", status]
    ]
    const whereClauses = []
    const whereValues = []

    for (const [clause, value] of filters){
        if (value != null){
            whereClauses.push(clause)
            whereValues.push(value)
        }
    }

    return { whereClauses, whereValues }
}

function buildSendFilters({source,destination,tick,amount,txHash,memo,status}){
    const whereClauses = []
    const whereValues = []

    if (source != null){
        whereClauses.push("ia.address = ?")
        whereValues.push(source)
    }
    if (destination != null){
        whereClauses.push("ia2.address = ?")
        whereValues.push(destination)
    }
    if (tick != null){
        whereClauses.push("itick.tick = ?")
        whereValues.push(tick)
    }
    if (amount != null){
        whereClauses.push("amount = ?")
        whereValues.push(amount)
    }
    if (txHash != null){
        whereClauses.push("itx.hash = ?")
        whereValues.push(txHash)
    }
    if (memo != null){
        // An empty memo matches the NULL representation stored by the indexer.
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

function buildAirdropQuery(whereClauses){
    return `
            SELECT
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                a.action_index,
                ia.address AS source,
                itick.tick AS tick,
                a.amount,
                im.memo,
                a.list_action_index,
                ist.status AS status
            FROM airdrops a
            LEFT JOIN actions act ON act.action_index = a.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_statuses ist ON ist.id = a.status_id
            LEFT JOIN index_tickers itick ON itick.id = a.tick_id
            LEFT JOIN index_memos im ON im.id = a.memo_id
        `+"WHERE "+whereClauses.join(" AND ");
}

function buildSendQuery(whereClauses){
    return `
            SELECT s.*,
                itick.tick AS tick,
                itx.hash AS tx_hash,\x20
                ia.address AS source,\x20
                ia2.address AS destination,\x20
                im.memo AS memo,\x20
                ist.status AS status\x20
            FROM sends s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_addresses ia2 ON ia2.id = s.destination_id
            LEFT JOIN index_memos im ON im.id = s.memo_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            LEFT JOIN index_tickers itick ON itick.id = s.tick_id\x20
        `+"WHERE "+whereClauses.join(" AND ");
}

function firstSendRow(rows){
    if (rows.length > 0){
        return rows[0]
    } else {
        return null
    }
}

module.exports = { buildMintWhere, buildMintQuery, buildAirdropFilter, buildIssueFilter, buildSendFilters, buildAirdropQuery, buildSendQuery, firstSendRow }
