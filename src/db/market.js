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
 * Address option, destroy, message, price, file, sleep, sweep, dividend and callback checks
 *
 ********************************************************************/

const { rethrowInsideWait, logger } = require('./shared')

class MarketChecks {
    // ─── ADDRESS ───────────────────────────────────────────────────────
    async waitForAddressOption(obj, timeMax = 60000){ return this['_waitFor'](this.checkAddressOption, obj, timeMax) }

    async checkAddressOption({txHash, source, feePreference, requireMemo, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (feePreference != null){ w.push("ao.fee_preference = ?"); v.push(feePreference) }
        if (requireMemo != null){ w.push("ao.require_memo = ?"); v.push(requireMemo) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT ao.*, itx.hash AS tx_hash, ia.address AS source, im.memo AS memo, ist.status AS status
            FROM addresses ao
            LEFT JOIN actions act ON act.action_index = ao.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_memos im ON im.id = ao.memo_id
            LEFT JOIN index_statuses ist ON ist.id = ao.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (address):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── DESTROY ───────────────────────────────────────────────────────
    async waitForDestroy(obj, timeMax = 60000){ return this['_waitFor'](this.checkDestroy, obj, timeMax) }

    async checkDestroy({txHash, source, tick, amount, memo, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (amount != null){ w.push("d.amount = ?"); v.push(amount) }
        if (memo != null){
            if (memo === ''){ w.push("im.memo IS NULL") }
            else { w.push("im.memo = ?"); v.push(memo) }
        }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT d.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, im.memo AS memo, ist.status AS status
            FROM destroys d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id
            LEFT JOIN index_memos im ON im.id = d.memo_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (destroy):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── MESSAGE ───────────────────────────────────────────────────────
    async waitForMessage(obj, timeMax = 60000){ return this['_waitFor'](this.checkMessage, obj, timeMax) }

    async checkMessage({txHash, source, destination, plaintextMessage, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (destination != null){ w.push("iad.address = ?"); v.push(destination) }
        if (plaintextMessage != null){ w.push("m.plaintext_message = ?"); v.push(plaintextMessage) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT m.*, itx.hash AS tx_hash, ias.address AS source, iad.address AS destination, ist.status AS status
            FROM messages m
            LEFT JOIN actions act ON act.action_index = m.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_addresses iad ON iad.id = m.destination_id
            LEFT JOIN index_statuses ist ON ist.id = m.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (message):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── PRICE ─────────────────────────────────────────────────────────
    async waitForPrice(obj, timeMax = 60000){ return this['_waitFor'](this.checkPrice, obj, timeMax) }

    async checkPrice({txHash, source, version, tick, fiat, value, validationStatus, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (version != null){ w.push("p.version = ?"); v.push(version) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (fiat != null){ w.push("ifi.code = ?"); v.push(fiat) }
        if (value != null){ w.push("p.value = ?"); v.push(value) }
        if (validationStatus != null){ w.push("p.validation_status = ?"); v.push(validationStatus) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT p.*, itx.hash AS tx_hash, ias.address AS source,
                   icoin.coin AS v1_coin, itick.tick AS v1_tick, ifi.code AS v1_fiat,
                   ist.status AS status
            FROM prices p
            LEFT JOIN actions act ON act.action_index = p.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = p.source_id
            LEFT JOIN index_coins icoin ON icoin.id = p.coin_id
            LEFT JOIN index_tickers itick ON itick.id = p.tick_id
            LEFT JOIN index_fiats ifi ON ifi.id = p.fiat_id
            LEFT JOIN index_statuses ist ON ist.id = p.status_id
        `+"WHERE "+w.join(" AND ")+" ORDER BY p.action_index DESC LIMIT 1";
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (price):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── FILE ──────────────────────────────────────────────────────────
    async waitForFile(obj, timeMax = 60000){ return this['_waitFor'](this.checkFile, obj, timeMax) }

    async checkFile({txHash, source, name, title, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (name != null){ w.push("f.name = ?"); v.push(name) }
        if (title != null){ w.push("f.title = ?"); v.push(title) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT f.*, itx.hash AS tx_hash, ia.address AS source, im.memo AS memo, ist.status AS status
            FROM files f
            LEFT JOIN actions act ON act.action_index = f.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_memos im ON im.id = f.memo_id
            LEFT JOIN index_statuses ist ON ist.id = f.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (file):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── SLEEP ─────────────────────────────────────────────────────────
    async waitForSleep(obj, timeMax = 60000){ return this['_waitFor'](this.checkSleep, obj, timeMax) }

    async checkSleep({txHash, source, type, tick, resumeBlock, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (type != null){ w.push("s.type = ?"); v.push(type) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (resumeBlock != null){ w.push("s.resume_block = ?"); v.push(resumeBlock) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT s.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, im.memo AS memo, ist.status AS status
            FROM sleeps s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = s.tick_id
            LEFT JOIN index_memos im ON im.id = s.memo_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (sleep):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── SWEEP ─────────────────────────────────────────────────────────
    async waitForSweep(obj, timeMax = 60000){ return this['_waitFor'](this.checkSweep, obj, timeMax) }

    async checkSweep({txHash, source, destination, balances, ownerships, orders, swaps, dispensers, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (destination != null){ w.push("iad.address = ?"); v.push(destination) }
        if (balances != null){ w.push("sw.balances = ?"); v.push(balances) }
        if (ownerships != null){ w.push("sw.ownerships = ?"); v.push(ownerships) }
        if (orders != null){ w.push("sw.orders = ?"); v.push(orders) }
        if (swaps != null){ w.push("sw.swaps = ?"); v.push(swaps) }
        if (dispensers != null){ w.push("sw.dispensers = ?"); v.push(dispensers) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT sw.*, itx.hash AS tx_hash, ias.address AS source, iad.address AS destination, im.memo AS memo, ist.status AS status
            FROM sweeps sw
            LEFT JOIN actions act ON act.action_index = sw.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_addresses iad ON iad.id = sw.destination_id
            LEFT JOIN index_memos im ON im.id = sw.memo_id
            LEFT JOIN index_statuses ist ON ist.id = sw.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (sweep):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── DIVIDEND ──────────────────────────────────────────────────────
    async waitForDividend(obj, timeMax = 60000){ return this['_waitFor'](this.checkDividend, obj, timeMax) }

    async checkDividend({txHash, source, tick, dividendTick, amount, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (dividendTick != null){ w.push("itick2.tick = ?"); v.push(dividendTick) }
        if (amount != null){ w.push("d.amount = ?"); v.push(amount) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT d.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, itick2.tick AS dividend_tick, im.memo AS memo, ist.status AS status
            FROM dividends d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id
            LEFT JOIN index_tickers itick2 ON itick2.id = d.dividend_tick_id
            LEFT JOIN index_memos im ON im.id = d.memo_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (dividend):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }

    // ─── CALLBACK ──────────────────────────────────────────────────────
    async waitForCallback(obj, timeMax = 60000){ return this['_waitFor'](this.checkCallback, obj, timeMax) }

    async checkCallback({txHash, source, tick, callbackTick, status}){
        const w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (callbackTick != null){ w.push("itick2.tick = ?"); v.push(callbackTick) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT c.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, itick2.tick AS callback_tick, im.memo AS memo, ist.status AS status
            FROM callbacks c
            LEFT JOIN actions act ON act.action_index = c.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = c.tick_id
            LEFT JOIN index_tickers itick2 ON itick2.id = c.callback_tick_id
            LEFT JOIN index_memos im ON im.id = c.memo_id
            LEFT JOIN index_statuses ist ON ist.id = c.status_id
        `+"WHERE "+w.join(" AND ");
        const connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            logger.error('Error with database query (callback):', err);
            return rethrowInsideWait(err)
        } finally {
            await connection.release()
        }
    }
}

module.exports = MarketChecks
