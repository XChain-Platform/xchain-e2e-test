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

// Covers the hub and indexer byte-match seam. One part of bridgePolicyE2E.integration.test.

const assert = require('assert');
const { HUB, BS, NETWORK, SNAPSHOT, ORIGIN_BLK, BLOCK, DUE_TIME, TICK, MEMBER_A, MEMBER_B, MEMBER_C, sha256, snapshot, makeFixture } = require('./lib/shared');

describe('XPOLICY: the cross-repository seam', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ({ ids, validators } = makeFixture());
    });

    it('derives the snapshot_id the policy spec names, from the spec preimage', function(){
        const row = snapshot(ids, { block: [MEMBER_A] });
        const expected = sha256([NETWORK, 'BTC:' + TICK, '1', String(SNAPSHOT)].join('|'));
        assert.strictEqual(row.snapshot_id, expected,
            'the hub derives a snapshot_id the policy spec preimage does not produce');
    });

    it('hashes membership to the same policy_hash the indexer recomputes', function(){
        const row = snapshot(ids, { allow: [MEMBER_A, MEMBER_B], block: [MEMBER_C], sleeping: true });
        const indexerSide = BS.policyHash([MEMBER_A, MEMBER_B], [MEMBER_C], true);
        assert.strictEqual(row.policy_hash, indexerSide,
            'hub policyHash and indexer policyHash disagree over the same membership');
        // The canonical membership text itself, so the hash is pinned to the spec's
        // wording and not merely to whatever both sides happen to compute today.
        const expected = sha256(['ALLOW', '2', MEMBER_A, MEMBER_B,
                                 'BLOCK', '1', MEMBER_C, 'SLEEP', '1'].join('|'));
        assert.strictEqual(row.policy_hash, expected, 'the membership canonical is not the spec text');
    });

    it('distinguishes an ABSENT list from an EMPTY one', function(){
        // Absent is no gate; empty is deny-everyone under isActionAllowed. A hash that
        // conflated them would let a copy enforce the opposite of the origin's policy.
        const absent = BS.policyHash(null, null, false);
        const empty  = BS.policyHash([],   [],   false);
        assert.notStrictEqual(absent, empty, 'an absent list hashes the same as an empty one');
        assert.strictEqual(absent, HUB.hubEngine().policyHash(null, null, false));
        assert.strictEqual(empty,  HUB.hubEngine().policyHash([],   [],   false));
    });

    it('signs the canonical the indexer rebuilds, byte for byte', function(){
        const row = snapshot(ids, { block: [MEMBER_A] });
        const hubSide     = HUB.hubCanonical(row);
        const indexerSide = BS.policyCanonical(row);
        assert.strictEqual(indexerSide, hubSide,
            'hub canonicalMatch (policy branch) and indexer policyCanonical disagree');
        assert.ok(hubSide.startsWith('EQUIV|XPOLICY|' + row.snapshot_id + '|0||'),
            'the EQUIV header is not the one the settle pass expects: ' + hubSide.slice(0, 90));
        assert.ok(hubSide.endsWith([
            'XPOLICY', row.snapshot_id, String(SNAPSHOT), 'BTC', TICK, '1',
            String(ORIGIN_BLK), row.policy_hash, String(DUE_TIME), NETWORK
        ].join('|')), 'the signed content is not the spec field order');
        // `sleeping` is committed through policy_hash ALONE (D17). A second commitment
        // in the canonical would be a divergent one the moment either side changed.
        assert.ok(hubSide.indexOf('|SLEEP|') === -1, 'sleeping leaked into the signed canonical');
    });
});
