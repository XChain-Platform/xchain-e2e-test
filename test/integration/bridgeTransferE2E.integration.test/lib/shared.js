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

// Fixtures shared by the parts of bridgeTransferE2E.integration.test.

const dotenv = require('dotenv');
dotenv.config();

const crypto = require('crypto');

const HUB = require('../../../helpers/bridgeHubRecord');
const SETTLE = require('../../../helpers/bridgeSettleContext');
const { startDisposableHubDb } = require('../../../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../../../helpers/seededWeightSnapshot');
const { MultiValidatorHub }    = require('../../../helpers/multiValidatorHubHelper');
const { BridgePendingSource }  = require('../../../helpers/bridgePendingSource');
const { waitForMesh, waitFor } = require('../../../helpers/consensusWait');

const BS = SETTLE.bridgeSettle;

const NETWORK   = 'regtest';
const SNAPSHOT  = 1200;
const CP_HEIGHT = 1205;          // a checkpoint at or after SNAPSHOT, as the check demands
const BLOCK     = 900;
const BLOCK_TIME = 2000;
const DUE_TIME  = 1000;          // effective_time at or below BLOCK_TIME, so the row is due
const DEST_ADDR = 'nDestinationAddressXXXXXXXXXXXXXXX';
const BTC_ADDR  = 'mReturnAddressXXXXXXXXXXXXXXXXXXXX';
const SRC_ADDR  = 'mSourceAddressXXXXXXXXXXXXXXXXXXXX';

// The XCHAIN row as an already-seeded destination holds it. TICK_ID 7 is what the escrow
// balance below is keyed on, exactly as a real balances read is keyed.
const XCHAIN_ROW = { XCHAIN: { TICK_ID: 7, DECIMALS: 8, SUPPLY: '0' } };

function sha256(s){ return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// A signed, finalized in-leg record: a BTC lock of `amount` crediting DEST_ADDR on DOGE.
function inLeg(identities, overrides){
    const row = HUB.buildTransferRow(Object.assign({
        snapshotBlock: SNAPSHOT, srcChain: 'BTC', srcActionIndex: 4242, srcAddress: SRC_ADDR,
        destChain: 'DOGE', destAddress: DEST_ADDR, tick: 'XCHAIN', decimals: 8,
        amount: '10.00000000', effectiveTime: DUE_TIME, network: NETWORK
    }, overrides || {}));
    return HUB.signRecord(row, identities);
}

// A signed, finalized out-leg record: a DOGE burn releasing BTC escrow to BTC_ADDR.
function outLeg(identities, overrides){
    const row = HUB.buildTransferRow(Object.assign({
        snapshotBlock: SNAPSHOT, srcChain: 'DOGE', srcActionIndex: 777, srcAddress: DEST_ADDR,
        destChain: 'BTC', destAddress: BTC_ADDR, tick: 'XCHAIN', decimals: 8,
        amount: '2.00000000', effectiveTime: DUE_TIME, network: NETWORK
    }, overrides || {}));
    return HUB.signRecord(row, identities);
}

function makeFixture(){
    const ids = HUB.makeIdentities(3);
    return { ids: ids, validators: HUB.capabilitySet(ids) };
}

module.exports = {
    HUB, SETTLE, BS, startDisposableHubDb, seedWeightSnapshot, MultiValidatorHub,
    BridgePendingSource, waitForMesh, waitFor,
    NETWORK, SNAPSHOT, CP_HEIGHT, BLOCK, BLOCK_TIME, DUE_TIME, DEST_ADDR, BTC_ADDR, SRC_ADDR,
    XCHAIN_ROW, sha256, inLeg, outLeg, makeFixture
};
