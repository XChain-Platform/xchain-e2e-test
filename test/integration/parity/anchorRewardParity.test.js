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
 * Anchor-reward re-derivation: cross-service XANCPUB parity.
 *
 * The validator anchor reward is not pushed by the hub but DERIVED from the
 * on-chain publisher attestation. The checkpoint leg carries ONE attestation per
 * ANCHOR v7 bundle: reward type `anchor_bundle`, round_reference SNAPSHOT_BLOCK,
 * the frozen ANCHOR_REWARD_AMOUNT. The attested canonical (XANCPUB) is built
 * INLINE in two services (the hub producer StateAnchorPublisher._attestationCanonical
 * and the indexer verifier actions/anchor.js _rewardCanonical), and the flag-day map
 * plus the frozen reward amount live as LOCAL COPIES in both services AND the
 * canonical xchain-documentation/protocol/constants.js. A single byte of drift
 * between any two of these silently FORKS the derived validator_rewards row (a
 * COLLECT-spendable ledger entry), so this guards:
 *
 *   1. ANCHOR_REWARD_ACTIVATION + ANCHOR_REWARD_AMOUNT are byte-equal across the hub
 *      and indexer twins AND the canonical protocol constant.
 *   2. Both local isAnchorRewardActive agree on the verdict for the same input.
 *   3. The bundle XANCPUB canonical is byte-identical between the hub producer and
 *      the indexer verifier where the EQUIV header is armed, carries the frozen
 *      amount, and matches the documented wire string.
 *   4. The same canonical is byte-identical where the EQUIV header is dormant, and
 *      carries no EQUIV prefix there.
 *
 * The canonical keeps SIX positional fields so slash.js reads snapshot_block at
 * field index 3 for every XANCPUB family without a third branch; field 2 is
 * round_reference, which for a bundle IS the snapshot block, hence the repeat.
 *
 * Because each builder is invoked through its OWN service's equivocation_header +
 * anchor_reward_activation copies, this also catches drift in either of those.
 *
 * Spec: xchain-documentation/protocol/actions/anchor.md (Publisher-attestation
 * canonical); anchor-bundle-per-network.md 2.5, D21-D23.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const protocolConstants = require(path.join(ROOT, 'xchain-documentation/protocol/constants.js'));
const hubAr = require(path.join(ROOT, 'xchain-hub/src/anchor_reward_activation.js'));
const idxAr = require(path.join(ROOT, 'xchain-indexer/src/anchor_reward_activation.js'));

const StateAnchorPublisher = require(path.join(ROOT, 'xchain-hub/src/StateAnchorPublisher.js'));
const Anchor               = require(path.join(ROOT, 'xchain-indexer/src/actions/anchor.js'));

// Both canonical builders read only their argument (no `this`), so invoke them
// directly off the prototype, each through its own service's eq + ar copies.
function hubXancpub(b, publisher) {
    return StateAnchorPublisher.prototype._attestationCanonical.call({}, b, publisher);
}
function idxXancpub(d) {
    return Anchor.prototype._rewardCanonical.call({}, d);
}

// One logical bundle attestation in BOTH the hub `b` shape (the bundle header the
// publisher attests) and the indexer wire-parse `d` shape, so a single fixture drives
// both builders. A bundle attestation names no chain: the reward is one per bundle.
function fixtures(net, snapshotBlock) {
    const PUBLISHER = '07'.repeat(32);
    const b = { network: net, snapshot_block: snapshotBlock };
    const d = { FORMAT: 0, NETWORK: net, SNAPSHOT_BLOCK: snapshotBlock, PUBLISHER };
    return { b, d, PUBLISHER };
}

describe('ANCHOR_REWARD (XANCPUB) cross-service parity', function () {

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

    it('anchor_reward_activation.js executable code is byte-identical between the hub and indexer twins', function () {
        // This file's own header claims "Byte-identical twin lives in ..." but nothing
        // enforced it (uuid:38212dff); anchorRewardParity.test.js has no readFileSync at
        // all today. The map + amount + verdict + canonical checks in this suite are a
        // real net, but they don't catch a change that preserves those while altering
        // unprobed code.
        //
        // Each copy's header comment names the OTHER repo reciprocally, so the header
        // itself is not byte-identical across copies by construction; compare the
        // executable region only (from the activation map down), same convention as
        // equivGateInputParity.test.js's codeOnly() helper.
        const codeOnly = (s) => s.slice(s.indexOf('const ANCHOR_REWARD_ACTIVATION'));
        const hubCode = codeOnly(fs.readFileSync(path.join(ROOT, 'xchain-hub/src/anchor_reward_activation.js'), 'utf8'));
        const idxCode = codeOnly(fs.readFileSync(path.join(ROOT, 'xchain-indexer/src/anchor_reward_activation.js'), 'utf8'));
        assert.strictEqual(hubCode, idxCode,
            'hub/anchor_reward_activation.js executable code drifted from the indexer copy');
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

    it('EQUIV armed: hub == indexer bundle XANCPUB canonical (EQUIV-wrapped, frozen amount)', function () {
        // regtest arms the EQUIV header at 0, so snapshot_block 100 takes the wrapped leg.
        const { b, d, PUBLISHER } = fixtures('regtest', 100);
        const hubC = hubXancpub(b, PUBLISHER);
        const idxC = idxXancpub(d);
        assert.strictEqual(hubC, idxC, 'hub vs indexer bundle XANCPUB canonical drift');
        // Matches the documented wire string (anchor.md Publisher-attestation canonical).
        // The round id is the bundle family 'XANCPUB|bundle|NETWORK|SNAPSHOT_BLOCK'; the
        // base repeats SNAPSHOT_BLOCK because field 2 is round_reference.
        assert.strictEqual(hubC,
            'EQUIV|XCHECKPOINT|XANCPUB|bundle|regtest|100|0||XANCPUB|anchor_bundle|100|100|' +
            PUBLISHER + '|' + protocolConstants.ANCHOR_REWARD_AMOUNT,
            'bundle XANCPUB canonical drifted from the documented format');
        assert.ok(hubC.endsWith('|' + protocolConstants.ANCHOR_REWARD_AMOUNT),
            'canonical must end with the frozen reward amount');
    });

    it('the bundle XANCPUB canonical keeps six positional fields so slash.js finds snapshot_block', function () {
        // slash.js reads snapshot_block at field index 3 of the base for EVERY XANCPUB
        // family. A five-field bundle base would make every bundle equivocation report
        // 'invalid: snapshot_block' instead of judging it (D22), so the count and the
        // position of that field are both consensus surface.
        const { b, PUBLISHER } = fixtures('regtest', 100);
        const base = hubXancpub(b, PUBLISHER).split('||')[1].split('|');
        assert.strictEqual(base.length, 6, 'bundle XANCPUB base must carry six positional fields');
        assert.strictEqual(base[1], 'anchor_bundle', 'field 1 is the reward type');
        assert.strictEqual(base[2], '100', 'field 2 is round_reference, the snapshot block for a bundle');
        assert.strictEqual(base[3], '100', 'field 3 is snapshot_block, the index slash.js reads');
    });

    it('EQUIV dormant: hub == indexer bundle XANCPUB canonical (header-less)', function () {
        // mainnet arms the EQUIV header far above 1000, so this block takes the dormant
        // leg: the bare XANCPUB string with no wrapper. Both services must agree there
        // too, or a bundle attested below an armed height forks the derived reward.
        const { b, d, PUBLISHER } = fixtures('mainnet', 1000);
        const hubC = hubXancpub(b, PUBLISHER);
        const idxC = idxXancpub(d);
        assert.strictEqual(hubC, idxC, 'hub vs indexer EQUIV-dormant bundle XANCPUB canonical drift');
        assert.strictEqual(hubC,
            'XANCPUB|anchor_bundle|1000|1000|' + PUBLISHER + '|' + protocolConstants.ANCHOR_REWARD_AMOUNT,
            'EQUIV-dormant canonical must be the bare XANCPUB string');
        assert.ok(!hubC.startsWith('EQUIV|'), 'EQUIV-dormant canonical must carry no EQUIV prefix');
    });
});

// The ARCHIVE leg of the same contract. The archive XANCPUB canonical is built
// inline in the hub producer (_archiveAttestationCanonical) and the indexer verifier
// (_rewardCanonical, FORMAT 6); the ARCHIVE_REWARD map + frozen amount live in the same
// twin modules + the canonical SoT. Same fork argument, same guards.
describe('ARCHIVE_REWARD (archive XANCPUB) cross-service parity', function () {

    function hubArchXancpub(cp, batchSeq, publisher) {
        return StateAnchorPublisher.prototype._archiveAttestationCanonical.call({}, cp, batchSeq, publisher);
    }
    function archiveFixtures(net, snapshotBlock) {
        const PUBLISHER = '07'.repeat(32);
        const cp = { chain: 'BTC', network: net, checkpoint_seq: 7, snapshot_block: snapshotBlock };
        const d  = { FORMAT: 1, CHAIN: 'BTC', NETWORK: net, CHECKPOINT_SEQ: 7,
                     SNAPSHOT_BLOCK: snapshotBlock, MATCH_BATCH_SEQ: 3, PUBLISHER };
        return { cp, d, PUBLISHER };
    }

    it('the archive flag-day map + frozen amount are byte-equal across the twins and the canonical SoT', function () {
        const map = protocolConstants.ARCHIVE_REWARD_ACTIVATION;
        const amt = protocolConstants.ARCHIVE_REWARD_AMOUNT;
        assert.ok(map, 'documentation/protocol/constants.js must export ARCHIVE_REWARD_ACTIVATION');
        assert.ok(amt, 'documentation/protocol/constants.js must export ARCHIVE_REWARD_AMOUNT');
        for (const [name, mod] of [['hub', hubAr], ['indexer', idxAr]]) {
            assert.deepStrictEqual(mod.ARCHIVE_REWARD_ACTIVATION, map,
                name + ' ARCHIVE_REWARD_ACTIVATION drifted from the canonical protocol constant');
            assert.strictEqual(mod.ARCHIVE_REWARD_AMOUNT, amt,
                name + ' ARCHIVE_REWARD_AMOUNT drifted from the canonical protocol constant');
        }
    });

    it('every local isArchiveRewardActive agrees on the verdict for the same input', function () {
        for (const net of ['mainnet', 'testnet', 'regtest', 'unknownnet']) {
            for (const sb of [0, 100, 1000, 962999, 963000, 1000000000]) {
                const verdicts = [hubAr, idxAr].map(m => m.isArchiveRewardActive(sb, net));
                assert.ok(verdicts.every(v => v === verdicts[0]),
                    'archive gate verdict disagreement for ' + net + '@' + sb + ': ' + JSON.stringify(verdicts));
            }
        }
    });

    it('post-flag-day: hub == indexer archive XANCPUB canonical (EQUIV-wrapped, frozen ARCHIVE amount, archive round-id family)', function () {
        const { cp, d, PUBLISHER } = archiveFixtures('regtest', 100);
        const hubC = hubArchXancpub(cp, 3, PUBLISHER);
        const idxC = idxXancpub(d);
        assert.strictEqual(hubC, idxC, 'hub vs indexer archive XANCPUB canonical drift');
        assert.strictEqual(hubC,
            'EQUIV|XCHECKPOINT|XANCPUB|archive|regtest|3|100|0||XANCPUB|anchor_archive|3|100|' +
            PUBLISHER + '|' + protocolConstants.ARCHIVE_REWARD_AMOUNT,
            'archive XANCPUB canonical drifted from the documented format');
    });

    it('pre-flag-day: hub == indexer archive XANCPUB canonical (header-less, EQUIV dormant)', function () {
        const { cp, d, PUBLISHER } = archiveFixtures('mainnet', 1000);
        const hubC = hubArchXancpub(cp, 3, PUBLISHER);
        const idxC = idxXancpub(d);
        assert.strictEqual(hubC, idxC, 'hub vs indexer pre-flag-day archive XANCPUB canonical drift');
        assert.strictEqual(hubC,
            'XANCPUB|anchor_archive|3|1000|' + PUBLISHER + '|' + protocolConstants.ARCHIVE_REWARD_AMOUNT,
            'pre-flag-day archive canonical must be the bare XANCPUB string');
    });

    it('the archive and bundle XANCPUB round-id families are disjoint (no equivocation collision)', function () {
        // Same batch number, same snapshot: the two canonicals must live in DIFFERENT
        // EQUIV round-id families, or a publisher that signs both in one cycle (the
        // normal case, both legs ride the same flush) would look like an equivocation.
        const { cp, PUBLISHER } = archiveFixtures('regtest', 100);
        const bundle  = hubXancpub({ network: cp.network, snapshot_block: cp.snapshot_block }, PUBLISHER);
        const archive = hubArchXancpub(cp, 3, PUBLISHER);
        const roundIdOf = (s) => s.split('||')[0];
        assert.notStrictEqual(roundIdOf(bundle), roundIdOf(archive),
            'archive round id must not collide with the bundle XANCPUB round id');
    });
});
