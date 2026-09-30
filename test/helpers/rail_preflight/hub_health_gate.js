/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const { classifyHubPingResponse } = require('./hub_ping_response');

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireHealthyHub(pingOnce, { attempts = 3, waitMs = 2000 } = {}) {
    let detail = 'unreachable';

    for(let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const response = await pingOnce();
            const reading = classifyHubPingResponse(response.statusCode, response.bodyText);
            detail = reading.detail;
            if(reading.ok) return detail;
        } catch(error) {
            detail = 'unreachable: ' + error.message;
        }
        if(attempt + 1 < attempts) await wait(waitMs);
    }

    throw new Error('hub not healthy: ' + detail);
}

module.exports = { requireHealthyHub };
