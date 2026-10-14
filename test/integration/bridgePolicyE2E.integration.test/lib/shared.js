/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

// Fixtures shared by the parts of bridgePolicyE2E.integration.test.

const dotenv = require('dotenv');
dotenv.config();

const crypto = require('crypto');

const HUB    = require('../../../helpers/bridgeHubRecord');
const SETTLE = require('../../../helpers/bridgeSettleContext');
const { startDisposableHubDb } = require('../../../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../../../helpers/seededWeightSnapshot');
const { MultiValidatorHub }    = require('../../../helpers/multiValidatorHubHelper');
const { BridgePendingSource }  = require('../../../helpers/bridgePendingSource');
const { waitForMesh, waitFor } = require('../../../helpers/consensusWait');

const BS = SETTLE.bridgeSettle;

const NETWORK    = 'regtest';
const SNAPSHOT   = 1200;
const ORIGIN_BLK = 1150;
const BLOCK      = 900;
const BLOCK_TIME = 2000;
const DUE_TIME   = 1000;
const TICK       = 'FUFU';
const COPY       = 'BTC.FUFU';

// Two DOGE-format addresses in strict byte order, which is the order a type-2 list is
// built and hashed in. Byte order, not JavaScript's default string compare: the guard is
// written against the rule, so the fixture has to be too.
const MEMBER_A = 'nBlockedAddressAXXXXXXXXXXXXXXXXXX';
const MEMBER_B = 'nBlockedAddressBXXXXXXXXXXXXXXXXXX';
const MEMBER_C = 'nBlockedAddressCXXXXXXXXXXXXXXXXXX';

// The bridged copy as a destination chain holds it once a transfer in-leg has created it.
function copyRow(extra){
    return {
        'BTC':    { TICK_ID: 20, DECIMALS: 0, SUPPLY: '0',
                    OWNER: SETTLE.ROLE_ADDRESSES.BRIDGE_BTC },
        'BTC.FUFU': Object.assign({ TICK_ID: 21, DECIMALS: 4, SUPPLY: '5.0000',
                                    OWNER: SETTLE.ROLE_ADDRESSES.BRIDGE_BTC,
                                    ALLOW_LIST: null, BLOCK_LIST: null }, extra || {})
    };
}

function sha256(s){ return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function snapshot(identities, fields){
    const row = HUB.buildPolicyRow(Object.assign({
        snapshotBlock: SNAPSHOT, originChain: 'BTC', tick: TICK, policySeq: 1,
        originBlock: ORIGIN_BLK, effectiveTime: DUE_TIME, network: NETWORK
    }, fields || {}));
    return HUB.signRecord(row, identities);
}

// The injected legs, as the drill reads them back: [ordinal, action, ...fields].
function legs(state){
    return state.injected.map(t => ({ ordinal: t.vout, fields: t.data.split('|'),
                                      source: t.source, isGenesis: t.isGenesis,
                                      tx_hash: t.tx_hash }));
}

function makeFixture(){
    const ids = HUB.makeIdentities(3);
    return { ids: ids, validators: HUB.capabilitySet(ids) };
}

module.exports = {
    HUB, SETTLE, BS, startDisposableHubDb, seedWeightSnapshot, MultiValidatorHub,
    BridgePendingSource, waitForMesh, waitFor,
    NETWORK, SNAPSHOT, ORIGIN_BLK, BLOCK, BLOCK_TIME, DUE_TIME, TICK, COPY,
    MEMBER_A, MEMBER_B, MEMBER_C, copyRow, sha256, snapshot, legs, makeFixture
};
