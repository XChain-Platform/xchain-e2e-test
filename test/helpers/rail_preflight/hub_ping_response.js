/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

function classifyHubPingResponse(statusCode, bodyText){
    if(statusCode !== 200) return { ok: false, detail: 'HTTP ' + statusCode };

    try {
        const body = JSON.parse(bodyText);
        if(body.error)
            return { ok: false, detail: 'rpc error ' + (body.error.code || '') };
        return { ok: true, detail: (body.result && body.result.status) || 'ok' };
    } catch (error) {
        return { ok: false, detail: 'bad json' };
    }
}

module.exports = { classifyHubPingResponse };
