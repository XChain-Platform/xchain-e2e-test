/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Anchor-reward re-derivation (#5311): cross-service XANCPUB parity.
 *
 * At/above the ANCHOR_REWARD flag-day the validator anchor reward is no longer
 * pushed by the hub but DERIVED by every indexer from the on-chain ANCHOR v4/v5
 * publisher attestation. The attested canonical (XANCPUB) is built INLINE in two
 * services (the hub producer StateAnchorPublisher._attestationCanonical and the
 * indexer verifier actions/anchor.js _rewardCanonical), and the flag-day map plus
 * the frozen reward amount live as LOCAL COPIES in both services AND the canonical
 * xchain-documentation/protocol/constants.js. A single byte of drift between any
 * two of these silently FORKS the derived validator_rewards row (a COLLECT-spendable
 * ledger entry), so this guards:
 *
 *   1. ANCHOR_REWARD_ACTIVATION + ANCHOR_REWARD_AMOUNT are byte-equal across the hub
 *      and indexer twins AND the canonical protocol constant.
 *   2. Both local isAnchorRewardActive agree on the verdict for the same input.
 *   3. The post-flag-day XANCPUB canonical (EQUIV-wrapped) is byte-identical between
 *      the hub producer and the indexer verifier, carries the frozen amount, and
 *      matches the documented wire string.
 *   4. The pre-flag-day XANCPUB canonical (header-less, EQUIV dormant) is likewise
 *      byte-identical and carries no EQUIV prefix.
 *
 * Because each builder is invoked through its OWN service's equivocation_header +
 * anchor_reward_activation copies, this also catches drift in either of those.
 *
 * Spec: xchain-documentation/protocol/actions/ANCHOR.md (Publisher-attestation
 * canonical); claude/reports/2026-06-24-anchor-reward-rederivation-handover.md.
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const protocolConstants = require(path.join(ROOT, 'xchain-documentation/protocol/constants.js'));
const hubAr = require(path.join(ROOT, 'xchain-hub/src/anchor_reward_activation.js'));
const idxAr = require(path.join(ROOT, 'xchain-indexer/src/anchor_reward_activation.js'));

const StateAnchorPublisher = require(path.join(ROOT, 'xchain-hub/src/StateAnchorPublisher.js'));
const Anchor               = require(path.join(ROOT, 'xchain-indexer/src/actions/anchor.js'));

// Both canonical builders read only their argument (no `this`), so invoke them
// directly off the prototype, each through its own service's eq + ar copies.
function hubXancpub(cp, publisher) {
    return StateAnchorPublisher.prototype._attestationCanonical.call({}, cp, publisher);
}
function idxXancpub(d) {
    return Anchor.prototype._rewardCanonical.call({}, d);
}

// One logical reward attestation in BOTH the hub `cp` shape and the indexer wire-parse
// `d` shape, so a single fixture drives both builders.
function fixtures(net, snapshotBlock) {
    const PUBLISHER = '07'.repeat(32);
    const cp = { chain: 'BTC', network: net, checkpoint_seq: 7, snapshot_block: snapshotBlock };
    const d  = { CHAIN: 'BTC', NETWORK: net, CHECKPOINT_SEQ: 7, SNAPSHOT_BLOCK: snapshotBlock, PUBLISHER };
    return { cp, d, PUBLISHER };
}

describe('#5311: ANCHOR_REWARD (XANCPUB) cross-service parity', function () {

    it('the flag-day map + frozen amount are byte-equal across the twins and the canonical SoT', function () {
        const map = protocolConstants.ANCHOR_REWARD_ACTIVATION;
        const amt = protocolConstants.ANCHOR_REWARD_AMOUNT;
        assert.ok(map, 'documentation/protocol/constants.js must export ANCHOR_REWARD_ACTIVATION');
        assert.ok(amt, 'documentation/protocol/constants.js must export ANCHOR_REWARD_AMOUNT');
        for (const [name, mod] of [['hub', hubAr], ['indexer', idxAr]]) {
            assert.deepStrictEqual(mod.ANCHOR_REWARD_ACTIVATION, map,
                name + ' ANCHOR_REWARD_ACTIVATION drifted from the canonical protocol constant');
            assert.strictEqual(mod.ANCHOR_REWARD_AMOUNT, amt,
                name + ' ANCHOR_REWARD_AMOUNT drifted from the canonical protocol constant');
        }
    });

    it('every local isAnchorRewardActive agrees on the verdict for the same input', function () {
        for (const net of ['mainnet', 'testnet', 'regtest', 'unknownnet']) {
            for (const sb of [0, 100, 1000, 999999998, 999999999, 1000000000]) {
                const verdicts = [hubAr, idxAr].map(m => m.isAnchorRewardActive(sb, net));
                assert.ok(verdicts.every(v => v === verdicts[0]),
                    'gate verdict disagreement for ' + net + '@' + sb + ': ' + JSON.stringify(verdicts));
            }
        }
    });

    it('post-flag-day: hub == indexer XANCPUB canonical (EQUIV-wrapped, frozen amount)', function () {
        // regtest flag-day is 0, so snapshot_block 100 is active and the EQUIV header applies.
        const { cp, d, PUBLISHER } = fixtures('regtest', 100);
        const hubC = hubXancpub(cp, PUBLISHER);
        const idxC = idxXancpub(d);
        assert.strictEqual(hubC, idxC, 'hub vs indexer XANCPUB canonical drift');
        // Matches the documented wire string (ANCHOR.md Publisher-attestation canonical).
        assert.strictEqual(hubC,
            'EQUIV|XCHECKPOINT|XANCPUB|BTC|regtest|7|100|0||XANCPUB|anchor_BTC|7|100|' +
            PUBLISHER + '|' + protocolConstants.ANCHOR_REWARD_AMOUNT,
            'XANCPUB canonical drifted from the documented format');
        assert.ok(hubC.endsWith('|' + protocolConstants.ANCHOR_REWARD_AMOUNT),
            'canonical must end with the frozen reward amount');
    });

    it('pre-flag-day: hub == indexer XANCPUB canonical (header-less, EQUIV dormant)', function () {
        // mainnet flag-day is the far-future placeholder, so snapshot_block 1000 is inactive
        // and the EQUIV header is dormant: the bare XANCPUB string.
        const { cp, d, PUBLISHER } = fixtures('mainnet', 1000);
        const hubC = hubXancpub(cp, PUBLISHER);
        const idxC = idxXancpub(d);
        assert.strictEqual(hubC, idxC, 'hub vs indexer pre-flag-day XANCPUB canonical drift');
        assert.strictEqual(hubC,
            'XANCPUB|anchor_BTC|7|1000|' + PUBLISHER + '|' + protocolConstants.ANCHOR_REWARD_AMOUNT,
            'pre-flag-day canonical must be the bare XANCPUB string');
        assert.ok(!hubC.startsWith('EQUIV|'), 'pre-flag-day canonical must carry no EQUIV prefix');
    });
});
