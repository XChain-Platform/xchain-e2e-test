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
 * Order, order match, swap, batch and link checks
 *
 ********************************************************************/

const { rethrowInsideWait, logger } = require('./shared')

class OrderChecks {
    // ─── ORDER ─────────────────────────────────────────────────────────
    async waitForOrder(obj, timeMax = 60000){ return this['_waitFor'](this.checkOrder, obj, timeMax) }

    async checkOrder({txHash, source, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount, getAddress, expiration, status, orderStatus}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (giveCoin != null){ w.push("give_ic.coin = ?"); v.push(giveCoin) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        // orders.give_amount/get_amount are VARCHAR(250), so string-comparing them
        // against the test's raw input ("100.00000000", "0.00000003") misses the
        // DB row, which stores the bignumber-normalized form ("100", "3e-8").
        // Coerce both sides to numeric via +0 so the match is by value, not by
        // string representation.
        if (giveAmount != null){ w.push("o.give_amount+0 = ?+0"); v.push(giveAmount) }
        if (getCoin != null){ w.push("get_ic.coin = ?"); v.push(getCoin) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (getAmount != null){ w.push("o.get_amount+0 = ?+0"); v.push(getAmount) }
        if (getAddress != null){ w.push("get_ia.address = ?"); v.push(getAddress) }
        if (expiration != null){ w.push("o.expiration = ?"); v.push(expiration) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (orderStatus != null){ w.push("os_ist.status = ?"); v.push(orderStatus) }
        const query = `
            SELECT o.*, itx.hash AS tx_hash, ias.address AS source,
                give_ic.coin AS give_coin, give_it.tick AS give_tick,
                get_ic.coin AS get_coin, get_it.tick AS get_tick,
                get_ia.address AS get_address, im.memo AS memo, ist.status AS status,
                os_ist.status AS order_status
            FROM orders o
            LEFT JOIN actions act ON act.action_index = o.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = o.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = o.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = o.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = o.get_tick_id
            LEFT JOIN index_addresses get_ia ON get_ia.id = o.get_address_id
            LEFT JOIN index_memos im ON im.id = o.memo_id
            LEFT JOIN index_statuses ist ON ist.id = o.status_id
            LEFT JOIN order_statuses os ON os.order_action_index = o.action_index
                AND os.action_index = (SELECT MAX(os2.action_index) FROM order_statuses os2 WHERE os2.order_action_index = o.action_index)
            LEFT JOIN index_statuses os_ist ON os_ist.id = os.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (order):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── ORDER MATCH ──────────────────────────────────────────────────
    async waitForOrderMatch(obj, timeMax = 60000){ return this['_waitFor'](this.checkOrderMatch, obj, timeMax) }

    async checkOrderMatch({giveActionIndex, getActionIndex, giveTick, getTick, giveAmount, getAmount, status}){
        const w = [], v = []
        if (giveActionIndex != null){ w.push("om.give_action_index = ?"); v.push(giveActionIndex) }
        if (getActionIndex != null){ w.push("om.get_action_index = ?"); v.push(getActionIndex) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (giveAmount != null){ w.push("om.give_amount = ?"); v.push(giveAmount) }
        if (getAmount != null){ w.push("om.get_amount = ?"); v.push(getAmount) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT om.*,
                give_it.tick AS give_tick, get_it.tick AS get_tick,
                ist.status AS status
            FROM order_matches om
            LEFT JOIN index_tickers give_it ON give_it.id = om.give_tick_id
            LEFT JOIN index_tickers get_it ON get_it.id = om.get_tick_id
            LEFT JOIN index_statuses ist ON ist.id = om.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (order_match):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── SWAP ──────────────────────────────────────────────────────────
    async waitForSwap(obj, timeMax = 60000){ return this['_waitFor'](this.checkSwap, obj, timeMax) }

    async checkSwap({txHash, source, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount, getAddress, expiration, status, swapStatus}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (giveCoin != null){ w.push("give_ic.coin = ?"); v.push(giveCoin) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        if (giveAmount != null){ w.push("s.give_amount = ?"); v.push(giveAmount) }
        if (getCoin != null){ w.push("get_ic.coin = ?"); v.push(getCoin) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (getAmount != null){ w.push("s.get_amount = ?"); v.push(getAmount) }
        if (getAddress != null){ w.push("get_ia.address = ?"); v.push(getAddress) }
        if (expiration != null){ w.push("s.expiration = ?"); v.push(expiration) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (swapStatus != null){ w.push("ss_ist.status = ?"); v.push(swapStatus) }
        const query = `
            SELECT s.*, itx.hash AS tx_hash, ias.address AS source,
                give_ic.coin AS give_coin, give_it.tick AS give_tick,
                get_ic.coin AS get_coin, get_it.tick AS get_tick,
                get_ia.address AS get_address, im.memo AS memo, ist.status AS status,
                ss_ist.status AS swap_status
            FROM swaps s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = s.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = s.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = s.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = s.get_tick_id
            LEFT JOIN index_addresses get_ia ON get_ia.id = s.get_address_id
            LEFT JOIN index_memos im ON im.id = s.memo_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            LEFT JOIN swap_statuses ss ON ss.swap_action_index = s.action_index
                AND ss.action_index = (SELECT MAX(ss2.action_index) FROM swap_statuses ss2 WHERE ss2.swap_action_index = s.action_index)
            LEFT JOIN index_statuses ss_ist ON ss_ist.id = ss.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (swap):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── SWAP MATCH ───────────────────────────────────────────────────
    async waitForSwapMatch(obj, timeMax = 60000){ return this['_waitFor'](this.checkSwapMatch, obj, timeMax) }

    async checkSwapMatch({giveActionIndex, getActionIndex, giveTick, getTick, giveAmount, getAmount, status}){
        const w = [], v = []
        if (giveActionIndex != null){ w.push("sm.give_action_index = ?"); v.push(giveActionIndex) }
        if (getActionIndex != null){ w.push("sm.get_action_index = ?"); v.push(getActionIndex) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (giveAmount != null){ w.push("sm.give_amount = ?"); v.push(giveAmount) }
        if (getAmount != null){ w.push("sm.get_amount = ?"); v.push(getAmount) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT sm.*,
                give_it.tick AS give_tick, get_it.tick AS get_tick,
                ist.status AS status
            FROM swap_matches sm
            LEFT JOIN index_tickers give_it ON give_it.id = sm.give_tick_id
            LEFT JOIN index_tickers get_it ON get_it.id = sm.get_tick_id
            LEFT JOIN index_statuses ist ON ist.id = sm.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (swap_match):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── BATCH ─────────────────────────────────────────────────────────
    async waitForBatch(obj, timeMax = 60000){ return this['_waitFor'](this.checkBatch, obj, timeMax) }

    async checkBatch({txHash, source, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT b.*, itx.hash AS tx_hash, ia.address AS source, ist.status AS status
            FROM batches b
            LEFT JOIN actions act ON act.action_index = b.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_statuses ist ON ist.id = b.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (batch):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── LINK ──────────────────────────────────────────────────────────
    async waitForLink(obj, timeMax = 60000){ return this['_waitFor'](this.checkLink, obj, timeMax) }

    async checkLink({txHash, source, coin1, coin1ActionIndex, coin2, coin2ActionIndex, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (coin1 != null){ w.push("ic1.coin = ?"); v.push(coin1) }
        if (coin1ActionIndex != null){ w.push("l.coin1_action_index = ?"); v.push(coin1ActionIndex) }
        if (coin2 != null){ w.push("ic2.coin = ?"); v.push(coin2) }
        if (coin2ActionIndex != null){ w.push("l.coin2_action_index = ?"); v.push(coin2ActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT l.*, itx.hash AS tx_hash, ia.address AS source,
                ic1.coin AS coin1, ic2.coin AS coin2, im.memo AS memo, ist.status AS status
            FROM links l
            LEFT JOIN actions act ON act.action_index = l.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_coins ic1 ON ic1.id = l.coin1_id
            LEFT JOIN index_coins ic2 ON ic2.id = l.coin2_id
            LEFT JOIN index_memos im ON im.id = l.memo_id
            LEFT JOIN index_statuses ist ON ist.id = l.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (link):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── ORDER_MATCH ──────────────────────────────────────────────────
    async waitForOrderMatch(obj, timeMax = 60000){ return this['_waitFor'](this.checkOrderMatch, obj, timeMax) }

    async checkOrderMatch({giveActionIndex, getActionIndex, status}){
        const w = [], v = []
        if (giveActionIndex != null){ w.push("m.give_action_index = ?"); v.push(giveActionIndex) }
        if (getActionIndex != null){ w.push("m.get_action_index = ?"); v.push(getActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT m.*, ist.status AS status
            FROM order_matches m
            LEFT JOIN index_statuses ist ON ist.id = m.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (order_match):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
}

module.exports = OrderChecks
