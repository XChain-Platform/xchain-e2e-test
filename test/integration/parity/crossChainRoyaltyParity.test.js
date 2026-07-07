/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Cross-chain royalty (finding B) cross-service parity.
 *
 * The CROSS_CHAIN_ROYALTY flag-day gates whether the validator-signed XMATCH
 * canonical carries the matched orders' royalty payout legs. FOUR builders must
 * stay byte-identical or the federation forks on the first royalty-bearing match:
 *   hub CrossChainDexEngine._canonicalMatch   (live signing)
 *   hub StateAnchorPublisher._matchCanonical  (archive verification)
 *   indexer cross_settle._canonical           (settlement verification)
 *   indexer recovery._matchCanonical          (full-parse recovery)
 * The activation gate itself is a 2-repo twin module (like anchor_reward_activation)
 * whose map is registered in the canonical xchain-documentation/protocol/constants.js;
 * this suite pins twin byte-identity, map equality against the canonical SoT, verdict
 * agreement, and canonical parity with legs present, legs absent, and below the
 * flag-day (legacy bytes, regression-safe).
 *
 * Design: claude/reports/2026-07-07_cross-chain-royalty-design.md
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const protocolConstants = require(path.join(ROOT, 'xchain-documentation/protocol/constants.js'));
const hubCcr = require(path.join(ROOT, 'xchain-hub/src/cross_chain_royalty_activation.js'));
const idxCcr = require(path.join(ROOT, 'xchain-indexer/src/cross_chain_royalty_activation.js'));

const CrossChainDexEngine  = require(path.join(ROOT, 'xchain-hub/src/CrossChainDexEngine.js'));
const StateAnchorPublisher = require(path.join(ROOT, 'xchain-hub/src/StateAnchorPublisher.js'));
const Cross_Settle         = require(path.join(ROOT, 'xchain-indexer/src/actions/cross_settle.js'));
const AnchorRecovery       = require(path.join(ROOT, 'xchain-indexer/src/recovery.js'));

// All four builders read only their argument (no `this`), so invoke them directly
// off the prototype, each through its own service's eq + ccr copies. The engine's
// live path signs at pending.view; the other three at the persisted finalizing_view.
function canonicals(m) {
    return {
        hubEngine:   CrossChainDexEngine.prototype._canonicalMatch.call({}, m, m.finalizing_view || 0),
        hubArchive:  StateAnchorPublisher.prototype._matchCanonical.call({}, m),
        idxSettle:   Cross_Settle.prototype._canonical.call({}, m),
        idxRecovery: AnchorRecovery.prototype._matchCanonical.call({}, m),
    };
}

function matchRow(net, snapshotBlock, overrides) {
    return Object.assign({
        match_id: 'abc', snapshot_block: snapshotBlock, network: net,
        a_chain: 'BTC', a_action_index: 7, a_kind: 'order', a_tick: 'TOKA', a_amount: '20',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Laddr', a_payout_legs: null,
        b_chain: 'LTC', b_action_index: 1, b_kind: 'order', b_tick: 'TOKB', b_amount: '40',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Daddr', b_payout_legs: null,
        effective_time: 1700000000, finalizing_view: 0
    }, overrides || {});
}

const LEGS = JSON.stringify([{ to: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM', bps: 500 }]);

describe('cross-chain royalty: CROSS_CHAIN_ROYALTY cross-service parity', function () {

    it('the twin activation modules are byte-identical', function () {
        const hub = fs.readFileSync(path.join(ROOT, 'xchain-hub/src/cross_chain_royalty_activation.js'), 'utf8');
        const idx = fs.readFileSync(path.join(ROOT, 'xchain-indexer/src/cross_chain_royalty_activation.js'), 'utf8');
        assert.strictEqual(hub, idx,
            'cross_chain_royalty_activation.js drifted between hub and indexer; re-copy the twin');
    });

    it('the flag-day map is byte-equal across the twins and the canonical SoT', function () {
        const map = protocolConstants.CROSS_CHAIN_ROYALTY_ACTIVATION;
        assert.ok(map, 'documentation/protocol/constants.js must export CROSS_CHAIN_ROYALTY_ACTIVATION');
        for (const [name, mod] of [['hub', hubCcr], ['indexer', idxCcr]]) {
            assert.deepStrictEqual(mod.CROSS_CHAIN_ROYALTY_ACTIVATION, map,
                name + ' CROSS_CHAIN_ROYALTY_ACTIVATION drifted from the canonical protocol constant');
        }
    });

    it('every local isCrossChainRoyaltyActive agrees on the verdict for the same input', function () {
        for (const net of ['mainnet', 'testnet', 'regtest', 'unknownnet']) {
            for (const sb of [0, 100, 1000, 999999998, 999999999, 1000000000, NaN, null]) {
                const verdicts = [hubCcr, idxCcr].map(m => m.isCrossChainRoyaltyActive(sb, net));
                assert.ok(verdicts.every(v => v === verdicts[0]),
                    'gate verdict disagreement for ' + net + '@' + sb + ': ' + JSON.stringify(verdicts));
            }
        }
    });

    it('post-flag-day, NO legs: all four builders append the two empty leg fields identically', function () {
        const m = matchRow('regtest', 100);
        const c = canonicals(m);
        const all = Object.values(c);
        assert.ok(all.every(v => v === all[0]), 'canonical drift: ' + JSON.stringify(c, null, 2));
        // Content tail: two empty leg fields after the fill fields (before any EQUIV wrap).
        assert.ok(all[0].endsWith('|order|0|order|0||'), 'expected trailing empty leg fields: ' + all[0]);
    });

    it('post-flag-day, WITH legs: all four builders sign the same legs-bearing bytes', function () {
        const m = matchRow('regtest', 100, { a_payout_legs: LEGS });
        const c = canonicals(m);
        const all = Object.values(c);
        assert.ok(all.every(v => v === all[0]), 'canonical drift: ' + JSON.stringify(c, null, 2));
        assert.ok(all[0].endsWith('|' + LEGS + '|'), 'legs must be inside the signed bytes: ' + all[0]);
        // Stripping the legs MUST change the bytes (the anti-hub-collusion property).
        const stripped = canonicals(matchRow('regtest', 100));
        assert.notStrictEqual(all[0], stripped.hubEngine);
    });

    it('below the flag-day (mainnet placeholder): the canonical is byte-identical to the legacy format', function () {
        const m = matchRow('mainnet', 1000, { a_payout_legs: LEGS });   // legs present but NOT signable yet
        const c = canonicals(m);
        const all = Object.values(c);
        assert.ok(all.every(v => v === all[0]), 'canonical drift: ' + JSON.stringify(c, null, 2));
        assert.strictEqual(all[0],
            'XMATCH|abc|1000|BTC|7|TOKA|20|0|Laddr|LTC|1|TOKB|40|0|Daddr|1700000000|mainnet|order|0|order|0',
            'pre-flag mainnet canonical must be the frozen legacy format (no legs, no EQUIV)');
    });
});
