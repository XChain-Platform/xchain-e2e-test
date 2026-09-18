/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The pure layer of the bridge rail venue.
 *
 * WHY A UNIT TIER FOR A RAIL HELPER AT ALL. Every decision tested here is one a
 * rail drive would otherwise only discover after standing up four hubs and cloning
 * two chain databases, which is twenty minutes per attempt. Worse, most of them
 * fail SILENTLY at that scale: a confirmation depth that parsed to NaN, an escrow
 * read that answered undefined for a chain spelled the other way, a quorum share
 * that was two thirds exactly. Each of those reads at the rail as "the federation
 * did not finalize", which is the same symptom as nine unrelated faults.
 *
 * Nothing here touches a chain, a database or a socket.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    BridgeRailVenue,
    bridgeEngineHubEnv,
    venueCheckpointEnv,
    bridgeProofIndexerEnv,
    selectBridgeSigners,
    resolveVenueQuorum,
    lockWireV0,
    burnWireV1,
    lockWireV3,
    burnWireV4,
    optInWire,
    effectiveLockDepth,
    capOrderReading,
    classifyInvariant,
    bridgeSettled,
    escrowOf,
    minimalQuorumSigners,
    overFinalizedSourceLegs,
    orphanDepth,
    assertShallowOrphan,
    replacementBlockCount,
    describeRow,
    confirmedHeight,
    indexerCaughtUp,
    orphanWithEmptyBlocks,
    destinationApplyBudgetMs,
    hubRelayMarginFloorS,
    DEFAULT_APPLY_SLACK_MS,
    withMiningPaused,
    classifyFundingWait,
    fundingBudgetMessage,
    interpretFundingNode,
    fundUnderBudget,
} = require('../../helpers/bridgeRailVenue');

// The real seated set on BTC regtest, measured 2026-09-12 at block 597 through
// `getstakeweightsbycapability` on the standing BTC indexer (:3024). Four roster keys at
// 50000 and the standing hub's lost key at 10000. Kept verbatim so the quorum arithmetic
// is exercised on the numbers the rail actually has rather than on round ones.
const SEATED_597 = [
    { pubkey: 'c1ce6bf29e129403d073dd65508ec0fa34d6518ce7a9d10f449354d0c2d7649b', stake: 50000 },
    { pubkey: '5a83d0e969a9b3e2acb7165b7a88cb81e83a17b25ba5d2bbe65d7e102869828e', stake: 50000 },
    { pubkey: '0c3708f70d24711d71fd5441a2401c63b8350704b01b51c5efbd54cd0ce826e2', stake: 50000 },
    { pubkey: 'fd3cf56130fc63862eef2b7e2ff31c128585f0e58fab52dd87aa866ff70ffe5b', stake: 50000 },
    { pubkey: 'a20a4fa165f293a887b8294cf3cf16a4d5aef6e65434feb7438d0168e29dd250', stake: 10000 },
];

const seedFor = (pubkeys) => new Map(pubkeys.map((p) => [p, { seedHex: 'f'.repeat(64), origin: 'unit fixture' }]));

describe('bridgeRailVenue: the pure layer', function () {

    describe('bridgeEngineHubEnv', function () {

        it('wires each chain the caller names and leaves the others unwired', function () {
            const env = bridgeEngineHubEnv({
                indexerUrls: { BTC: 'http://127.0.0.1:41001', DOGE: 'http://127.0.0.1:41201' },
            });
            assert.strictEqual(env.BTC_INDEXER_URL, 'http://127.0.0.1:41001');
            assert.strictEqual(env.DOGE_INDEXER_URL, 'http://127.0.0.1:41201');
            // LTC is a chain the engine knows and this venue does not stand up. An empty
            // string here would be indistinguishable from a wired endpoint that is down,
            // so the key must be ABSENT: the engine's own idle branch reads absence.
            assert.ok(!('LTC_INDEXER_URL' in env),
                'an unwired chain must carry no key at all, or the engine cannot tell ' +
                '"not configured" from "configured and unreachable"');
        });

        it('pins the rail depth at 1 by default on every chain the engine knows', function () {
            const env = bridgeEngineHubEnv({ indexerUrls: { BTC: 'http://x' } });
            assert.strictEqual(env.XCHAIN_CONFIRMATIONS_BTC, '1');
            assert.strictEqual(env.XCHAIN_CONFIRMATIONS_DOGE, '1');
        });

        it('carries AT2 second run\'s raised DOGE depth through verbatim', function () {
            const env = bridgeEngineHubEnv({
                indexerUrls: { BTC: 'http://x', DOGE: 'http://y' },
                confirmations: { DOGE: 60 },
            });
            assert.strictEqual(env.XCHAIN_CONFIRMATIONS_DOGE, '60');
            // And the other chain is NOT disturbed by raising one. AT2's second run
            // measures the DOGE wait; a BTC depth that moved with it would change what
            // the first half of the same drive measured.
            assert.strictEqual(env.XCHAIN_CONFIRMATIONS_BTC, '1');
        });

        it('refuses a depth that is not a positive integer, rather than letting it parse to NaN', function () {
            // THE FAILURE THIS EXISTS TO STOP: the hub does `parseInt(env) || default`, so
            // '1.5', '' and 'one' all fall through to the per-coin MAINNET default with no
            // message. A drive that meant to pin 1 would then wait 6 or 60 confirmations
            // and report "the federation never finalized".
            for (const bad of ['1.5', 'one', '', 0, -1, null]) {
                assert.throws(
                    () => bridgeEngineHubEnv({ indexerUrls: { BTC: 'http://x' }, confirmations: { BTC: bad } }),
                    /is not a positive integer/,
                    'a depth of ' + JSON.stringify(bad) + ' must be refused at build time');
            }
        });
    });

    describe('bridgeProofIndexerEnv', function () {

        it('names the origin chain endpoint the D2 proof client resolves', function () {
            const env = bridgeProofIndexerEnv({ indexerUrls: { BTC: 'http://127.0.0.1:41001' } });
            assert.strictEqual(env.BTC_INDEXER_URL, 'http://127.0.0.1:41001');
        });

        it('wires nothing when no origin endpoint is given', function () {
            assert.deepStrictEqual(bridgeProofIndexerEnv({}), {});
            assert.deepStrictEqual(bridgeProofIndexerEnv(), {});
        });
    });

    describe('selectBridgeSigners', function () {

        it('counts the stake behind the keys it can sign for, not the number of keys', function () {
            const known = seedFor([SEATED_597[0].pubkey, SEATED_597[4].pubkey]);
            const got = selectBridgeSigners(SEATED_597, known);
            // Two of five keys, but 60000 of 210000 units: the count would say 40 percent
            // and the stake says 28.6. Stake is what the quorum rule reads.
            assert.strictEqual(got.adopted.length, 2);
            assert.strictEqual(got.ourStake, 60000);
            assert.strictEqual(got.totalStake, 210000);
            assert.strictEqual(got.supermajority, false);
        });

        it('reaches a supermajority on the four roster keys, and on three, and not on two', function () {
            // The rail's real numbers, so the venue's own floor is stated rather than
            // guessed: with the standing hub's 10000 in the denominator, three of the four
            // roster keys already clear two thirds (150000*3 = 450000 > 210000*2 = 420000)
            // and two of them do not (100000*3 = 300000). A drive that lost one key would
            // still finalize; losing two would not, and it would look like an engine fault.
            const four = selectBridgeSigners(SEATED_597,
                seedFor(SEATED_597.slice(0, 4).map((s) => s.pubkey)));
            assert.strictEqual(four.ourStake, 200000);
            assert.strictEqual(four.supermajority, true);

            const three = selectBridgeSigners(SEATED_597,
                seedFor(SEATED_597.slice(0, 3).map((s) => s.pubkey)));
            assert.strictEqual(three.ourStake, 150000);
            assert.strictEqual(three.supermajority, true);

            const two = selectBridgeSigners(SEATED_597,
                seedFor(SEATED_597.slice(0, 2).map((s) => s.pubkey)));
            assert.strictEqual(two.ourStake, 100000);
            assert.strictEqual(two.supermajority, false,
                '100000 of 210000 is under half, so two roster keys cannot finalize a transfer');
        });

        it('treats exactly two thirds as NOT a quorum', function () {
            // The boundary, stated as its own case because rounding it the wrong way is the
            // classic off-by-one and it would make a venue that cannot finalize look ready.
            const set = [
                { pubkey: 'a'.repeat(64), stake: 2 },
                { pubkey: 'b'.repeat(64), stake: 1 },
            ];
            const got = selectBridgeSigners(set, seedFor(['a'.repeat(64)]));
            assert.strictEqual(got.ourStake, 2);
            assert.strictEqual(got.totalStake, 3);
            assert.strictEqual(got.supermajority, false, 'two thirds exactly is not MORE than two thirds');
        });

        it('ignores a malformed pubkey instead of counting its stake toward the total', function () {
            const set = SEATED_597.concat([{ pubkey: 'NOT-A-KEY', stake: 1000000 }]);
            const got = selectBridgeSigners(set, seedFor(SEATED_597.map((s) => s.pubkey)));
            assert.strictEqual(got.totalStake, 210000,
                'a row that is not a key is not a validator, and letting its stake into the ' +
                'denominator would understate the venue\'s share');
        });
    });

    describe('resolveVenueQuorum', function () {

        it('refuses with the roster keys named when the harness holds none of them', function () {
            // THE MEASURED RAIL STATE on 2026-09-12: `_knownSignerSeeds()` on the rail host
            // holds the three fixed federation signing seeds and the legacy idle seed, and
            // not one of them is seated.
            const got = resolveVenueQuorum(SEATED_597, seedFor(['9'.repeat(64)]));
            assert.strictEqual(got.ok, false);
            assert.match(got.reason, /XC_ROLLCALL_FEDERATION_MNEMONIC/);
            for (const s of SEATED_597.slice(0, 4)) {
                assert.ok(got.reason.includes(s.pubkey.slice(0, 16)),
                    'the refusal must name ' + s.pubkey.slice(0, 16) + ', because a reader ' +
                    'has to know WHICH keys to derive or unstake');
            }
        });

        it('passes on the four roster keys', function () {
            const got = resolveVenueQuorum(SEATED_597, seedFor(SEATED_597.slice(0, 4).map((s) => s.pubkey)));
            assert.strictEqual(got.ok, true);
            assert.strictEqual(got.reason, null);
            assert.strictEqual(got.signers.adopted.length, 4);
        });

        it('says the set is empty rather than reporting a share of an empty total', function () {
            const got = resolveVenueQuorum([], new Map());
            assert.strictEqual(got.ok, false);
            assert.match(got.reason, /EMPTY or unreadable/);
        });

        it('reads a capability row spelled `weight` as well as one spelled `stake`', function () {
            // getstakeweightsbycapability answers `weight`; selectBridgeSigners takes
            // `stake`. A reader that saw only one spelling would compute a total of zero
            // off the real RPC and report an empty set on a fully staked chain.
            const weighted = SEATED_597.slice(0, 4).map((s) => ({ pubkey: s.pubkey, weight: '50000.00000000' }));
            const got = resolveVenueQuorum(weighted, seedFor(weighted.map((s) => s.pubkey)));
            assert.strictEqual(got.ok, true);
            assert.strictEqual(got.signers.totalStake, 200000);
        });
    });

    describe('the XBRIDGE wires', function () {

        it('builds the v0 lock the handler parses, with the trailing empty memo', function () {
            assert.strictEqual(
                lockWireV0('DOGE', 'nXyZ', 5, ''),
                'XBRIDGE|0|DOGE|nXyZ|5|');
        });

        it('builds the v1 burn with no destination coin field', function () {
            // v1 is non-BTC only and its destination is always BTC, so the wire carries no
            // coin field at all. A v1 built like a v0 would parse its address as a coin.
            assert.strictEqual(burnWireV1('mABC', 2, ''), 'XBRIDGE|1|mABC|2|');
        });

        it('refuses to build a leg with a missing address rather than emitting an empty field', function () {
            assert.throws(() => lockWireV0('DOGE', '', 5, ''), /destination coin and address/);
            assert.throws(() => burnWireV1('', 2, ''), /BTC destination address/);
        });
    });

    // The token wires (token spec section 5 and 7), checked against the SDK's own format
    // strings so a field added or reordered there fails here before it reaches a rail.
    describe('the token bridge wires (v3, v4, format 7)', function () {
        // The SDK's own format table is the second witness for the field order. Absence is
        // a single-repo clone and skips that half only; a checkout that is present and will
        // not load fails the case, the convention hubRelayMarginFloorS's case sets below.
        const SDK_FORMATS = '../../../../xchain-sdk/src/protocol/formats.js';
        const sdkFields = (ctx, action, version) => {
            try { require.resolve(SDK_FORMATS); }
            catch (e) { ctx.skip(); }
            return String(require(SDK_FORMATS)[action][version]).split('|');
        };
        const wireFields = (wire) => wire.split('|').length - 1;

        it('builds the v3 lock the handler parses: tick before the destination, trailing memo', function () {
            assert.strictEqual(lockWireV3('FUFU', 'DOGE', 'nXyZ', 5, 'AT1'), 'XBRIDGE|3|FUFU|DOGE|nXyZ|5|AT1');
            assert.strictEqual(lockWireV3('FUFU', 'DOGE', 'nXyZ', '0.5', ''), 'XBRIDGE|3|FUFU|DOGE|nXyZ|0.5|');
        });

        it('builds the v4 burn with no coin field: the origin chain is the rooted tick prefix', function () {
            assert.strictEqual(burnWireV4('BTC.FUFU', 'mABC', 2, ''), 'XBRIDGE|4|BTC.FUFU|mABC|2|');
        });

        it('carries exactly the field count the SDK names for v3 and v4', function () {
            const v3 = sdkFields(this, 'XBRIDGE', 3);
            assert.strictEqual(wireFields(lockWireV3('FUFU', 'DOGE', 'nXyZ', 5, '')), v3.length,
                'the v3 wire does not match the SDK field list ' + v3.join('|'));
            const v4 = sdkFields(this, 'XBRIDGE', 4);
            assert.strictEqual(wireFields(burnWireV4('BTC.FUFU', 'mABC', 2, '')), v4.length,
                'the v4 wire does not match the SDK field list ' + v4.join('|'));
            const f7 = sdkFields(this, 'ISSUE', 7);
            assert.strictEqual(wireFields(optInWire('FUFU', 'DOGE', '', '', '')), f7.length,
                'the format 7 wire does not match the SDK field list ' + f7.join('|'));
        });

        it('builds format 7 with empty fields for "unchanged" and keeps 0 and "-" as the values they are', function () {
            assert.strictEqual(optInWire('FUFU', 'DOGE', undefined, undefined, 'opt in'), 'ISSUE|7|FUFU|DOGE|||opt in');
            assert.strictEqual(optInWire('FUFU', null, 3, null, ''), 'ISSUE|7|FUFU||3||');
            assert.strictEqual(optInWire('FUFU', '-', 0, 1, ''), 'ISSUE|7|FUFU|-|0|1|');
            assert.strictEqual(optInWire('FUFU', 'DOGE,LTC', '', '', ''), 'ISSUE|7|FUFU|DOGE,LTC|||');
        });

        it('refuses a wire with a missing tick or address rather than emitting an empty field', function () {
            assert.throws(() => lockWireV3('', 'DOGE', 'nXyZ', 5, ''), /tick, a destination coin and an address/);
            assert.throws(() => lockWireV3('FUFU', 'DOGE', '', 5, ''), /tick, a destination coin and an address/);
            assert.throws(() => burnWireV4('BTC.FUFU', '', 2, ''), /bridged tick and an origin address/);
            assert.throws(() => optInWire('', 'DOGE', '', '', ''), /needs a tick/);
        });
    });

    describe('effectiveLockDepth', function () {
        it('raises the pinned depth to MIN_DEPTH and never lowers it (the hub rule, D24)', function () {
            assert.strictEqual(effectiveLockDepth(1, 3), 3);
            assert.strictEqual(effectiveLockDepth(6, 3), 6);
            assert.strictEqual(effectiveLockDepth(1, 0), 1);
            assert.strictEqual(effectiveLockDepth(1, null), 1);
            assert.strictEqual(effectiveLockDepth(1, 'x'), 1);
            assert.strictEqual(effectiveLockDepth('bad', 2), 2);
        });
    });

    describe('capOrderReading', function () {
        const t = (id, snap) => ({ transfer_id: id, snapshot_block: snap });
        const s = (id, block) => ({ transfer_id: id, block_index: block });

        it('reads 25 then 5 when a held destination applies thirty due legs in canonical order', function () {
            const transfers = [];
            const settlements = [];
            for (let i = 0; i < 30; i++) {
                const id = 'id' + String(i).padStart(2, '0');
                transfers.push(t(id, 700));
                settlements.push(s(id, i < 25 ? 9001 : 9002));
            }
            const r = capOrderReading(transfers.slice().reverse(), settlements, 25);
            assert.strictEqual(r.ok, true, r.reason);
            assert.deepStrictEqual(r.groups, [{ block: 9001, count: 25 }, { block: 9002, count: 5 }]);
            assert.strictEqual(r.order[0], 'id00');
            assert.strictEqual(r.order[29], 'id29');
        });

        it('sorts by snapshot_block before transfer_id and fails a leg applied out of that order', function () {
            const r = capOrderReading([t('zz', 700), t('aa', 701)], [s('zz', 10), s('aa', 9)], 25);
            assert.strictEqual(r.ok, false);
            assert.match(r.reason, /aa applied at block 9 after a leg that sorts before it applied at 10/);
        });

        it('fails an unapplied leg and a block over the cap, naming each', function () {
            assert.match(capOrderReading([t('aa', 1)], [], 25).reason, /aa was never applied/);
            const r = capOrderReading([t('aa', 1), t('bb', 1), t('cc', 1)], [s('aa', 5), s('bb', 5), s('cc', 5)], 2);
            assert.strictEqual(r.ok, false);
            assert.match(r.reason, /block 5 applied 3 legs, over the cap of 2/);
        });

        it('refuses a cap that is not a positive integer', function () {
            assert.throws(() => capOrderReading([], [], 0), /cap must be a positive integer/);
        });
    });

    describe('classifyInvariant', function () {

        it('separates equal, surplus and deficit by DIRECTION', function () {
            assert.strictEqual(classifyInvariant({ delta: '0' }).verdict, 'equal');
            assert.strictEqual(classifyInvariant({ delta: '1' }).verdict, 'surplus');
            assert.strictEqual(classifyInvariant({ delta: '-1' }).verdict, 'deficit');
        });

        it('reports an unreadable side as unknown and never as equal', function () {
            // D65: a deficit is someone else's units unbacked and a surplus is the sender's
            // own loss, so folding "the hub could not read a chain" into "equal" would turn
            // a blind watch into a green one.
            for (const entry of [{ delta: null }, {}, { delta: '' }, { delta: 'nonsense' }]) {
                assert.strictEqual(classifyInvariant(entry).verdict, 'unknown',
                    JSON.stringify(entry) + ' must not read as equal');
            }
        });
    });

    describe('minimalQuorumSigners', function () {

        const adopted = SEATED_597.slice(0, 4).map((s) => ({ pubkeyHex: s.pubkey, seedHex: 'f'.repeat(64), stake: s.stake }));

        it('takes three of the four roster keys, because three already clear two thirds', function () {
            // 150000 * 3 = 450000 > 210000 * 2 = 420000, and two do not: 100000 * 3 = 300000.
            const got = minimalQuorumSigners(adopted, 210000);
            assert.strictEqual(got.length, 3);
            assert.strictEqual(got.reduce((n, a) => n + a.stake, 0), 150000);
        });

        it('is deterministic, so two processes reading one capability set build one mesh', function () {
            const a = minimalQuorumSigners(adopted, 210000).map((x) => x.pubkeyHex);
            const b = minimalQuorumSigners(adopted.slice().reverse(), 210000).map((x) => x.pubkeyHex);
            assert.deepStrictEqual(a, b);
        });

        it('treats EXACTLY two thirds as short, the same rule stake_weighted_quorum enforces', function () {
            // The boundary the rail's own numbers never reach, and therefore the one a
            // careless `>=` would slip past unnoticed: two keys at 50000 against a total of
            // 150000 is exactly two thirds, which is not a quorum. A mesh built on it
            // finalizes nothing and looks identical at boot to one that would.
            const twoThirds = [
                { pubkeyHex: 'a'.repeat(64), seedHex: 'f'.repeat(64), stake: 50000 },
                { pubkeyHex: 'b'.repeat(64), seedHex: 'f'.repeat(64), stake: 50000 },
            ];
            assert.deepStrictEqual(minimalQuorumSigners(twoThirds, 150000), []);
            // One unit more of held stake is a quorum, so the refusal above is the boundary
            // and not a blanket no.
            const over = twoThirds.concat([{ pubkeyHex: 'c'.repeat(64), seedHex: 'f'.repeat(64), stake: 1 }]);
            assert.strictEqual(minimalQuorumSigners(over, 150001).length, 3);
        });

        it('answers empty when no subset can reach the supermajority, rather than a near miss', function () {
            // The failure this refuses to paper over: a venue built on a set that cannot
            // finalize looks identical at boot to one that can, and only says so thirty
            // minutes later as `0 commits`.
            assert.deepStrictEqual(minimalQuorumSigners(adopted.slice(0, 2), 210000), []);
            assert.deepStrictEqual(minimalQuorumSigners([], 210000), []);
            assert.deepStrictEqual(minimalQuorumSigners(adopted, 0), []);
        });
    });

    describe('venueCheckpointEnv', function () {

        // MEASURED 2026-09-12 (drive 8): transfer b743a79a carried snapshot_block 611 and the
        // venue's only quorum checkpoint sat at block_index 605, six short, so the destination
        // deferred the mint every five seconds with `no quorum-established checkpoint at or
        // after the transfer snapshot_block is held locally` and the whole acceptance set
        // stalled behind it. 605 is 611 minus the shipped CHECKPOINT_CONFIRMATIONS, and both
        // numbers come off the same tip, so any non-zero value reproduces the stall.
        it('checkpoints the TIP, because a buried checkpoint can never serve a transfer stamped from the same tip', function () {
            assert.strictEqual(venueCheckpointEnv({}).CHECKPOINT_CONFIRMATIONS, '0');
        });

        it('runs a round every block rather than on the fleet cadence', function () {
            assert.strictEqual(venueCheckpointEnv({}).CHECKPOINT_INTERVAL_BLOCKS, '1');
        });

        it('leaves LTC out, because the venue has no LTC indexer to checkpoint', function () {
            assert.strictEqual(venueCheckpointEnv({}).CHECKPOINT_CHAINS, 'BTC,DOGE');
            assert.strictEqual(venueCheckpointEnv({ chains: ['btc'] }).CHECKPOINT_CHAINS, 'BTC');
        });

        it('takes a poll cadence and defaults it', function () {
            assert.strictEqual(venueCheckpointEnv({}).CHECKPOINT_POLL_MS, '5000');
            assert.strictEqual(venueCheckpointEnv({ pollMs: 1500 }).CHECKPOINT_POLL_MS, '1500');
        });
    });

    describe('bridgeSettled', function () {

        // MEASURED ON THE RAIL 2026-09-12, and this is why the two questions are separate
        // functions. The hub reported `{escrow: 35, supply: 0, in_flight: 70, delta: -35}`
        // for a rail whose two finalized transfers were simply not effective yet: that is
        // consistent and mid-flight, not a break. A drive that took a baseline off it, or a
        // watch that alarmed on it, would be reading a timing window as a forgery.
        it('calls a mid-flight rail unsettled rather than broken', function () {
            assert.strictEqual(bridgeSettled({ escrow: '35', supply: '0', in_flight: '70', delta: '-35' }), false);
            assert.strictEqual(classifyInvariant({ delta: '-35' }).verdict, 'deficit');
        });

        it('settles only when the delta is zero AND nothing is in flight', function () {
            assert.strictEqual(bridgeSettled({ delta: '0', in_flight: '0' }), true);
            assert.strictEqual(bridgeSettled({ delta: '0', in_flight: '5' }), false);
            assert.strictEqual(bridgeSettled({ delta: '1', in_flight: '0' }), false);
        });

        it('never reads an unreadable chain as settled', function () {
            // Same rule classifyInvariant follows: LTC has no venue indexer on this rail and
            // the hub serves it as null, which is not a settled chain.
            assert.strictEqual(bridgeSettled({ delta: null, in_flight: '0' }), false);
            assert.strictEqual(bridgeSettled({ delta: '0' }), false);
            assert.strictEqual(bridgeSettled(null), false);
        });
    });

    describe('overFinalizedSourceLegs', function () {

        // THE ROWS ARE DRIVE 11's OWN, copied off the venue hub databases
        // (XChain_AM_MVH_bridgerail_3795473_mtyvtpkj_Hub0..2, which all three agreed on), so
        // the function is exercised on the shape the defect actually produced rather than on
        // an invented one. BTC lock 99 finalized three times and lock 95 twice.
        const DRIVE_11 = [
            { transfer_id: '5f1e9a8d2001e787', src_chain: 'BTC', src_action_index: 97, amount: '5', status: 'finalized', snapshot_block: 1017 },
            { transfer_id: 'c0a5e273c67613fa', src_chain: 'BTC', src_action_index: 101, amount: '30', status: 'finalized', snapshot_block: 1017 },
            { transfer_id: 'e68759061c60edeb', src_chain: 'BTC', src_action_index: 103, amount: '5', status: 'finalized', snapshot_block: 1017 },
            { transfer_id: '9876b7fb7481e345', src_chain: 'BTC', src_action_index: 95, amount: '30', status: 'finalized', snapshot_block: 1017 },
            { transfer_id: 'bddd8e5ffd888106', src_chain: 'BTC', src_action_index: 99, amount: '5', status: 'finalized', snapshot_block: 1017 },
            { transfer_id: '3612318b7abaf95a', src_chain: 'BTC', src_action_index: 95, amount: '30', status: 'finalized', snapshot_block: 1018 },
            { transfer_id: 'cea785ba700313e3', src_chain: 'BTC', src_action_index: 99, amount: '5', status: 'finalized', snapshot_block: 1018 },
            { transfer_id: '6f43f9e7f2b4d3fa', src_chain: 'BTC', src_action_index: 99, amount: '5', status: 'finalized', snapshot_block: 1019 },
            { transfer_id: '02761a6d97f81c1c', src_chain: 'BTC', src_action_index: 109, amount: '5', status: 'finalized', snapshot_block: 1038 },
            { transfer_id: 'a037a13d5df2f72b', src_chain: 'DOGE', src_action_index: 2725, amount: '2', status: 'finalized', snapshot_block: 1052 },
            { transfer_id: '58b7cc56f78943a3', src_chain: 'DOGE', src_action_index: 2725, amount: '2', status: 'finalized', snapshot_block: 1053 },
        ];

        it('names every over-finalized source leg, with the value it invented', function () {
            const dupes = overFinalizedSourceLegs(DRIVE_11);
            const byLeg = new Map(dupes.map((d) => [d.srcChain + ':' + d.actionIndex, d]));
            assert.deepStrictEqual([...byLeg.keys()].sort(), ['BTC:95', 'BTC:99', 'DOGE:2725']);
            assert.strictEqual(byLeg.get('BTC:99').count, 3);
            // Three transfers of 5 for one 5-unit lock: 15 credited, 10 of it unpaid for.
            assert.strictEqual(byLeg.get('BTC:99').amountTotal, 15);
            assert.strictEqual(byLeg.get('BTC:95').amountTotal, 60);
            assert.strictEqual(byLeg.get('DOGE:2725').count, 2);
            // The ids and heights travel with the finding, because the height is the whole
            // mechanism: the same lock at a new snapshot_block is a new transfer_id.
            assert.deepStrictEqual(byLeg.get('BTC:99').transfers,
                ['bddd8e5ffd888106@1017', 'cea785ba700313e3@1018', '6f43f9e7f2b4d3fa@1019']);
        });

        it('calls a leg with exactly one finalized transfer clean', function () {
            const clean = DRIVE_11.filter((r) => ![95, 99].includes(r.src_action_index) &&
                r.src_action_index !== 2725);
            assert.deepStrictEqual(overFinalizedSourceLegs(clean), []);
            assert.deepStrictEqual(overFinalizedSourceLegs([]), []);
            assert.deepStrictEqual(overFinalizedSourceLegs(null), []);
        });

        it('does not count a retracted row as a duplicate, because retraction is the fence working', function () {
            // A source reorged out is retracted and re-finalized at a new generation (AT3b).
            // Counting that as duplication would report the defence as the defect.
            const retracted = DRIVE_11
                .filter((r) => r.src_action_index === 99)
                .map((r, i) => (i === 0 ? r : Object.assign({}, r, { status: 'retracted' })));
            assert.deepStrictEqual(overFinalizedSourceLegs(retracted), []);
        });

        it('keeps the same action index on two chains apart', function () {
            // src_action_index is per chain, so BTC 95 and DOGE 95 are different legs and a
            // grouping on the index alone would invent a duplicate out of two honest locks.
            assert.deepStrictEqual(overFinalizedSourceLegs([
                { transfer_id: 'a'.repeat(16), src_chain: 'BTC', src_action_index: 95, amount: '5', status: 'finalized', snapshot_block: 10 },
                { transfer_id: 'b'.repeat(16), src_chain: 'DOGE', src_action_index: 95, amount: '5', status: 'finalized', snapshot_block: 10 },
            ]), []);
        });
    });

    describe('escrowOf', function () {

        it('finds the escrow however the answer spells the chain', function () {
            assert.strictEqual(escrowOf({ escrow: { DOGE: '5' } }, 'DOGE'), '5');
            assert.strictEqual(escrowOf({ escrow: { doge: '5' } }, 'DOGE'), '5');
        });

        it('answers null for a chain with no escrow row, never zero', function () {
            // AT1 asserts the transition from "no row" to "5", and a helper that answered
            // '0' for an absent row would make the before-state and an emptied escrow the
            // same reading.
            assert.strictEqual(escrowOf({ escrow: { LTC: '0' } }, 'DOGE'), null);
            assert.strictEqual(escrowOf({}, 'DOGE'), null);
            assert.strictEqual(escrowOf(null, 'DOGE'), null);
            assert.strictEqual(escrowOf({ escrow: { DOGE: '0' } }, 'DOGE'), '0');
        });
    });

    describe('orphanDepth and assertShallowOrphan', function () {

        it('reads a depth of 1 when the height IS the tip', function () {
            assert.strictEqual(orphanDepth(1953, 1953), 1);
        });

        it('reads the AT3c defect\'s own numbers: 16 blocks deep', function () {
            // The exact reading the rail produced 2026-09-13: orphaning from 1938 at tip
            // 1953. Kept literal so a future change to the arithmetic is checked against
            // the reading that motivated it, not just against invented numbers.
            assert.strictEqual(orphanDepth(1938, 1953), 16);
        });

        it('passes a depth at exactly the window', function () {
            assert.strictEqual(assertShallowOrphan(1942, 1953, 12), 12);
        });

        it('refuses a depth one past the window, naming height, tip and the window', function () {
            assert.throws(() => assertShallowOrphan(1938, 1953, 12),
                /orphaning from 1938 at tip 1953 is 16 blocks deep, past the standing utxo-tracker's 12-block undo window/);
        });
    });

    describe('withMiningPaused', function () {

        function fakeMiner() {
            const calls = [];
            return {
                calls: calls,
                pauseMining: async () => { calls.push('pause'); },
                resumeMining: async () => { calls.push('resume'); },
            };
        }

        it('pauses before fn runs and resumes after, returning fn\'s value', async function () {
            const miner = fakeMiner();
            const seenAtRun = [];
            const result = await withMiningPaused(miner, async () => {
                seenAtRun.push(miner.calls.slice());
                return 'orphaned-hash';
            });
            assert.strictEqual(result, 'orphaned-hash');
            assert.deepStrictEqual(miner.calls, ['pause', 'resume']);
            // fn ran strictly between the pause and the resume, not before either.
            assert.deepStrictEqual(seenAtRun, [['pause']]);
        });

        it('still resumes when fn throws, and lets the error through unchanged', async function () {
            const miner = fakeMiner();
            await assert.rejects(
                () => withMiningPaused(miner, async () => { throw new Error('mint never applied'); }),
                /mint never applied/);
            assert.deepStrictEqual(miner.calls, ['pause', 'resume']);
        });

        it('holds the flag file the external block loop honours for exactly the span of fn, even when fn throws', async function () {
            const os = require('os');
            const fs = require('fs');
            const path = require('path');
            const flag = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-rail-pause-')), 'btc-loop.pause');
            const miner = fakeMiner();
            let seenDuring = null;
            await withMiningPaused(miner, async () => { seenDuring = fs.existsSync(flag); }, { pauseFile: flag });
            assert.strictEqual(seenDuring, true, 'the flag must exist while fn runs');
            assert.strictEqual(fs.existsSync(flag), false, 'the flag must be gone after fn returns');
            await assert.rejects(
                () => withMiningPaused(miner, async () => { throw new Error('boom'); }, { pauseFile: flag }),
                /boom/);
            assert.strictEqual(fs.existsSync(flag), false, 'the flag must be gone after fn throws');
            assert.deepStrictEqual(miner.calls, ['pause', 'resume', 'pause', 'resume']);
        });

        it('refuses a connector missing either half of the pair, before touching either', async function () {
            const partial = { pauseMining: async () => {} };
            await assert.rejects(() => withMiningPaused(partial, async () => {}),
                /needs a connector with pauseMining\(\)\/resumeMining\(\)/);
        });
    });

    describe('replacementBlockCount', function () {

        it('disconnects one block and overtakes it with two, or the floor when that is higher', function () {
            // Orphaning the tip itself: one block disconnected, one to overtake, floored at 2.
            assert.strictEqual(replacementBlockCount(2653, 2653), 2);
            assert.strictEqual(replacementBlockCount(2653, 2653, 3), 3);
        });

        it('covers every block above the orphan plus one, over a lower floor', function () {
            // Blocks 2653, 2654 and 2655 disconnect; three replace them and a fourth overtakes.
            assert.strictEqual(replacementBlockCount(2653, 2655, 2), 4);
        });
    });

    describe('describeRow', function () {

        it('renders a BigInt column as digits instead of throwing', function () {
            const text = describeRow({ id: 42n, transfer_id: 'e404b384', amount: '1', nested: { seq: 7n } });
            assert.strictEqual(text, '{"id":"42","transfer_id":"e404b384","amount":"1","nested":{"seq":"7"}}');
        });

        it('says null for the row an absence assertion is happy with', function () {
            assert.strictEqual(describeRow(null), 'null');
        });
    });

    /**
     * A regtest node in miniature: a chain of blocks by height, a mempool, and the five
     * RPCs the orphan lever uses. `remine` makes `generateBlock` behave like the miner
     * sidecar's `generatetoaddress`, sweeping the mempool into every block regardless of
     * the transaction list it was given.
     */
    function fakeNode(spec) {
        const chain = [];
        for (let h = 0; h <= spec.tip; h++) chain.push({ hash: 'orig-' + h, txs: [] });
        chain[spec.lockHeight].txs.push(spec.lockTx);
        const mempool = [];
        const generated = [];
        let serial = 0;
        return {
            chain, mempool, generated,
            getBlockCount: async () => chain.length - 1,
            getBlockHash: async (h) => {
                if (!chain[h]) throw new Error('Block height out of range');
                return chain[h].hash;
            },
            invalidateBlock: async (hash) => {
                const at = chain.findIndex((b) => b.hash === hash);
                for (const b of chain.splice(at)) mempool.push(...b.txs);
            },
            generateBlock: async (address, txs) => {
                const include = spec.remine ? mempool.splice(0) : txs.slice();
                generated.push({ address, txs: txs.slice() });
                chain.push({ hash: 'new-' + chain.length + '-' + (serial++), txs: include });
            },
            getTransaction: async (txid) => {
                const block = chain.find((b) => b.txs.includes(txid));
                if (block) return { txid, blockhash: block.hash, confirmations: chain.length - chain.indexOf(block) };
                return mempool.includes(txid) ? { txid } : null;
            },
            getBlock: async (hash) => ({ hash, height: chain.findIndex((b) => b.hash === hash) }),
        };
    }

    describe('confirmedHeight', function () {

        it('reads the confirming block\'s height from the node, waiting out an unconfirmed spell', async function () {
            const node = fakeNode({ tip: 2655, lockHeight: 2654, lockTx: 'lock' });
            // Unknown, then in the mempool, then confirmed: the height is read only at the end.
            const answers = [null, { txid: 'lock' }];
            const real = node.getTransaction;
            node.getTransaction = async (txid) => (answers.length ? answers.shift() : real(txid));
            assert.strictEqual(await confirmedHeight(node, 'lock', { everyMs: 1 }), 2654);
        });

        it('fails naming a transaction the node holds unconfirmed, and one it has never seen', async function () {
            const stuck = fakeNode({ tip: 2655, lockHeight: 2654, lockTx: 'lock' });
            await stuck.invalidateBlock('orig-2654');
            await assert.rejects(() => confirmedHeight(stuck, 'lock', { timeoutMs: 20, everyMs: 5 }),
                /transaction lock did not confirm within 0s \(the node holds it unconfirmed\)/);
            await assert.rejects(() => confirmedHeight(stuck, 'ghost', { timeoutMs: 20, everyMs: 5 }),
                /transaction ghost did not confirm within 0s \(the node has never seen it\)/);
        });
    });

    describe('indexerCaughtUp and waitForVenueTip', function () {

        it('reads caught up at the height and above, and counts the blocks behind below it', function () {
            assert.deepStrictEqual(indexerCaughtUp(2887, 2887), { caughtUp: true, have: 2887, want: 2887, behind: 0 });
            assert.deepStrictEqual(indexerCaughtUp(2890, 2887), { caughtUp: true, have: 2890, want: 2887, behind: 0 });
            assert.deepStrictEqual(indexerCaughtUp(2886, 2887), { caughtUp: false, have: 2886, want: 2887, behind: 1 });
            // The RPC answers block_index as a number, but a SQL read hands the same column back
            // as a string or a BigInt; all three are the same height.
            assert.strictEqual(indexerCaughtUp('2887', 2887).caughtUp, true);
            assert.strictEqual(indexerCaughtUp(2887n, '2887').caughtUp, true);
        });

        it('keeps an unreadable tip apart from a lagging one, so null is never height 0', function () {
            assert.deepStrictEqual(indexerCaughtUp(null, 2887), { caughtUp: false, have: null, want: 2887, behind: null });
            assert.deepStrictEqual(indexerCaughtUp(undefined, 2887), { caughtUp: false, have: null, want: 2887, behind: null });
            assert.strictEqual(indexerCaughtUp('unreadable', 2887).have, null);
            // And a target of 0 with a null tip is still NOT caught up: Number(null) is 0.
            assert.strictEqual(indexerCaughtUp(null, 0).caughtUp, false);
        });

        it('refuses a target that is not a block height instead of waiting on it', function () {
            for (const bad of [undefined, null, NaN, 'tip', -1, 2887.5]) {
                assert.throws(() => indexerCaughtUp(2887, bad), /must be a block height, got /);
            }
        });

        // The async half on a fake venue: the real `waitUntil` over a scripted `getblockhashes`.
        function fakeVenue(tips) {
            const answers = tips.slice();
            const venue = {
                calls: 0,
                indexerRpc: async (chain, method) => {
                    assert.strictEqual(method, 'getblockhashes');
                    venue.calls += 1;
                    const next = answers.length > 1 ? answers.shift() : answers[0];
                    if (next instanceof Error) throw next;
                    return next === null ? null : { block_index: next };
                },
                indexerTails: () => '(no venue logs in the unit tier)',
                waitUntil: BridgeRailVenue.prototype.waitUntil,
            };
            return venue;
        }

        it('returns once the venue indexer answers the target height, polling past a lag and a failed read', async function () {
            const venue = fakeVenue([2885, new Error('ECONNREFUSED'), null, 2886, 2887]);
            const got = await BridgeRailVenue.prototype.waitForVenueTip.call(venue, 'BTC', 2887, 'for the SEND',
                { timeoutMs: 2000, everyMs: 1 });
            assert.deepStrictEqual(got, { caughtUp: true, have: 2887, want: 2887, behind: 0 });
            assert.strictEqual(venue.calls, 5);
        });

        it('does not return while the venue indexer is still a block behind, and names the block when the budget runs out', async function () {
            const venue = fakeVenue([2886]);
            await assert.rejects(
                () => BridgeRailVenue.prototype.waitForVenueTip.call(venue, 'BTC', 2887, 'for the SEND',
                    { timeoutMs: 15, everyMs: 2 }),
                /waited 0s for the venue BTC indexer to reach block 2887 for the SEND and it never happened/);
            assert.ok(venue.calls >= 2, 'the wait polled ' + venue.calls + ' times, so it never re-read the tip');
        });

        it('refuses a bad target before polling, so the failure names the number and not the indexer', async function () {
            const venue = fakeVenue([2887]);
            await assert.rejects(
                () => BridgeRailVenue.prototype.waitForVenueTip.call(venue, 'BTC', NaN, '', { timeoutMs: 15, everyMs: 2 }),
                /must be a block height, got NaN/);
            assert.strictEqual(venue.calls, 0);
        });
    });

    describe('orphanWithEmptyBlocks', function () {

        it('leaves the lock unconfirmed on a longer chain of coinbase-only blocks', async function () {
            const node = fakeNode({ tip: 2655, lockHeight: 2654, lockTx: 'lock' });
            const out = await orphanWithEmptyBlocks(node, { height: 2654, coinbase: 'mcoinbase', atLeast: 3, lockTx: 'lock' });
            assert.deepStrictEqual(out, { hash: 'orig-2654', tipBefore: 2655, tipAfter: 2656, mined: 3 });
            // Every replacement block was asked for with NO transactions, at the given coinbase.
            assert.deepStrictEqual(node.generated, [
                { address: 'mcoinbase', txs: [] }, { address: 'mcoinbase', txs: [] }, { address: 'mcoinbase', txs: [] },
            ]);
            assert.deepStrictEqual(node.mempool, ['lock'], 'the lock sits in the mempool for the next miner');
            assert.deepStrictEqual(await node.getTransaction('lock'), { txid: 'lock' });
            assert.notStrictEqual(await node.getBlockHash(2654), 'orig-2654');
        });

        it('refuses a replacement chain that carried the lock back in, naming its block', async function () {
            // A miner that sweeps the mempool re-confirms the lock one block later, the exact
            // shape a `generatetoaddress` replacement produces.
            const node = fakeNode({ tip: 2655, lockHeight: 2654, lockTx: 'lock', remine: true });
            await assert.rejects(
                () => orphanWithEmptyBlocks(node, { height: 2654, coinbase: 'mcoinbase', atLeast: 3, lockTx: 'lock' }),
                /transaction lock is still confirmed, in block new-2654-0, after the orphan of block 2654/);
        });

        it('does not ask about a lock it was not given, and still proves the reorg', async function () {
            const node = fakeNode({ tip: 2655, lockHeight: 2654, lockTx: 'lock', remine: true });
            const out = await orphanWithEmptyBlocks(node, { height: 2655, coinbase: 'mcoinbase' });
            assert.deepStrictEqual(out, { hash: 'orig-2655', tipBefore: 2655, tipAfter: 2656, mined: 2 });
        });

        it('refuses to run without a height or a coinbase address', async function () {
            const node = fakeNode({ tip: 2655, lockHeight: 2654, lockTx: 'lock' });
            await assert.rejects(() => orphanWithEmptyBlocks(node, { coinbase: 'mcoinbase' }), /needs a height/);
            await assert.rejects(() => orphanWithEmptyBlocks(node, { height: 2654 }), /needs a coinbase address/);
            assert.strictEqual(node.generated.length, 0);
        });
    });

    describe('destinationApplyBudgetMs', function () {

        it('is the relay margin plus the default slack, in milliseconds', function () {
            assert.strictEqual(destinationApplyBudgetMs(240), 240 * 1000 + DEFAULT_APPLY_SLACK_MS);
            assert.strictEqual(destinationApplyBudgetMs(240, { slackMs: 0 }), 240000);
        });

        it('exceeds the margin: a wait equal to the margin ends the second the leg becomes eligible', function () {
            assert.ok(destinationApplyBudgetMs(240) > 240000);
            assert.ok(DEFAULT_APPLY_SLACK_MS >= 60000, 'the slack must cover several destination blocks');
        });

        it('refuses a margin that is not a positive number, and a negative slack', function () {
            assert.throws(() => destinationApplyBudgetMs(0), /relay margin must be a positive number of seconds, got 0/);
            assert.throws(() => destinationApplyBudgetMs('soon'), /relay margin must be a positive number/);
            assert.throws(() => destinationApplyBudgetMs(240, { slackMs: -1 }), /slack must be a non-negative number/);
        });

        it('reads the hub\'s own DOGE margin so the budget moves with the stamp', function () {
            // Absence is a single-repo clone and may skip; a checkout that IS
            // present and will not load must fail this case rather than skip it,
            // so the require below runs unguarded once resolution proves it exists.
            const hubRelayMarginModule = '../../../../xchain-hub/src/lib/relay_margin.js';
            try { require.resolve(hubRelayMarginModule); }
            catch (e) { return this.skip(); }
            const relay = require(hubRelayMarginModule);
            const marginS = hubRelayMarginFloorS('DOGE');
            assert.strictEqual(marginS, relay.relayMarginFloorS('DOGE'));
            assert.ok(marginS > 0);
            assert.strictEqual(destinationApplyBudgetMs(marginS), marginS * 1000 + DEFAULT_APPLY_SLACK_MS);
        });
    });

    describe('where the venue DOGE indexer gets its ledger (dq 5)', function () {

        // The constructor does no IO, so the decision it encodes is checkable here rather
        // than only by standing up a chain and waiting hours for the wrong ledger.
        const identity = [{ pubkeyHex: 'a'.repeat(64), privkeyHex: 'b'.repeat(64) }];

        it('replays rather than clones by default, because AT1 asserts an absence', function () {
            // The cloned DOGE ledger carries the pre-D62 self-seeded XCHAIN row, so a
            // venue built on it cannot assert AT1's precondition at all. A default that
            // quietly cloned would turn AT1 into a measurement of a mint into an existing
            // row, reported as AT1.
            const venue = new BridgeRailVenue({ label: 'unit', identities: identity });
            assert.strictEqual(venue.dogeReplayChain, true);
        });

        it('takes a deliberate opt-out and nothing else', function () {
            assert.strictEqual(
                new BridgeRailVenue({ label: 'unit', identities: identity, dogeReplayChain: false })
                    .dogeReplayChain, false);
            // Anything that is not exactly false is not an opt-out. A truthy-ish or
            // misspelled value must not silently select the cloned ledger, because that
            // failure is invisible until AT1's precondition reads the wrong chain state.
            for (const sloppy of [0, '', 'false', null, undefined]) {
                const venue = new BridgeRailVenue({
                    label: 'unit', identities: identity, dogeReplayChain: sloppy });
                assert.strictEqual(venue.dogeReplayChain, sloppy === undefined ? true : false,
                    'dogeReplayChain=' + JSON.stringify(sloppy) + ' resolved to ' +
                    venue.dogeReplayChain);
            }
        });

        it('refuses to build anywhere but regtest, whatever the ledger source', function () {
            assert.throws(
                () => new BridgeRailVenue({ label: 'unit', identities: identity, network: 'testnet' }),
                /refusing to build on testnet/);
        });
    });

    describe('the funding budget', function () {

        // VERBATIM from drive 13's log, the three lines the harness printed on a loop for
        // 22 minutes while it funded AT2B.DEST and the drive died behind it. Kept as the
        // fixture so the classifier is tested against the output it will actually see.
        const DRIVE_13_STALL = [
            'nativeFeeHelper: injected native fee output 50000 sats -> mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim',
            'Creating the transaction...',
            'Sending the transaction... (hex length: 586)',
            'Waiting for the transaction (a7dfb4110000000000000000000000000000000000000000000000000000dead) to be confirmed...',
            'Waiting for the utxo-tracker to index confirmed UTXOs from tx a7dfb4110000000000000000000000000000000000000000000000000000dead...',
        ];

        it('names the utxo-tracker and the transaction when that is the last wait printed', function () {
            const wait = classifyFundingWait(DRIVE_13_STALL);
            assert.strictEqual(wait.txid,
                'a7dfb4110000000000000000000000000000000000000000000000000000dead');
            assert.match(wait.stage, /utxo-tracker/);
            assert.match(wait.service, /utxo-tracker/);
        });

        it('names the coin node and the miner when the transaction never reached a block', function () {
            // The utxo-tracker line removed: the LAST stage printed is then the confirmation
            // wait, and the service that owes an answer is the chain, not the tracker.
            const wait = classifyFundingWait(DRIVE_13_STALL.slice(0, 4));
            assert.match(wait.stage, /reaching a block/);
            assert.match(wait.service, /mining loop/);
            assert.strictEqual(wait.txid,
                'a7dfb4110000000000000000000000000000000000000000000000000000dead');
        });

        it('names the ADDRESS when the wait is for a spendable utxo', function () {
            const wait = classifyFundingWait([
                'Sending funds (5) to mkmtvYKR1Uxmpb5GfusEcRJrPtM96DJaWH',
                'Waiting for the utxos for mkmtvYKR1Uxmpb5GfusEcRJrPtM96DJaWH',
            ]);
            assert.strictEqual(wait.address, 'mkmtvYKR1Uxmpb5GfusEcRJrPtM96DJaWH');
            assert.match(wait.stage, /spendable utxo/);
        });

        it('reports no stage at all rather than inventing one, when nothing was printed', function () {
            // "The call never got as far as sending" is a DIFFERENT finding from a
            // transaction wait, and reporting the latter would send a reader to the miner
            // for a fault that is in the helper's own setup.
            const wait = classifyFundingWait(['priceSnapshotHelper: price_snapshots not available']);
            assert.strictEqual(wait.stage, null);
            assert.strictEqual(wait.txid, null);
            assert.strictEqual(wait.address, null);
        });

        it('breaches the budget against a call that will never come back, naming what it waited for',
            async function () {
                // DRIVEN AGAINST SOMETHING THAT NEVER ARRIVES, which is the whole shape of
                // the three drives this budget exists for: the call prints its progress and
                // then never resolves.
                const never = () => new Promise(() => {
                    for (const line of DRIVE_13_STALL) console.log(line);
                });
                const started = Date.now();
                let failure = null;
                try {
                    await fundUnderBudget('AT2B.DEST', never, { budgetMs: 150,
                        diagnose: async () => ({ tipsAtStart: { BTC: 1379, DOGE: 11522 },
                                                 tipsAtBreach: { BTC: 1380, DOGE: 11525 } }) });
                } catch (e) { failure = e; }
                assert.ok(failure, 'the budget did not fire on a call that never resolves, so a ' +
                    'stalled funding call still hangs the drive');
                assert.ok(Date.now() - started < 60000,
                    'the budget fired only after ' + (Date.now() - started) + 'ms');
                // The message must name the thing waited on, not merely say it timed out.
                assert.match(failure.message, /AT2B\.DEST/);
                assert.match(failure.message, /a7dfb411/);
                assert.match(failure.message, /utxo-tracker/);
                assert.match(failure.message, /1379/);
                assert.strictEqual(failure.fundingWait.txid,
                    'a7dfb4110000000000000000000000000000000000000000000000000000dead');
            });

        it('returns the funded address untouched when the call comes back inside the budget',
            async function () {
                const answer = await fundUnderBudget('AT1.SENDER',
                    async () => { console.log('Sending funds (1) to mx8QQEYN'); return { address: 'mx8QQEYN' }; },
                    { budgetMs: 5000 });
                assert.deepStrictEqual(answer, { address: 'mx8QQEYN' });
            });

        it('restores console.log after a breach, so the next case still logs', async function () {
            const before = console.log;
            try {
                await fundUnderBudget('AT7.GAS', () => new Promise(() => {}), { budgetMs: 60 });
            } catch (e) { /* expected */ }
            assert.strictEqual(console.log, before,
                'console.log was left wrapped, so every later line in the drive would be ' +
                'captured by a call that has already failed');
        });

        it('lets the funding call\'s OWN failure through unchanged', async function () {
            // A real error from the helper must not be reported as a stall: the two have
            // different owners and different fixes.
            await assert.rejects(
                () => fundUnderBudget('AT6.SEND',
                    async () => { throw new Error('Expected Buffer, got undefined'); },
                    { budgetMs: 5000 }),
                /Expected Buffer, got undefined/);
        });

        it('sends the reader upstream of the chain when the node never saw the transaction', function () {
            // The drive-13 shape: every process alive, the miner answering, each new block
            // carrying only its coinbase and the mempool empty. That is a transaction the node
            // never accepted, and the fix is nowhere near the miner.
            const sentence = interpretFundingNode(classifyFundingWait(DRIVE_13_STALL),
                { knownToNode: false, inMempool: false, mempoolSize: 0, nodeHeight: 1380 });
            assert.match(sentence, /never seen this transaction/);
            assert.match(sentence, /not.*the miner/);
        });

        it('sends the reader to the miner when the transaction is sitting in the mempool', function () {
            const sentence = interpretFundingNode(classifyFundingWait(DRIVE_13_STALL),
                { knownToNode: true, inMempool: true, mempoolSize: 1, confirmations: 0 });
            assert.match(sentence, /mempool and no block/);
            assert.match(sentence, /miner/);
        });

        it('sends the reader downstream when the transaction is already confirmed', function () {
            // Same console output, a completely different owner: the chain did its part and
            // whatever indexes the transaction has not caught up.
            const sentence = interpretFundingNode(classifyFundingWait(DRIVE_13_STALL),
                { knownToNode: true, inMempool: false, confirmations: 3 });
            assert.match(sentence, /confirmed at depth 3/);
            assert.match(sentence, /downstream/);
        });

        it('says the chain could not be asked rather than guessing', function () {
            const sentence = interpretFundingNode(classifyFundingWait(DRIVE_13_STALL),
                { node: 'no rail node connector in scope, so the chain was not asked' });
            assert.match(sentence, /undetermined/);
        });

        it('carries the chain reading and its interpretation into the failure message', function () {
            const msg = fundingBudgetMessage('AT2B.DEST', 480000, 1320000,
                classifyFundingWait(DRIVE_13_STALL),
                { node: { knownToNode: false, inMempool: false, mempoolSize: 0 } });
            assert.match(msg, /"knownToNode":false/);
            assert.match(msg, /never seen this transaction/);
        });

        it('never reads an unreadable source indexer as a drained backlog', async function () {
            this.timeout(20000);
            // THE WORST ANSWER waitForRailSettled could give, and the one it gave before this:
            // a source indexer whose read throws would answer "nothing pending", the drive
            // would take a BASELINE against a rail whose legs were all still unsigned, and
            // every absolute reading after it would be arithmetic on a number nobody waited
            // for. The poll must stay outstanding instead.
            const venue = new BridgeRailVenue({ label: 'unit',
                identities: [{ pubkeyHex: 'a'.repeat(64), privkeyHex: 'b'.repeat(64) }] });
            venue.btcVenue = { hubs: [{ index: 0, dbName: 'unit_hub_0' }], hubDb: null };
            venue.indexerRpc = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:61009'); };
            venue.queryHubDb = async () => [];
            venue.queryIndexerDb = async () => [];
            // One poll and out: 4 s is inside the deadline for the first pass and outside it
            // after the method's own 5 s sleep between polls.
            const answer = await venue.waitForRailSettled('XCHAIN', { timeoutMs: 4000 });
            assert.strictEqual(answer, null,
                'an unreadable source indexer was reported as a drained rail');
            const stages = (venue._lastSettlePoll.pending || []).map((p) => p.stage + ':' + p.chain);
            assert.deepStrictEqual(stages.sort(),
                ['source read unreadable:BTC', 'source read unreadable:DOGE'],
                'the outstanding list does not name the chains whose read failed: ' +
                JSON.stringify(venue._lastSettlePoll));
            assert.match(JSON.stringify(venue._lastSettlePoll), /ECONNREFUSED/,
                'the failure that stopped the read is not carried into the outstanding list');
        });

        it('reports drained only when every leg the chain carries has applied', async function () {
            const venue = new BridgeRailVenue({ label: 'unit',
                identities: [{ pubkeyHex: 'a'.repeat(64), privkeyHex: 'b'.repeat(64) }] });
            venue.btcVenue = { hubs: [{ index: 0, dbName: 'unit_hub_0' }], hubDb: null };
            venue.indexerRpc = async (chain, method) => {
                if (method === 'getbridgeinvariant') return { XCHAIN: {} };
                return chain === 'BTC'
                    ? { transfers: [{ tick: 'XCHAIN', dest_chain: 'DOGE', src_action_index: 99, amount: '5' }] }
                    : { transfers: [] };
            };
            venue.queryHubDb = async () => [{ transfer_id: 'abc', status: 'finalized' }];
            venue.queryIndexerDb = async () => [{ block_index: 11764 }];
            venue.hubRpc = async () => ({ XCHAIN: { DOGE: { delta: '0' } } });
            const answer = await venue.waitForRailSettled('XCHAIN', { timeoutMs: 30000 });
            assert.ok(answer, 'a fully applied backlog was not reported as drained');
            assert.deepStrictEqual(answer.applied.map((a) => a.actionIndex), ['99']);
        });

        it('waits on a condition and comes back the moment it holds', async function () {
            const venue = new BridgeRailVenue({ label: 'unit',
                identities: [{ pubkeyHex: 'a'.repeat(64), privkeyHex: 'b'.repeat(64) }] });
            let calls = 0;
            const answer = await venue.waitUntil('the third read to answer true',
                () => (++calls >= 3), { timeoutMs: 5000, everyMs: 10 });
            assert.strictEqual(answer, true);
            assert.strictEqual(calls, 3);
        });

        it('fails naming what it waited for, and treats a throwing read as not yet', async function () {
            // A read against a service that is still starting must not END the wait, and the
            // failure has to say what never happened: this replaced a fixed 20 s settle sleep
            // in AT4, where the message was the whole difference between a diagnosis and a
            // rerun.
            const venue = new BridgeRailVenue({ label: 'unit',
                identities: [{ pubkeyHex: 'a'.repeat(64), privkeyHex: 'b'.repeat(64) }] });
            venue.indexerTails = () => '(no venue indexers in a unit run)';
            await assert.rejects(
                () => venue.waitUntil('the destination to log a refusal naming deadbeefdeadbeef',
                    () => { throw new Error('connect ECONNREFUSED 127.0.0.1:61019'); },
                    { timeoutMs: 120, everyMs: 20 }),
                (err) => {
                    assert.match(err.message, /the destination to log a refusal naming deadbeefdeadbeef/);
                    assert.match(err.message, /ECONNREFUSED/);
                    return true;
                });
        });

        // The injector seam AT4 needs. It lives in attestMirrorVenue, and the cases are here
        // because the bridge rail is what asked for the table parameter and this is the row's
        // own unit file: the shared venue's suite stays untouched.
        it('injects into the named mirror table on its own key, and leaves the default path identical',
            async function () {
                const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue');
                const run = async (row, opts) => {
                    const sqls = [];
                    const fake = {
                        _conn: { query: async (sql, params) => {
                            sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params });
                            return /^SELECT/.test(sql.trim()) ? [{ id: 7 }] : { affectedRows: 1 };
                        } },
                        hubs: [{ index: 0, dbName: 'unit_hub_0' }],
                        indexers: [{ followsHub: 0 }],
                    };
                    const written = await AttestMirrorVenue.prototype.injectMirrorRow.call(
                        fake, row, Object.assign({ reconnect: false }, opts || {}));
                    return { sqls: sqls, written: written };
                };

                // THE DEFAULT PATH, byte for byte what every existing caller gets.
                const def = await run({ network: 'regtest', request_id: 'r1', effective_time: 10, payload: 'x' });
                assert.match(def.sqls[0].sql, /^INSERT IGNORE INTO `unit_hub_0`\.`attestation_responses`/);
                assert.match(def.sqls[1].sql,
                    /^SELECT id FROM `unit_hub_0`\.`attestation_responses` WHERE `network` = \? AND `request_id` = \? AND `effective_time` = \? LIMIT 1$/);
                assert.deepStrictEqual(def.sqls[1].params, ['regtest', 'r1', 10]);
                assert.deepStrictEqual(def.written, [{ hub: 0, inserted: true, id: 7 }]);

                // AT4'S PATH: a bridge transfer, keyed by transfer_id alone. The first run of
                // AT4 wrote these columns into attestation_responses and died on
                // `Unknown column 'transfer_id' in 'INSERT INTO'`.
                const at4 = await run({ transfer_id: 'at4deadbeef', src_chain: 'BTC', amount: '5' },
                    { table: 'bridge_transfers', key: ['transfer_id'] });
                assert.match(at4.sqls[0].sql, /^INSERT IGNORE INTO `unit_hub_0`\.`bridge_transfers`/);
                assert.match(at4.sqls[1].sql,
                    /^SELECT id FROM `unit_hub_0`\.`bridge_transfers` WHERE `transfer_id` = \? LIMIT 1$/);
                assert.deepStrictEqual(at4.sqls[1].params, ['at4deadbeef']);
            });

        it('refuses a row that cannot be read back, rather than reporting an unreachable id', async function () {
            const { AttestMirrorVenue } = require('../../helpers/attestMirrorVenue');
            const fake = {
                _conn: { query: async () => ({ affectedRows: 1 }) },
                hubs: [{ index: 0, dbName: 'unit_hub_0' }],
                indexers: [{ followsHub: 0 }],
            };
            await assert.rejects(
                () => AttestMirrorVenue.prototype.injectMirrorRow.call(fake,
                    { src_chain: 'BTC', amount: '5' },
                    { table: 'bridge_transfers', key: ['transfer_id'], reconnect: false }),
                /cannot read back a bridge_transfers row without its key column transfer_id/);
        });

        it('states the elapsed time and the budget it broke', function () {
            const msg = fundingBudgetMessage('AT5.MAKER', 480000, 1320000,
                classifyFundingWait(DRIVE_13_STALL), {});
            assert.match(msg, /1320s elapsed against a budget of 480s/);
        });
    });
});
