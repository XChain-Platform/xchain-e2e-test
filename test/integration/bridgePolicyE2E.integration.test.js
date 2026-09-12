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
 * XPOLICY: a hub-signed token-policy snapshot applied to a bridged copy, end to end.
 *
 * Policy spec acceptance tests AT1 (first snapshot materialized), AT2 (an issuer edit
 * reaching the copy), AT4 (falsification), AT5's ordering half and AT6 (sleep), driven on
 * the multiHubCrossSettleE2E shape: the record one repository finalizes is handed to the
 * other repository's real apply path.
 *
 * THE BINDING UNDER TEST is narrower and sharper than the transfer one. Membership is
 * TRANSPORT: the allow and block arrays ride beside the row and are bound to it only
 * through policy_hash, so the hub's _policyHash and the indexer's policyHash are a
 * byte-match obligation over a canonical membership text, and the canonical they are
 * committed inside is a second one. If either drifts, a snapshot the whole federation
 * signed is refused by every destination, permanently, while both repositories' own suites
 * stay green. Every hash and every signature below is produced by xchain-hub's engine and
 * verified by xchain-indexer's settle pass.
 *
 * The apply cases need no venue. The federated case boots a real MultiValidatorHub mesh,
 * needs a hub MariaDB (provisioned HUB_DB_* or Docker), and skips loudly without one. The
 * live origin-to-destination lag readout on the rail is spec row 15's, not this
 * file's.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const crypto = require('crypto');

const HUB    = require('../helpers/bridgeHubRecord');
const SETTLE = require('../helpers/bridgeSettleContext');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { BridgePendingSource }  = require('../helpers/bridgePendingSource');
const { waitForMesh, waitFor } = require('../helpers/consensusWait');

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

describe('XPOLICY: hub-signed policy snapshot to indexer settle pass (policy AT1, AT2, AT4, AT5, AT6)', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ids = HUB.makeIdentities(3);
        validators = HUB.capabilitySet(ids);
    });

    describe('the cross-repository seam', function(){

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
                'hub _policyHash and indexer policyHash disagree over the same membership');
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
            assert.strictEqual(absent, HUB.hubEngine()._policyHash(null, null, false));
            assert.strictEqual(empty,  HUB.hubEngine()._policyHash([],   [],   false));
        });

        it('signs the canonical the indexer rebuilds, byte for byte', function(){
            const row = snapshot(ids, { block: [MEMBER_A] });
            const hubSide     = HUB.hubCanonical(row);
            const indexerSide = BS.policyCanonical(row);
            assert.strictEqual(indexerSide, hubSide,
                'hub _canonicalMatch (policy branch) and indexer policyCanonical disagree');
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

    describe('policy AT1: the first snapshot materializes onto the copy', function(){

        it('creates the block list with the exact member, points the copy at it, and records the settlement', async function(){
            const row = snapshot(ids, { block: [MEMBER_A] });
            const { ctx, state, config } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: copyRow(),
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, true, 'a hub-signed snapshot did not apply: ' + res.reason);
            const injected = legs(state);
            assert.strictEqual(injected.length, 2,
                'expected the block-list create and the ISSUE 5 pointer, saw ' + injected.length);

            // Ordinal 2 is BLOCK_CREATE_OR_REMOVE and is consensus-visible: it decides the
            // action index the leg takes on every node.
            assert.strictEqual(injected[0].ordinal, 2, 'the block-list leg is not at its pinned ordinal');
            assert.deepStrictEqual(injected[0].fields, ['LIST', '0', '2', '', MEMBER_A],
                'the injected list is not a type-2 address list holding exactly the signed member');
            assert.strictEqual(injected[0].source, config.ADDRESS.BRIDGE_BTC,
                'the list was not created by the BTC bridge role address on DOGE');
            assert.strictEqual(injected[0].isGenesis, true,
                'the injected leg did not carry IS_GENESIS, so it would hit the bridge-owned LIST refusal');
            assert.ok(injected[0].tx_hash.startsWith('XPOLICY-'),
                'the synthetic transaction is not in the XPOLICY family: ' + injected[0].tx_hash);
            assert.ok(injected[0].tx_hash.endsWith(row.snapshot_id.slice(0, 48)),
                'the synthetic hash is not keyed on this snapshot id');

            // Ordinal 4 is ISSUE_POINT. The ALLOW field is EMPTY (no allow list was created)
            // and the BLOCK field names the action index the list leg took.
            assert.strictEqual(injected[1].ordinal, 4);
            assert.strictEqual(injected[1].fields[0], 'ISSUE');
            assert.strictEqual(injected[1].fields[1], '5');
            assert.strictEqual(injected[1].fields[2], COPY);
            assert.strictEqual(injected[1].fields[3], '', 'ALLOW_LIST was pointed at something');
            assert.strictEqual(injected[1].fields[4], String(state.injected[0] && 5000),
                'the copy was not pointed at the list the create leg minted');

            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.settlements[0].transfer_id, row.snapshot_id);
            assert.strictEqual(state.settlements[0].kind, 'policy',
                'a policy snapshot was recorded under the transfer kind, which would collide the unique key');
        });

        it('an ABSENT list injects nothing for it and still records the snapshot', async function(){
            // seq 1 of a tick with no lists that is awake: every leg is a no-op, which is
            // ordinary and must still terminate rather than be re-evaluated forever.
            const row = snapshot(ids, {});
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: copyRow(),
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, true, 'a no-op snapshot did not apply: ' + res.reason);
            assert.deepStrictEqual(state.injected, [], 'an absent list still injected a leg');
            assert.strictEqual(state.settlements.length, 1,
                'a no-op snapshot was not recorded, so it would be re-evaluated on every later block');
            assert.strictEqual(state.actions[0].ACTION, 'XPOLICY',
                'the anchor action is not the internal XPOLICY action');
        });
    });

    describe('policy AT2: an issuer edit reaches the copy', function(){

        it('injects one REMOVE and one ADD against the existing list, and does not move the pointer', async function(){
            const row = snapshot(ids, { policySeq: 2, block: [MEMBER_B, MEMBER_C] });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators,
                tokens: copyRow({ BLOCK_LIST: 77 }),
                lists: { 77: [MEMBER_A, MEMBER_B] },     // A is dropped, C is added
                mirrorPolicies: [],
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, true, 'the edit snapshot did not apply: ' + res.reason);
            const injected = legs(state);
            assert.strictEqual(injected.length, 2,
                'a change with both a removal and an addition is two actions, saw ' + injected.length);
            // A LIST format 1 carries ONE edit verb for the whole action, which is exactly
            // why the removal and the addition have separate pinned ordinals.
            assert.strictEqual(injected[0].ordinal, 2);
            assert.deepStrictEqual(injected[0].fields, ['LIST', '1', '2', '77', '', MEMBER_A],
                'the removal leg does not name exactly the dropped member');
            assert.strictEqual(injected[1].ordinal, 3);
            assert.deepStrictEqual(injected[1].fields, ['LIST', '1', '1', '77', '', MEMBER_C],
                'the addition leg does not name exactly the added member');
            assert.ok(!injected.some(l => l.fields[0] === 'ISSUE'),
                'an edit moved the copy pointer, which would orphan the list');
        });
    });

    describe('policy AT6: sleep travels, and only when it changes', function(){

        it('injects an indefinite SLEEP at its pinned ordinal when the origin is asleep', async function(){
            const row = snapshot(ids, { sleeping: true });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: copyRow(),
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, true, 'the sleeping snapshot did not apply: ' + res.reason);
            const injected = legs(state);
            assert.strictEqual(injected.length, 1, 'expected exactly the SLEEP leg');
            assert.strictEqual(injected[0].ordinal, 5);
            // resume_block -1, never the origin's own resume height: block heights are not
            // comparable across chains.
            assert.deepStrictEqual(injected[0].fields, ['SLEEP', '1', '-1', COPY]);
        });
    });

    describe('policy AT4: falsification of a mirrored snapshot', function(){

        // Each case asserts that NOTHING was injected and NOTHING was recorded. Asserting
        // the reason string would prove only that the module agrees with itself.
        const cases = [
            {
                name: 'membership that does not hash to the signed policy_hash',
                // The row is signed over a canonical carrying hash(ALLOW -, BLOCK [A]) while
                // the transport arrays say [B]: exactly the substitution the hash exists to
                // catch, and the signature is genuine.
                build: (ids) => {
                    const row = snapshot(ids, { block: [MEMBER_A] });
                    row.block_list = JSON.stringify([MEMBER_B]);
                    return row;
                },
                terminal: true
            },
            {
                name: 'membership out of canonical byte order',
                build: (ids) => {
                    const row = HUB.buildPolicyRow({
                        snapshotBlock: SNAPSHOT, originChain: 'BTC', tick: TICK, policySeq: 1,
                        originBlock: ORIGIN_BLK, effectiveTime: DUE_TIME, network: NETWORK,
                        block: [MEMBER_B, MEMBER_A]        // descending: never canonical
                    });
                    return HUB.signRecord(row, ids);
                },
                terminal: true
            },
            {
                name: 'membership transport that is not a JSON array',
                build: (ids) => {
                    const row = snapshot(ids, { block: [MEMBER_A] });
                    row.block_list = '{"not":"an array"}';
                    return row;
                },
                terminal: true
            },
            {
                name: 'a bundle signed over other bytes',
                build: (ids) => {
                    const row = snapshot([], { block: [MEMBER_A] });
                    const other = HUB.buildPolicyRow({
                        snapshotBlock: SNAPSHOT, originChain: 'BTC', tick: TICK, policySeq: 9,
                        originBlock: ORIGIN_BLK, effectiveTime: DUE_TIME, network: NETWORK,
                        block: [MEMBER_A]
                    });
                    return HUB.signRecord(row, ids, { message: HUB.hubCanonical(other) });
                },
                terminal: true
            },
            {
                name: 'a signer outside the capability snapshot',
                build: () => snapshot(HUB.makeIdentities(3), { block: [MEMBER_A] }),
                terminal: true
            },
            {
                name: 'a foreign network',
                build: (ids) => snapshot(ids, { block: [MEMBER_A], network: 'testnet' }),
                terminal: true
            }
        ];

        cases.forEach((c) => {
            it('applies nothing for ' + c.name, async function(){
                const { ctx, state } = SETTLE.makeSettleContext({
                    coin: 'DOGE', validators: validators, tokens: copyRow(),
                    blockIndex: BLOCK, blockTime: BLOCK_TIME
                });

                const res = await BS.applyPolicySnapshot(c.build(ids), ctx);

                assert.strictEqual(res.applied, false, c.name + ' was applied');
                assert.deepStrictEqual(state.injected, [], c.name + ' injected a leg');
                assert.deepStrictEqual(state.settlements, [], c.name + ' recorded a settlement');
                assert.strictEqual(res.terminal, c.terminal,
                    c.name + ' was classified ' + (res.terminal ? 'terminal' : 'carried') +
                    ', which decides whether the pass ever retries it');
            });
        });

        it('applies nothing for a foreign btc_chain_id', async function(){
            const row = snapshot(ids, { block: [MEMBER_A], btcChainId: 'f'.repeat(64) });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: copyRow(),
                chainId: '0'.repeat(64),
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, false, 'a snapshot from a dead chain instance applied');
            assert.strictEqual(res.terminal, true);
            assert.deepStrictEqual(state.injected, []);
        });

        it('refuses to inherit onto the ORIGIN chain itself', async function(){
            const row = snapshot(ids, { block: [MEMBER_A] });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'BTC', validators: validators, tokens: copyRow(),
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, false, 'the origin chain inherited its own policy');
            assert.strictEqual(res.terminal, true);
            assert.deepStrictEqual(state.injected, []);
        });
    });

    describe('policy AT5: apply order is by policy_seq, never by time', function(){

        it('carries a later seq forward while an earlier finalized seq is unapplied', async function(){
            const seq1 = snapshot(ids, { policySeq: 1, block: [MEMBER_A] });
            const seq2 = snapshot(ids, { policySeq: 2, block: [MEMBER_B] });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: copyRow(),
                // The mirror holds seq 1 finalized; nothing has applied it here yet.
                mirrorPolicies: [ { snapshot_id: seq1.snapshot_id, policy_seq: 1 } ],
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(seq2, ctx);

            assert.strictEqual(res.applied, false,
                'seq 2 applied over an unapplied seq 1, which leaves the copy on stale membership forever');
            assert.strictEqual(res.terminal, false,
                'a missing earlier seq was classified terminal, so the copy could never catch up');
            assert.deepStrictEqual(state.injected, []);
            assert.deepStrictEqual(state.settlements, []);
        });

        it('applies a later seq when the earlier one is already recorded here', async function(){
            const seq1 = snapshot(ids, { policySeq: 1, block: [MEMBER_A] });
            const seq2 = snapshot(ids, { policySeq: 2, block: [MEMBER_B] });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators,
                tokens: copyRow({ BLOCK_LIST: 77 }),
                lists: { 77: [MEMBER_A] },
                mirrorPolicies: [ { snapshot_id: seq1.snapshot_id, policy_seq: 1 } ],
                settled: [ seq1.snapshot_id + '|policy' ],
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(seq2, ctx);

            assert.strictEqual(res.applied, true, 'seq 2 did not apply behind a recorded seq 1: ' + res.reason);
            const fields = legs(state).map(l => l.fields);
            assert.deepStrictEqual(fields, [
                ['LIST', '1', '2', '77', '', MEMBER_A],
                ['LIST', '1', '1', '77', '', MEMBER_B]
            ], 'seq 2 did not bring the existing list to its new membership');
        });

        it('a snapshot ahead of the block protocol time is carried, not refused', async function(){
            const row = snapshot(ids, { block: [MEMBER_A], effectiveTime: BLOCK_TIME + 600 });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: copyRow(),
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.terminal, false, 'a not-yet-due snapshot was made terminal');
            assert.deepStrictEqual(state.injected, []);
        });

        it('a chain holding no copy of the tick carries the snapshot forward', async function(){
            const row = snapshot(ids, { block: [MEMBER_A] });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: {},     // no BTC.FUFU here yet
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyPolicySnapshot(row, ctx);

            assert.strictEqual(res.applied, false);
            assert.strictEqual(res.terminal, false,
                'a chain with no copy yet was made terminal, so a later transfer could never gain the policy');
            assert.deepStrictEqual(state.injected, []);
        });
    });

    // -----------------------------------------------------------------------------------
    // The federated half: a real PBFT policy round over a real multi-hub mesh.
    //
    // The engine only snapshots a policy for a (origin_chain, tick) pair it has SEEN, so a
    // pending FUFU lock leg is served first; the transfer round teaches the engine that BTC
    // is FUFU's origin, and the policy poll then reads the origin policy back through the
    // real gettokenpolicy client and PBFTs a snapshot over it.
    //
    // Needs a hub MariaDB (provisioned HUB_DB_* or Docker); it brings its own quorum and
    // needs no shared regtest chain rail.
    // -----------------------------------------------------------------------------------
    describe('the federation produces the snapshot (multi-hub PBFT)', function(){

        const COUNT        = 4;
        const PEER_WAIT_MS = 60_000;
        const ROUND_MS     = 25_000;
        const FED_SRC_IDX  = 6160;

        let db, mvh, seed, source, policyRow;

        before(async function(){
            db = await startDisposableHubDb();
            if(!db){
                console.log('Skipping the federated XPOLICY round: no env hub DB and Docker unavailable');
                this.skip();
            }

            const originPolicy = {
                allow_list:  null,
                block_list:  [MEMBER_A],
                sleeping:    false,
                // The origin indexer's own hash over its own membership. The engine
                // recomputes it and declines to sign when the two disagree, so serving it
                // correctly is what lets the round run at all.
                policy_hash: BS.policyHash(null, [MEMBER_A], false),
                bridged:     true
            };

            source = new BridgePendingSource();
            await source.start();
            source.setPending('shared', {
                network: NETWORK,
                latestBlockIndex: SNAPSHOT,
                transfersByCoin: {
                    BTC: [ BridgePendingSource.makeLeg({
                        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: FED_SRC_IDX,
                        src_address: 'mSourceAddressXXXXXXXXXXXXXXXXXXXX',
                        dest_chain: 'DOGE', dest_address: 'nDestinationAddressXXXXXXXXXXXXXXX',
                        tick: TICK, decimals: 4, amount: '5.0000',
                        block_index: SNAPSHOT - 50
                    }) ]
                },
                policiesByCoin: { BTC: { FUFU: originPolicy } }
            });

            mvh = new MultiValidatorHub({
                count: COUNT, basePort: 26700,
                startCrossChain: true, startAttestation: false,
                extraP2pConfig: { XDEX_SNAPSHOT_BLOCK: String(SNAPSHOT) }
            });
            await mvh.start();
            await waitForMesh(mvh, { timeoutMs: PEER_WAIT_MS });

            seed = seedWeightSnapshot(mvh, {
                blockIndex: SNAPSHOT, network: NETWORK,
                validators: mvh.identities.map((id, i) => ({
                    pubkey: id.pubkeyHex, source: 's' + i, weight: '1000'
                }))
            });

            for(const hub of mvh.hubs){
                const eng = hub.crossChainBridge;
                if(!eng || !eng.indexers) continue;
                eng.indexers.BTC  = { url: source.urlFor('shared', 'BTC'),  key: '' };
                eng.indexers.DOGE = { url: source.urlFor('shared', 'DOGE'), key: '' };
            }

            await Promise.all(mvh.hubs.map(h => h.crossChainBridge._poll().catch(() => {})));

            const held = await waitFor(async () => {
                let seen = 0;
                for(const hub of mvh.hubs){
                    try {
                        const r = await hub.db.doQuery(
                            "SELECT snapshot_id FROM policy_snapshots WHERE origin_chain = 'BTC' AND tick = ? AND status = 'finalized'",
                            [TICK]);
                        if(r.length >= 1) seen++;
                    } catch(_){ /* a hub that cannot be read has not persisted it */ }
                }
                return { ok: seen === mvh.hubs.length, seen: seen };
            }, { timeoutMs: ROUND_MS, intervalMs: 200 });

            if(held.ok){
                const rows = await mvh.hubs[0].db.doQuery(
                    'SELECT * FROM policy_snapshots WHERE origin_chain = ? AND tick = ? ORDER BY policy_seq ASC LIMIT 1',
                    ['BTC', TICK]);
                policyRow = rows[0];
            }
        });

        after(async function(){
            if(seed)   seed.restore();
            if(source) await source.stop();
            if(mvh)    { await mvh.stop(); await mvh.dropDatabases(); }
            if(db)     await db.stop();
        });

        it('finalizes a policy_snapshots row at seq 1 with a 2f+1 signature bundle', function(){
            assert.ok(policyRow, 'the federation finalized no policy_snapshots row');
            assert.strictEqual(policyRow.status, 'finalized');
            assert.strictEqual(Number(policyRow.policy_seq), 1);
            assert.strictEqual(String(policyRow.tick), TICK);
            assert.strictEqual(String(policyRow.origin_chain), 'BTC');
            assert.strictEqual(String(policyRow.policy_hash).toLowerCase(),
                BS.policyHash(null, [MEMBER_A], false),
                'the federated hash is not the hash of the membership the origin served');
            const sigs = JSON.parse(policyRow.validator_signatures || '[]');
            assert.ok(sigs.length >= 3, 'expected >= 3 federated signatures, got ' + sigs.length);
        });

        it('the federated snapshot passes the indexer settle pass and materializes the list', async function(){
            assert.ok(policyRow, 'no finalized snapshot from before()');
            const pubkeys = JSON.parse(policyRow.validator_signatures).map((s, i) => ({
                pubkey: s.pubkey, source: 'f' + i, weight: '1000'
            }));
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: pubkeys, tokens: copyRow(),
                blockIndex: BLOCK, blockTime: Number(policyRow.effective_time)
            });

            const res = await BS.applyPolicySnapshot(policyRow, ctx);

            assert.strictEqual(res.applied, true,
                'the indexer refused a genuinely federated snapshot (hash or canonical drift?): ' + res.reason);
            const fields = legs(state).map(l => l.fields);
            assert.deepStrictEqual(fields[0], ['LIST', '0', '2', '', MEMBER_A],
                'the materialized list is not the membership the origin served');
            assert.strictEqual(state.settlements[0].transfer_id, policyRow.snapshot_id);
        });
    });
});
