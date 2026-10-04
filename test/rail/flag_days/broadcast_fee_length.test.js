'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const assert = require('assert');
const cryptoHelper = require('../../helpers/core/cryptoHelper');
const broadcastHelper = require('../../helpers/broadcastHelper');
const { BROADCAST_FEE_CASES } = require('./helpers/broadcast_fee_cases');

async function sendCase(addressInfo, testCase){
    const database = global.indexerDatabase;
    const originalWait = database.waitForBroadcast;
    database.waitForBroadcast = (query, timeout) => {
        const indexedQuery = { ...query, status: testCase.expect };
        if(testCase.expect !== 'valid') delete indexedQuery.fee;
        return originalWait.call(database, indexedQuery, timeout);
    };
    try {
        if(testCase.format === 0)
            return await broadcastHelper.sendBroadcastV0(addressInfo, 'fee length control', 1);
        return await broadcastHelper.sendBroadcastV1(
            addressInfo, 'fee length boundary', 1, testCase.fee, 'fee length rail'
        );
    } finally {
        database.waitForBroadcast = originalWait;
    }
}

describe('BROADCAST FEE length flag day', function(){
    for(const [index, testCase] of BROADCAST_FEE_CASES.entries()){
        it(testCase.name, async function(){
            const addressInfo = await cryptoHelper.getNewFundedAddress(
                'BROADCAST.FEE.LENGTH.' + index, COIN, NETWORK, null, 'legacy', 0, 1
            );
            const result = await sendCase(addressInfo, testCase);
            assert.strictEqual(result.broadcast.status, testCase.expect);
        });
    }
});
