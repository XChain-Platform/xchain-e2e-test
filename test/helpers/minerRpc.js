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
 *********************************************************************/

'use strict'

// Call a regtest miner by URL with a per-call timeout, for suites without a connector.
// Posts through the connector, so a keyed miner gets x-api-key and a 401 names the key;
// responses go through unwrap(): a refusal arrives as {error} inside result.

const RegtestMinerConnector = require('../../src/regtest_miner_connector')

/**
 * Resolve the miner API key with chainRail's precedence: <CODE>_MINER_API_KEY, then MINER_API_KEY.
 * @param {string} [code] - chain code such as 'DOGE'; omitted, only MINER_API_KEY is read
 * @returns {string|null}
 */
function resolveMinerApiKey (code) {
    return (code && process.env[code + '_MINER_API_KEY']) || process.env.MINER_API_KEY || null
}

/**
 * @param {string} url - the miner's JSON-RPC endpoint
 * @param {string} method - e.g. 'send_funds', 'generate_blocks'
 * @param {object} [params]
 * @param {{timeout?: number, apiKey?: string|null, coin?: string}} [opts] - axios timeout in ms,
 *   0 means none (default 20000); apiKey, when present (null included), wins over the env lookup
 *   by coin
 * @returns {Promise<*>} the unwrapped result; rejects on any refusal
 */
async function minerRpc (url, method, params, opts = {}) {
    const timeout = opts.timeout === undefined ? 20000 : opts.timeout
    const apiKey = Object.prototype.hasOwnProperty.call(opts, 'apiKey') ? opts.apiKey : resolveMinerApiKey(opts.coin)
    const connector = RegtestMinerConnector.fromUrl(url, apiKey)
    const res = await connector.post({ jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout })
    try {
        return RegtestMinerConnector.prototype.unwrap(res)
    } catch (e) {
        throw new Error(method + ': ' + e.message, { cause: e })
    }
}

module.exports = { minerRpc, resolveMinerApiKey }
