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

// Covers the hub and indexer byte-match seam. One part of bridgeTransferE2E.integration.test.

const assert = require('assert');
const {
    HUB, SETTLE, BS, NETWORK, SNAPSHOT, DUE_TIME, DEST_ADDR, SRC_ADDR, sha256, inLeg, makeFixture
} = require('./lib/shared');

describe('XBRIDGE transfer: the cross-repository seam', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('derives the transfer_id the base spec names, from the spec preimage', function(){
        const row = inLeg(ids);
        // The preimage is written out here rather than read back from the hub helper:
        // asserting the engine's id against the engine's own derivation would pass
        // however the preimage was rewritten, which is the one thing that must not move.
        // No snapshot_block in the preimage: the id names the LEG, so every hub in the
        // federation opens one round for it whatever tip its own poll read.
        const expected = sha256([
            'XBRIDGE',
            NETWORK,
            'BTC:4242',
            'DOGE:' + DEST_ADDR
        ].join('|'));
        assert.strictEqual(row.transfer_id, expected,
            'the hub derives a transfer_id the base spec preimage does not produce');
    });

    it('signs the canonical the indexer rebuilds, byte for byte', function(){
        const row = inLeg(ids);
        const hubSide     = HUB.hubCanonical(row);
        const indexerSide = BS.transferCanonical(row);
        assert.strictEqual(indexerSide, hubSide,
            'hub CrossChainBridgeEngine.canonicalMatch and indexer transferCanonical disagree');
        // Both halves of the wrap are pinned: the EQUIV header (which carries the
        // finalizing view, so a view change is not equivocation) and the content order.
        assert.ok(hubSide.startsWith('EQUIV|XBRIDGE|' + row.transfer_id + '|0||'),
            'the EQUIV header is not the one the settle pass expects: ' + hubSide.slice(0, 90));
        assert.ok(hubSide.endsWith([
            'XBRIDGE', row.transfer_id, String(SNAPSHOT), 'XCHAIN', '8',
            'BTC', '4242', SRC_ADDR, 'DOGE', DEST_ADDR, '10.00000000',
            String(DUE_TIME), NETWORK
        ].join('|')), 'the signed content is not the spec field order');
    });

    it('a bundle the hub signed meets the indexer quorum rule, and one over other bytes does not', async function(){
        const row = inLeg(ids);
        const { ctx } = SETTLE.makeSettleContext({ coin: 'DOGE', validators: validators });

        const good = await BS.verifyQuorum(BS.transferCanonical(row), row.validator_signatures,
                                           SNAPSHOT, NETWORK, ctx.indexerDb);
        assert.strictEqual(good.met, true, 'the indexer refused a full hub-signed set');
        assert.strictEqual(good.valid, 3, 'expected all 3 hub signatures to verify, got ' + good.valid);

        // Cryptographically VALID signatures by the same qualified validators, over a
        // canonical that differs in one signed field. A bit-flip could be dismissed as
        // transport damage; this is the forgery the canonical exists to stop.
        const forged = HUB.signRecord(Object.assign({}, row), ids, {
            message: HUB.hubCanonical(Object.assign({}, row, { amount: '10.00000001' }))
        });
        const bad = await BS.verifyQuorum(BS.transferCanonical(row), forged.validator_signatures,
                                          SNAPSHOT, NETWORK, ctx.indexerDb);
        assert.strictEqual(bad.valid, 0, 'a signature over a different amount verified');
        assert.strictEqual(bad.met, false, 'quorum was met by signatures over other bytes');
    });
});
