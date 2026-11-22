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

const HEALTH_REQUEST = Object.freeze({
    jsonrpc: '2.0',
    id: 1,
    method: 'health',
    params: {},
})

function healthAnswerFor (healthByHub, index) {
    if (healthByHub instanceof Map) return healthByHub.get(index)
    return healthByHub && healthByHub[index]
}

function batchStats (answer) {
    if (!answer || typeof answer !== 'object') return {}
    const stats = answer.result && answer.result.attest_batch !== undefined
        ? answer.result.attest_batch
        : answer.attest_batch
    return stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {}
}

function composeHubsReading (hubs, markerRows, healthByHub) {
    return hubs.map((hub) => ({
        hub: 'hub-' + hub.index,
        stats: batchStats(healthAnswerFor(healthByHub, hub.index)),
        markers: markerRows
            .filter((row) => Number(row.hub) === Number(hub.index))
            .map((row) => ({
                window_start: Number(row.window_start),
                status: String(row.status),
            })),
    }))
}

async function defaultPost (url, body) {
    const axios = require('axios')
    return await axios.post(url, body, {
        timeout: 10_000,
        validateStatus: () => true,
    })
}

async function readHubsReading (hubs, markerRows, options) {
    const post = options && options.post ? options.post : defaultPost
    const healthByHub = new Map()

    await Promise.all(hubs.map(async (hub) => {
        try {
            const response = await post(hub.apiUrl, HEALTH_REQUEST)
            const answer = response && Object.prototype.hasOwnProperty.call(response, 'data')
                ? response.data
                : response
            healthByHub.set(hub.index, answer)
        } catch (internal) {
            healthByHub.set(hub.index, undefined)
        }
    }))

    return composeHubsReading(hubs, markerRows, healthByHub)
}

module.exports = { composeHubsReading, readHubsReading }
