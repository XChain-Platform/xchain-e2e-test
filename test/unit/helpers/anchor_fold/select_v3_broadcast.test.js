/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { parseAnchorV3 } = require('../../../helpers/anchor_fold/parse_anchor_v3');
const {
    selectSingleAnchorV3Broadcast
} = require('../../../helpers/anchor_fold/select_v3_broadcast');

const PIPE = String.fromCharCode(124);

function section(chain, blockIndex){
    return [
        chain, blockIndex, chain + '-block', chain + '-ledger', chain + '-actions',
        chain + '-contract', blockIndex + 1, 72, chain + '-state', 1,
        chain + '-merkle', 2, 1, chain + '-key', chain + '-sig'
    ];
}

function v3Payload(chain){
    return [
        'ANCHOR', 3, 'regtest', 72, 1,
        ...section(chain, 100),
        0, 'publisher-key', 1, 'attest-key', 'attest-sig'
    ].join(PIPE);
}

function v0Payload(){
    return v3Payload('BTC').replace('ANCHOR|3|', 'ANCHOR|0|');
}

describe('selectSingleAnchorV3Broadcast', function () {
    it('returns the one parsed v3 broadcast among v0 and v3 payloads', function () {
        const payload = v3Payload('LTC');
        assert.deepStrictEqual(
            selectSingleAnchorV3Broadcast([v0Payload(), payload]),
            parseAnchorV3(payload)
        );
    });

    it('rejects two v3 broadcasts', function () {
        assert.throws(() => selectSingleAnchorV3Broadcast([
            v3Payload('BTC'), v3Payload('LTC')
        ]), /got 2/);
    });

    it('rejects zero v3 broadcasts', function () {
        assert.throws(() => selectSingleAnchorV3Broadcast([v0Payload()]), /got 0/);
    });
});
