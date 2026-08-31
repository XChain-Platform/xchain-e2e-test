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
 * The ANCHOR acceptance suite must key its expected reward-derivation state off
 * the flag-days active at the resolved snapshot_block, never a hardcoded
 * assumption about which side of a flag-day the row falls on. These exercise
 * the derivation table with injected predicates, so no hub checkout, no DB and
 * no chain are needed.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const av     = require('../helpers/anchorVersionHelper');

// Flag-day predicate triple with each gate independently switchable.
function flags({ roots = false, anchorReward = false, archiveReward = false } = {}){
    return {
        isCheckpointCommitmentActive: () => roots,
        isAnchorRewardActive:         () => anchorReward,
        isArchiveRewardActive:        () => archiveReward
    };
}

const ROOTLESS_CP = { network: 'regtest', snapshot_block: 100 };
const ROOTED_CP   = {
    network: 'regtest', snapshot_block: 218,
    state_root: 'a'.repeat(64), state_root_version: 1,
    block_merkle_root: 'b'.repeat(64), block_merkle_version: 1
};

describe('anchorVersionHelper', function () {

    describe('anchorPayloadVersion', function () {
        it('reads the version byte off an ANCHOR payload', function () {
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|0|regtest|136|1'), 0);
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|1|DOGE|regtest|136'), 1);
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|2|DOGE|regtest|136'), 2);
        });
        it('returns null for anything that is not an ANCHOR payload', function () {
            assert.strictEqual(av.anchorPayloadVersion('SEND|1|DOGE'), null);
            assert.strictEqual(av.anchorPayloadVersion('ANCHOR|x|DOGE'), null);
            assert.strictEqual(av.anchorPayloadVersion(null), null);
            assert.strictEqual(av.anchorPayloadVersion(undefined), null);
        });
    });

    describe('checkpointCarriesRoots', function () {
        it('requires every root AND its scheme version', function () {
            assert.strictEqual(av.checkpointCarriesRoots(ROOTED_CP), true);
            assert.strictEqual(av.checkpointCarriesRoots(ROOTLESS_CP), false);
            // A root present without its version byte stays rootless: the row was
            // signed over the rootless canonical, so its signatures only verify there.
            assert.strictEqual(av.checkpointCarriesRoots(
                Object.assign({}, ROOTED_CP, { state_root_version: null })), false);
            assert.strictEqual(av.checkpointCarriesRoots(
                Object.assign({}, ROOTED_CP, { block_merkle_root: null })), false);
        });
    });

    describe('expectedCheckpointAnchor', function () {
        // The checkpoint leg has exactly one version now (D2): the OLD per-chain
        // v0/v3/v4/v5 wires (a different, now-retired numbering) were deleted
        // with the per-chain wire, so no flag-day combination can move it.
        it('is v0 with every flag-day off', function () {
            let e = av.expectedCheckpointAnchor(ROOTLESS_CP, { flagDays: flags({}) });
            assert.deepStrictEqual(e.accepted, [0]);
            assert.strictEqual(e.preferred, 0);
            assert.strictEqual(e.fallback, null);
        });

        it('is v0 with every flag-day on', function () {
            let e = av.expectedCheckpointAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }) });
            assert.deepStrictEqual(e.accepted, [0]);
            assert.strictEqual(e.rootBearing, true);
            assert.strictEqual(e.rewardActive, true);
        });

        it('reports rootBearing as an eligibility fact, not a version selector', function () {
            // A rootless row is SKIPPED by the publisher (D8) rather than anchored
            // on an older rootless wire, so the version stays v0 either way.
            let e = av.expectedCheckpointAnchor(ROOTLESS_CP, { flagDays: flags({ roots: true }) });
            assert.strictEqual(e.rootBearing, false);
            assert.deepStrictEqual(e.accepted, [0]);
        });

        it('an identity-less hub still publishes v0, it just earns no reward', function () {
            // The degraded attestation path is ATTEST_SIG_COUNT 0 within v0, not a
            // fallback to an older version.
            let e = av.expectedCheckpointAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }), hasIdentity: false });
            assert.deepStrictEqual(e.accepted, [0]);
            assert.strictEqual(e.rewardActive, false);
        });
    });

    describe('expectedArchiveAnchor', function () {
        // The archive leg has exactly one version now too (D4): the tail is
        // ALWAYS appended, so the old tail-less wire and v6 are both retired.
        it('pre-flag-day: v1 only', function () {
            let e = av.expectedArchiveAnchor(ROOTLESS_CP, { flagDays: flags({}) });
            assert.deepStrictEqual(e.accepted, [1]);
            assert.strictEqual(e.preferred, 1);
            assert.strictEqual(e.fallback, null);
        });
        it('archive-reward active: still v1, rewardActive tracks reward derivation rather than the version', function () {
            let e = av.expectedArchiveAnchor(ROOTED_CP, { flagDays: flags({ archiveReward: true }) });
            assert.deepStrictEqual(e.accepted, [1]);
            assert.strictEqual(e.rewardActive, true);
            assert.strictEqual(e.fallback, null);
        });
        it('the archive leg does not follow the checkpoint roots gate', function () {
            let e = av.expectedArchiveAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }) });
            assert.deepStrictEqual(e.accepted, [1]);
        });
        it('a degraded attestation round (ATTEST_SIG_COUNT 0) is still accepted by expectedArchiveAnchor', function () {
            // D4: the degrade stays WITHIN v1 now, so the acceptance set does not
            // move whether or not the attestation round reached quorum; only
            // rewardActive reports the difference.
            let quorum   = av.expectedArchiveAnchor(ROOTED_CP, { flagDays: flags({ archiveReward: true }) });
            let degraded = av.expectedArchiveAnchor(ROOTED_CP,
                { flagDays: flags({ archiveReward: true }), hasIdentity: false });
            assert.deepStrictEqual(quorum.accepted, [1]);
            assert.deepStrictEqual(degraded.accepted, [1]);
            assert.strictEqual(quorum.rewardActive, true);
            assert.strictEqual(degraded.rewardActive, false, 'no identity to earn the reward, but the wire is still v1');
        });
    });

    describe('findAnchorBroadcast / findAnchorRow', function () {
        const broadcasts = [
            { payload: 'ANCHOR|0|regtest|136|1', txid: 'aa' },
            { payload: 'ANCHOR|1|DOGE|regtest|136', txid: 'bb' }
        ];

        it('matches each leg against its derived version set', function () {
            let cpE  = av.expectedCheckpointAnchor(ROOTED_CP,
                { flagDays: flags({ roots: true, anchorReward: true }) });
            let arcE = av.expectedArchiveAnchor(ROOTED_CP, { flagDays: flags({ archiveReward: true }) });
            assert.strictEqual(av.findAnchorBroadcast(broadcasts, cpE.accepted).txid,  'aa');
            assert.strictEqual(av.findAnchorBroadcast(broadcasts, arcE.accepted).txid, 'bb');
        });

        it('a retired version matches nothing the hub emits now', function () {
            // 3/4/5 are the retired OLD per-chain wire; 6/7 are the retired
            // pre-restart archive/bundle versions. 0/1 are live again under the
            // restarted set but mean something different now, so they are not
            // tested here.
            for (const v of [3, 4, 5, 6, 7])
                assert.strictEqual(av.findAnchorBroadcast(broadcasts, [v]), null);
        });

        it('rows are narrowed by ledger_hash so a dirty chain cannot satisfy the assert', function () {
            const rows = [
                { version: 0, ledger_hash: 'old', status: 'valid' },
                { version: 0, ledger_hash: 'ours', status: 'valid' }
            ];
            assert.strictEqual(av.findAnchorRow(rows, [0], 'ours').ledger_hash, 'ours');
            assert.strictEqual(av.findAnchorRow(rows, [0], 'absent'), null);
            assert.strictEqual(av.findAnchorRow(rows, [1], 'ours'), null);
        });
    });

    describe('parseAnchorV0', function () {
        // Two sections at one signer each, one attesting signer. Field order is
        // the builder's (StateAnchorPublisher._buildV7Payload; the method name did
        // not move, only the version byte it writes).
        function section(chain, seq, sigs){
            return [chain, '900', chain + '-blockhash', chain + '-ledger', chain + '-actions',
                    chain + '-contract', String(seq), '136',
                    'a'.repeat(64), '1', 'b'.repeat(64), '1', String(sigs.length)]
                   .concat(sigs.flatMap(s => [s.pubkey, s.sig])).join('|');
        }
        const TWO_SECTION =
            ['ANCHOR', '0', 'regtest', '136', '2'].join('|') + '|' +
            section('BTC', 11, [{ pubkey: 'pk1', sig: 'sig1' }]) + '|' +
            section('LTC', 11, [{ pubkey: 'pk2', sig: 'sig2' }, { pubkey: 'pk3', sig: 'sig3' }]) + '|' +
            ['pub0', '1', 'apk', 'asig'].join('|');

        it('walks variable-width sections without misreading a signature as a chain', function () {
            let b = av.parseAnchorV0(TWO_SECTION);
            assert.strictEqual(b.version, 0);
            assert.strictEqual(b.network, 'regtest');
            assert.strictEqual(b.snapshot_block, 136);
            assert.strictEqual(b.section_count, 2);
            assert.deepStrictEqual(b.chains, ['BTC', 'LTC']);
            // The LTC section carries TWO pairs; a fixed-offset reader would have
            // taken 'pk3'/'sig3' as the tail and lost the publisher.
            assert.strictEqual(b.sections[0].sigs.length, 1);
            assert.strictEqual(b.sections[1].sigs.length, 2);
            assert.strictEqual(b.sections[1].checkpoint_seq, 11);
            assert.strictEqual(b.publisher, 'pub0');
            assert.strictEqual(b.attest_sig_count, 1);
            assert.deepStrictEqual(b.attestSigs, [{ pubkey: 'apk', sig: 'asig' }]);
        });

        it('returns null for a non-v0 payload and throws on a truncated one', function () {
            // A retired version byte (the pre-restart bundle version) must not
            // parse as a bundle any more than the archive leg's own version does.
            assert.strictEqual(av.parseAnchorV0('ANCHOR|7|regtest|136|2'), null);
            assert.strictEqual(av.parseAnchorV0('ANCHOR|1|DOGE|regtest|136'), null);
            assert.strictEqual(av.parseAnchorV0('SEND|1|DOGE'), null);
            assert.strictEqual(av.parseAnchorV0(null), null);
            // A wire that promises three sections and carries two must FAIL, not
            // silently report a two-section bundle (the AT1 cardinality assert).
            assert.throws(() => av.parseAnchorV0(TWO_SECTION.replace('|0|regtest|136|2|', '|0|regtest|136|3|')),
                /truncated|does not carry/);
        });

        it('parses the frozen protocol vector', function () {
            let vector;
            try { vector = require('../../../xchain-documentation/protocol/test-vectors/anchor_canonical.json'); }
            catch (e) { return this.skip(); }        // no docs checkout on this box
            let b = av.parseAnchorV0(vector.vectors.v0);
            assert.strictEqual(b.section_count, b.sections.length);
            assert.deepStrictEqual(b.chains, b.chains.slice().sort(),
                'the vector proves sections ride CHAIN-ascending (D5)');
            for (const s of b.sections)
                assert.deepStrictEqual(s.sigs.map(x => x.pubkey), s.sigs.map(x => x.pubkey).slice().sort(),
                    'and pairs within a section ride PUBKEY-ascending (D5)');
        });
    });

    describe('bundleBroadcasts / findBundleSectionRows', function () {
        it('keeps only the v0 wires out of a mixed broadcast list', function () {
            let out = av.bundleBroadcasts([
                { payload: 'ANCHOR|1|DOGE|regtest|136', txid: 'arc' },
                { payload: 'ANCHOR|0|regtest|136|1|BTC|900|bh|lh|ah|ch|11|136|' +
                           'a'.repeat(64) + '|1|' + 'b'.repeat(64) + '|1|0|pub0|0', txid: 'bun' }
            ]);
            assert.strictEqual(out.length, 1);
            assert.strictEqual(out[0].txid, 'bun');
            assert.deepStrictEqual(out[0].bundle.chains, ['BTC']);
        });

        it('collects one bundle\'s sibling rows by action_index, in section order', function () {
            const rows = [
                { version: 0, action_index: 40, section_index: 0, ledger_hash: 'old' },
                { version: 0, action_index: 41, section_index: 2, ledger_hash: 'l-ltc' },
                { version: 0, action_index: 41, section_index: 0, ledger_hash: 'l-btc' },
                { version: 0, action_index: 41, section_index: 1, ledger_hash: 'l-doge' },
                { version: 1, action_index: 42, section_index: 0, ledger_hash: 'l-btc' }
            ];
            let got = av.findBundleSectionRows(rows, 'l-doge');
            assert.strictEqual(got.length, 3, 'all three sections of the bundle, and only those');
            assert.deepStrictEqual(got.map(r => r.section_index), [0, 1, 2]);
            // A ledger_hash from a DIFFERENT action must not drag this bundle in.
            assert.deepStrictEqual(av.findBundleSectionRows(rows, 'nope'), []);
        });
    });

    describe('hubFlagDays (live wiring)', function () {
        it('reads the hub\'s own frozen predicates when a checkout is resolvable', function () {
            let fd;
            try { fd = av.hubFlagDays(); }
            catch (e) { return this.skip(); }          // no xchain-hub checkout on this box
            assert.strictEqual(typeof fd.isCheckpointCommitmentActive, 'function');
            assert.strictEqual(typeof fd.isAnchorRewardActive, 'function');
            assert.strictEqual(typeof fd.isArchiveRewardActive, 'function');
            // regtest arms every reward flag-day from genesis, which is precisely
            // why an isolated venue at a high snapshot_block still earns rewards.
            assert.strictEqual(fd.isAnchorRewardActive(218, 'regtest'), true);
            assert.strictEqual(fd.isArchiveRewardActive(218, 'regtest'), true);
        });

        it('reads v0 + v1 off the REAL flag-days on a regtest row', function () {
            // No injected predicates: the same modules the publisher branches on,
            // on a regtest row past the reward thresholds (which regtest arms at
            // genesis). Neither leg has a version ladder left any more: the
            // checkpoint leg is always v0, the archive leg is always v1.
            try { av.hubFlagDays(); }
            catch (e) { return this.skip(); }
            let cp = av.expectedCheckpointAnchor(ROOTED_CP);
            let ar = av.expectedArchiveAnchor(ROOTED_CP);
            assert.deepStrictEqual(cp.accepted, [0], 'the checkpoint leg is v0 only');
            assert.strictEqual(cp.rewardActive, true, 'so an anchor_bundle reward is expected');
            assert.deepStrictEqual(ar.accepted, [1], 'the archive leg is v1 only');
            assert.strictEqual(ar.rewardActive, true, 'so an anchor_archive reward is expected on this venue');
        });
    });
});
