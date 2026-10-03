'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 ********************************************************************/

const PROVIDER_ENV = 'AT5_RESPONSE_PROVIDER'
const DEFAULT_PROVIDER = 'llm'
const HTTP_GET_PROVIDER = 'http_get'

function resolveAt5ResponseProvider (env) {
    const source = env || {}
    const value = source[PROVIDER_ENV]
    if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_PROVIDER

    const provider = String(value).trim()
    if (provider === DEFAULT_PROVIDER || provider === HTTP_GET_PROVIDER) return provider

    throw new Error(PROVIDER_ENV + ' must be "llm" or "http_get", got "' + provider + '"')
}

function buildAt5DogeIndexerConfig (apiUrl, network) {
    const target = new URL(String(apiUrl || ''))
    if (!['http:', 'https:'].includes(target.protocol) || !target.hostname || !target.port) {
        throw new Error('AT5 DOGE indexer needs an http(s) URL with an explicit port')
    }
    const net = String(network || '').trim()
    if (!net) throw new Error('AT5 DOGE indexer config needs a network')
    return {
        dogecoin: {
            [net]: {
                'xchain-indexer': { host: target.hostname, port: target.port },
            },
        },
    }
}

function at5ResponseRedundancy (provider) {
    return provider === HTTP_GET_PROVIDER ? 5 : 3
}

module.exports = {
    PROVIDER_ENV,
    DEFAULT_PROVIDER,
    HTTP_GET_PROVIDER,
    resolveAt5ResponseProvider,
    buildAt5DogeIndexerConfig,
    at5ResponseRedundancy,
}
