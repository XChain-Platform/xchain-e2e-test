/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 ********************************************************************/

'use strict';

function emptyArchiveWatermarks(){
    return { batchSeq: null, checkpointSeq: null };
}

function unexpectedIndexerRead(target, name){
    if(Reflect.has(target, name)) return Reflect.get(target, name);
    throw new Error('anchor parse stub: unexpected indexerDb.' + String(name));
}

function makeIndexerDb(rows){
    const indexerDb = {
        createAnchorAction: async (row) => { rows.push(Object.assign({}, row)); return true; },
        getValidatorsByCapability: async () => null,
        getStakeWeightsByCapability: async () => null,
        getMaxAnchorCheckpointSeq: async () => null,
        getArchiveReplayWatermarks: async () => emptyArchiveWatermarks(),
        getAnchorV1ByBatchSeq: async () => null,
        getAnchorChunks: async () => []
    };
    return new Proxy(indexerDb, { get: unexpectedIndexerRead });
}

function makeAnchorParseContext({ coin, network }){
    const rows = [];
    const action = {
        config: { COIN: coin, NETWORK: network },
        decoderDb: {},
        indexerDb: makeIndexerDb(rows),
        util: {},
        mapper: { createMappings: async () => {} }
    };
    return { action, rows };
}

function anchorParseArgs(wire, { blockIndex, txHash, source }){
    const fields = String(wire).split('|').map(value => value.trim());
    const action = String(fields.shift()).toUpperCase();
    const params = fields;
    return {
        params,
        data: {
            ACTION: action,
            FORMAT: Number(params[0]),
            BLOCK_INDEX: blockIndex,
            SOURCE: source,
            TX_HASH: txHash
        },
        error: false
    };
}

module.exports = { makeAnchorParseContext, anchorParseArgs };
