'use strict';

/*********************************************************************
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 ********************************************************************/

const CALLBACK_TARGET_SOURCE = `
    module.exports = {
        meta: { name: 'Vote Callback', description: 'Records that a poll result callback fired.', version: '1.0.0' },
        initialize: function() { xchain.state.set('fired', '0'); },
        onPoll: function() {
            xchain.state.set('fired', '1');
            xchain.state.set('poll', xchain.getInputParam(0));
            xchain.state.set('status', xchain.getInputParam(1));
            xchain.state.set('winner', xchain.getInputParam(2));
            xchain.state.set('voters', xchain.getInputParam(4));
            return 'ok';
        }
    };
`;

const USABLE_METHOD_CASES = Object.freeze([
    Object.freeze({
        name: 'available callback method',
        method: 'onPoll',
        armed: 'valid',
        inert: 'valid'
    }),
    Object.freeze({
        name: 'unavailable callback method',
        method: 'noSuchMethod',
        armed: 'invalid: CALLBACK_METHOD (unavailable)',
        inert: 'valid'
    })
]);

function expectMode(value){
    if(value === undefined || value === '' || value === 'armed') return 'armed';
    if(value === 'inert') return 'inert';
    throw new Error('XC_VOTE_CALLBACK_BINDING_EXPECT must be armed or inert');
}

module.exports = { CALLBACK_TARGET_SOURCE, USABLE_METHOD_CASES, expectMode };
