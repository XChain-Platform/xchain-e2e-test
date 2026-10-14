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

// Covers the federation client and the pending read it polls. One part of bridgeTransferE2E.integration.test.

const assert = require('assert');
const {
    HUB, BS, BridgePendingSource, NETWORK, SNAPSHOT, DEST_ADDR, SRC_ADDR, inLeg, makeFixture
} = require('./lib/shared');

function pendingFixture(){
    return {
        network: NETWORK, latestBlockIndex: SNAPSHOT,
        transfersByCoin: {
            BTC: [ BridgePendingSource.makeLeg({
                transfer_kind: 'lock', src_chain: 'BTC', src_action_index: 4242,
                src_address: SRC_ADDR, dest_chain: 'DOGE', dest_address: DEST_ADDR,
                tick: 'XCHAIN', decimals: 8, amount: '10.00000000',
                min_depth: 0, block_index: SNAPSHOT - 50
            }) ]
        },
        policiesByCoin: { BTC: { FUFU: {
            allow_list: null, block_list: null, sleeping: false,
            policy_hash: BS.policyHash(null, null, false), bridged: true
        } } }
    };
}

async function startSource(){
    const source = new BridgePendingSource();
    await source.start();
    source.setPending('shared', pendingFixture());
    return source;
}

describe('XBRIDGE transfer: the federation client and the pending read it polls', function(){
    this.timeout(240_000);

    let ids;

    before(function(){
        ({ ids } = makeFixture());
    });

    // These drive the REAL engine client (CrossChainBridgeEngine.indexerCall,
    // recordPending, effectiveDepth) over real HTTP against the pending source, with
    // no hub, no database and no mesh. Without them the federated block below would be
    // the only thing standing between a mock that drifted from api.js and a round that
    // is silently vacuous on every venue that can run it.

    let source;

    before(async function(){
        source = await startSource();
    });

    after(async function(){ if(source) await source.stop(); });

    it('answers getpendingbridgetransfers in the shape the engine parses', async function(){
        const eng = HUB.hubEngine();
        eng.indexers = { BTC: { url: source.urlFor('shared', 'BTC'), key: '' } };

        const res = await eng.indexerCall('BTC', 'getpendingbridgetransfers', { limit: 100 });

        assert.strictEqual(res.network, NETWORK, 'the engine reads no network and would drop the page');
        assert.strictEqual(Number(res.latest_block_index), SNAPSHOT);
        assert.ok(Array.isArray(res.transfers) && res.transfers.length === 1);
        const leg = res.transfers[0];
        // Identity of the leg, field by field: these are exactly the fields a follower
        // compares against a leader's proposed row before it will co-sign.
        assert.strictEqual(leg.transfer_kind, 'lock');
        assert.strictEqual(leg.src_address, SRC_ADDR);
        assert.strictEqual(leg.dest_chain, 'DOGE');
        assert.strictEqual(leg.dest_address, DEST_ADDR);
        assert.strictEqual(leg.tick, 'XCHAIN');
        assert.strictEqual(leg.decimals, 8);
        assert.strictEqual(leg.amount, '10.00000000');

        // And the leg resolves to the id the hub would finalize for it, which is what
        // ties this read to the record the drills above apply.
        const derived = eng.deriveTransferId(res.network, 'BTC', leg.src_action_index,
                                              leg.dest_chain, leg.dest_address);
        assert.strictEqual(derived, inLeg(ids).transfer_id,
            'a leg served here derives a different transfer_id than the record under test');
    });

    it('a MIN_DEPTH raises the confirmation wait and can never lower it (token AT5)', function(){
        const eng = HUB.hubEngine();
        // The platform depths the base spec names, as coins.resolveConfirmations gives
        // them to the engine.
        eng.confirmations = { BTC: 6, LTC: 12, DOGE: 60 };

        assert.strictEqual(eng.effectiveDepth('BTC', 0), 6, 'an unset MIN_DEPTH moved the platform depth');
        assert.strictEqual(eng.effectiveDepth('BTC', 3), 6,
            'a MIN_DEPTH below the platform depth LOWERED the wait, which an issuer must never be able to do');
        assert.strictEqual(eng.effectiveDepth('BTC', 12), 12, 'a MIN_DEPTH above the platform depth did not raise it');
        assert.strictEqual(eng.effectiveDepth('DOGE', 3), 60, 'the DOGE platform depth was lowered');
        assert.strictEqual(eng.effectiveDepth('BTC', 'nonsense'), 6, 'a junk MIN_DEPTH did not fall back to the platform depth');
    });

    it('serves the origin policy read, and answers an unknown tick with an error the engine abstains on', async function(){
        const eng = HUB.hubEngine();
        eng.indexers = { BTC: { url: source.urlFor('shared', 'BTC'), key: '' } };

        const known = await eng.indexerCall('BTC', 'gettokenpolicy', { tick: 'FUFU', origin_block: 1150 });
        assert.strictEqual(known.policy_hash, BS.policyHash(null, null, false));
        assert.strictEqual(known.origin_block, 1150, 'the read did not answer at the block it was asked for');
        assert.strictEqual(known.sleeping, false);

        const unknown = await eng.indexerCall('BTC', 'gettokenpolicy', { tick: 'NOSUCH', origin_block: 1150 });
        assert.ok(unknown && unknown.error,
            'a tick with no native row answered without an error, so the engine would sign a phantom policy');

        const tip = await eng.indexerCall('BTC', 'getlatestblock', {});
        assert.strictEqual(Number(tip.block_index), SNAPSHOT,
            'the tip read does not answer block_index, so policyOriginBlock would abstain forever');
    });
});
