// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Picks the env file for the coin a run asks for. A run naming a coin that .env does
// not describe loads .env.<code> (the chainRail files) and never .env, since dotenv
// would fill every key the coin file lacks from the other coin's stack.

// Validators and stakes live on BTC, so a DOGE or LTC run still takes the BTC indexer
// URL from .env when BTC_INDEXER_API_URL is unset. No credential crosses over.

const fs = require('fs')
const path = require('path')
const dotenv = require('dotenv')

const COIN_CODES = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }

// The coin a run asked for, read the way initialCheck reads it: COIN, else the prefix
// of a combined NETWORK such as "dogecoin-regtest".
function requestedCoin(env){
    if (env.COIN) return String(env.COIN)
    if (env.NETWORK && String(env.NETWORK).indexOf('-') > 0) return String(env.NETWORK).split('-')[0]
    return null
}

function coinCode(coin){
    return COIN_CODES[coin] || String(coin).toUpperCase().slice(0, 3)
}

function readEnvFile(file, fsImpl){
    if (!fsImpl.existsSync(file)) return null
    return dotenv.parse(fsImpl.readFileSync(file))
}

// Pure decision: which file to load, and what to derive. Never touches process.env.
//   { file, values, derived: { BTC_INDEXER_API_URL? }, reason }
// `file` is null when there is nothing to load.
function resolveCoinEnv({ dir, env, fs: fsImpl = fs }){
    const baseFile = path.join(dir, '.env')
    const base = readEnvFile(baseFile, fsImpl)
    const coin = requestedCoin(env)

    if (!coin || !base || !base.COIN || base.COIN === coin)
        return { file: base ? baseFile : null, values: base || {}, derived: {}, reason: 'default' }

    const coinFile = path.join(dir, '.env.' + coinCode(coin).toLowerCase())
    const chosen = readEnvFile(coinFile, fsImpl)
    if (!chosen) {
        return {
            file: baseFile, values: base, derived: {}, reason: 'mismatch-no-coin-file',
            warning: 'COIN=' + coin + ' but .env describes ' + base.COIN + ' and ' +
                path.basename(coinFile) + ' does not exist; loading .env, so every setting it ' +
                'carries still points at the ' + base.COIN + ' stack'
        }
    }
    if (chosen.COIN && chosen.COIN !== coin) {
        throw new Error('coin_env: COIN=' + coin + ' selected ' + path.basename(coinFile) +
            ', which describes ' + chosen.COIN + '; refusing to run one coin against another coin\'s stack')
    }

    const derived = {}
    if (coin !== 'bitcoin' && !env.BTC_INDEXER_API_URL && base.COIN === 'bitcoin' && base.INDEXER_API_PORT)
        derived.BTC_INDEXER_API_URL = 'http://' + (base.INDEXER_URL || 'localhost') + ':' + base.INDEXER_API_PORT

    return { file: coinFile, values: chosen, derived, reason: 'coin-file' }
}

// Apply the decision to `env` with dotenv's own rule: a variable already set wins.
// Returns the decision so the caller can say what it loaded (file name only).
function loadCoinEnv({ dir, env = process.env, fs: fsImpl = fs } = {}){
    const decision = resolveCoinEnv({ dir, env, fs: fsImpl })
    for (const [key, value] of Object.entries(decision.values))
        if (env[key] === undefined) env[key] = value
    for (const [key, value] of Object.entries(decision.derived))
        if (env[key] === undefined) env[key] = value
    return decision
}

module.exports = { resolveCoinEnv, loadCoinEnv, requestedCoin }
