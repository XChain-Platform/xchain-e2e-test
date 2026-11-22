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
 ********************************************************************/

'use strict';

// What the SERVICE said, when it said anything at all.
// The indexer refuses a gated call with a non-2xx status whose body is still a
// JSON-RPC envelope (api.js: 401 + {error:{code:-32001,message:'Unauthorized...'}}).
// Axios rejects on any non-2xx, so a catch that never reads err.response cannot
// tell "the indexer refused this" from "nothing answered the socket".
// Returns null for a responseless failure (ECONNREFUSED, timeout, DNS), which is
// the only case the connectors' null/false sentinel is meant to cover.
function serviceRefusal(err){
    const res = err && err.response
    if(!res) return null
    const body = res.data && res.data.error
    if(body) return typeof body === 'object' ? (body.message || JSON.stringify(body)) : String(body)
    return 'HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : '')
}

module.exports = { serviceRefusal };
