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
 * Dispenser, dispense and dispenser status checks
 *
 ********************************************************************/

const { buildDispenserFilters, buildDispenserQuery } = require('./dispenser_filters')
const { rethrowInsideWait, logger } = require('./shared')

class DispenserChecks {
    async waitForDispenser(dispenserObject, timeMax = 60000){ return this['_waitFor'](this.checkDispenser, dispenserObject, timeMax) }

    async checkDispenser({blockIndex, txHash, source, giveCoin, giveTick, giveAmount, giveEscrow,
      giveOwnership, getCoin, getTick, getAmount, getAddress, fiatCode, fiatAmount, oracleAddress,
      expiration, allowList, blockList, memo, status}){
        const params = {blockIndex, txHash, source, giveCoin, giveTick, giveAmount, giveEscrow,
            giveOwnership, getCoin, getTick, getAmount, getAddress, fiatCode, fiatAmount, oracleAddress,
            expiration, allowList, blockList, memo, status}
        const {whereClauses, whereValues} = buildDispenserFilters(this, params)
        const query = buildDispenserQuery(whereClauses)
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error('Error with database query (dispenser):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
    
    async waitForDispense(dispenseObject, timeMax = 60000){ return this['_waitFor'](this.checkDispense, dispenseObject, timeMax) }

    buildDispenseFilters({blockIndex, txHash, source, giveCoin,
      giveTick, giveAmount, getCoin, getTick, getAmount,
      destination, status}){
        const whereClauses = []
        const whereValues = []

        const filters = [
            [blockIndex, "tr.block_index = ?"],
            [txHash, "itx.hash = ?"],
            [source, "ias.address = ?"],
            [giveCoin, "give_ic.coin = ?"],
            [giveTick, "give_it.tick = ?"],
            [giveAmount, "d.give_amount = ?"],
            [getCoin, "get_ic.coin = ?"],
            [getTick, "get_it.tick = ?"],
            [getAmount, "d.get_amount = ?"],
            [destination, "iad.address = ?"],
            [status, "ist.status = ?"]
        ]
        for (const [value, clause] of filters){
            if (!this.isNullOrNullString(value)){
                whereClauses.push(clause)
                whereValues.push(value)
            }
        }

        return {whereClauses, whereValues}
    }

    buildDispenseQuery(whereClauses){
        return `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                d.action_index,
                ias.address as source,
                d.dispenser_action_index,
                give_ic.coin AS give_coin,
                give_it.tick AS give_tick,
                d.give_amount,
                get_ic.coin AS get_coin,
                get_it.tick AS get_tick,
                d.get_amount,
                iad.address AS destination,
                ist.status AS status 
            FROM dispenses d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = d.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = d.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = d.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = d.get_tick_id
            LEFT JOIN index_addresses iad ON iad.id = d.destination_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+whereClauses.join(" AND ");
    }

    async checkDispense(dispenseObject){
        const {whereClauses, whereValues} = this.buildDispenseFilters(dispenseObject)
        const query = this.buildDispenseQuery(whereClauses)

        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            logger.error('Error with database query (dispense):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── DISPENSER STATUS ────────────────────────────────────────────────
    async waitForDispenserStatus(obj, timeMax = 60000){ return this['_waitFor'](this.checkDispenserStatus, obj, timeMax) }

    async checkDispenserStatus({dispenserActionIndex, status}){
        const w = [], v = []
        if (dispenserActionIndex != null){ w.push("ds.dispenser_action_index = ?"); v.push(dispenserActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT ds.action_index, ds.dispenser_action_index, ist.status AS status
            FROM dispenser_statuses ds
            LEFT JOIN index_statuses ist ON ist.id = ds.status_id
        `+"WHERE "+w.join(" AND ")+" ORDER BY ds.action_index DESC LIMIT 1";
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (dispenser_status):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
}

module.exports = DispenserChecks
