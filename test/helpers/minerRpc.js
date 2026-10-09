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
// Responses go through the connector's unwrap(): a refusal arrives as {error} inside result.

const axios = require('axios')
const RegtestMinerConnector = require('../../src/regtest_miner_connector')

/**
 * @param {string} url - the miner's JSON-RPC endpoint
 * @param {string} method - e.g. 'send_funds', 'generate_blocks'
 * @param {object} [params]
 * @param {{timeout?: number}} [opts] - axios timeout in ms; 0 means none (default 20000)
 * @returns {Promise<*>} the unwrapped result; rejects on any refusal
 */
async function minerRpc (url, method, params, opts = {}) {
    const timeout = opts.timeout === undefined ? 20000 : opts.timeout
    const res = await axios.post(url, { jsonrpc: '2.0', method, params: params || {}, id: 1 }, { timeout })
    try {
        return RegtestMinerConnector.prototype.unwrap(res)
    } catch (e) {
        throw new Error(method + ': ' + e.message, { cause: e })
    }
}

module.exports = { minerRpc }
