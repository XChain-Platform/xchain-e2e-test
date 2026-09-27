/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const { parseAnchorV3 } = require('./parse_anchor_v3');

function selectSingleAnchorV3Broadcast(payloads){
    const parsed = payloads.map(parseAnchorV3).filter((payload) => payload !== null);
    if(parsed.length !== 1)
        throw new Error('expected exactly one ANCHOR v3 broadcast, got ' + parsed.length);
    return parsed[0];
}

module.exports = { selectSingleAnchorV3Broadcast };
