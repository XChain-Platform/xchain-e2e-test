// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Chooses where BTC-side XCHAIN gas comes from. The e2e ISSUE caps MAX_SUPPLY, and a
// long-lived regtest mints it all into fixture addresses, so a grant is a SEND from a
// keyed faucet holder; MINT stays for a fresh chain, and a chain with neither refuses.

// The faucet file is a 0600 JSON array of { address, mnemonic } under the gitignored
// drill-keys/, the shape of the staker files there. Only addresses and amounts are logged.

const fs = require('fs')
const path = require('path')

const DEFAULT_FAUCET_FILE = path.resolve(__dirname, '../../../drill-keys/gas-faucet.json')

// Base units per whole XCHAIN, for exact balance comparisons.
const SCALE = 10n ** 8n

function faucetFile(env = process.env){
    return env.E2E_GAS_FAUCET_FILE || DEFAULT_FAUCET_FILE
}

// Converts a decimal to base units; null for anything malformed, so it never reads as enough.
function units(amount){
    const m = String(amount).trim().match(/^(\d+)(?:\.(\d+))?$/)
    if (!m) return null
    const frac = (m[2] || '').slice(0, 8).padEnd(8, '0')
    return BigInt(m[1]) * SCALE + BigInt(frac)
}

// Reads faucet records, [] when there is no file. An unreadable file throws: an empty
// faucet would fall back to a MINT the chain may refuse.
function readFaucetRecords(file, fsImpl = fs){
    if (!fsImpl.existsSync(file)) return []
    let parsed
    try { parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8')) }
    catch (e) { throw new Error('gas_faucet: ' + file + ' is not valid JSON') }
    if (!Array.isArray(parsed)) throw new Error('gas_faucet: ' + file + ' must hold a JSON array of { address, mnemonic }')
    return parsed.filter((r) => r && typeof r.address === 'string' && typeof r.mnemonic === 'string')
}

// Decides send, mint or refuse. Holders that cover the amount go least recently used
// first (back-to-back grants spread over addresses), then larger balance, then address.
// supply is { supply, maxSupply }, or null when unreadable.
function planGasFunding({ amount, holders = [], lastUsed = new Map(), supply = null }){
    const need = units(amount)
    if (need === null) throw new Error('gas_faucet: not a gas amount: ' + amount)

    const able = holders
        .map((h) => ({ address: h.address, bal: units(h.balance) }))
        .filter((h) => h.bal !== null && h.bal >= need)
        .sort((a, b) => {
            const ua = lastUsed.get(a.address) || 0
            const ub = lastUsed.get(b.address) || 0
            if (ua !== ub) return ua - ub
            if (a.bal !== b.bal) return a.bal > b.bal ? -1 : 1
            return a.address < b.address ? -1 : 1
        })
    if (able.length) return { kind: 'send', address: able[0].address }

    // An unreadable supply keeps the MINT; the indexer still grades it.
    if (!supply) return { kind: 'mint' }
    const minted = units(supply.supply)
    const max = units(supply.maxSupply)
    if (minted === null || max === null || minted + need <= max) return { kind: 'mint' }

    const best = holders.map((h) => units(h.balance)).filter((b) => b !== null).reduce((a, b) => (b > a ? b : a), 0n)
    return {
        kind: 'refuse',
        reason: 'no faucet holder covers ' + amount + ' XCHAIN (' + holders.length + ' holder(s), largest ' +
            (best / SCALE).toString() + ') and a MINT would exceed MAX_SUPPLY (supply ' + supply.supply +
            ' of ' + supply.maxSupply + ')'
    }
}

// Reads the gas tick's supply off the indexer, or null when it cannot.
async function readGasSupply(db, tick){
    if (!db || typeof db.getConnection !== 'function') return null
    let conn = null
    try {
        conn = await db.getConnection()
        const rows = await conn.query(
            'SELECT t.supply, t.max_supply FROM tokens t JOIN index_tickers it ON it.id = t.tick_id WHERE it.tick = ? LIMIT 1',
            [tick])
        if (!rows || !rows.length) return null
        return { supply: String(rows[0].supply), maxSupply: String(rows[0].max_supply) }
    } catch (e) {
        return null
    } finally {
        if (conn) { try { await conn.release() } catch (e) {} }
    }
}

// Reads each faucet holder's balance; an unreadable one counts as zero.
async function readHolderBalances(db, records, tick){
    const out = []
    for (const r of records) {
        let balance = null
        try { balance = db && typeof db.getBalance === 'function' ? await db.getBalance({ address: r.address, tick }) : null }
        catch (e) { balance = null }
        out.push({ address: r.address, balance: balance === null || balance === undefined ? '0' : String(balance) })
    }
    return out
}

module.exports = {
    DEFAULT_FAUCET_FILE,
    faucetFile,
    units,
    readFaucetRecords,
    planGasFunding,
    readGasSupply,
    readHolderBalances,
}
