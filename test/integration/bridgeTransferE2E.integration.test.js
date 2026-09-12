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
 * XBRIDGE transfer: a hub-signed record applied by the indexer settle pass, end to end.
 *
 * Base spec acceptance tests AT1 (lock to mint), AT2 (burn to escrow release), AT4
 * (falsification) and the token spec's AT1, AT2 and AT5 (tick and decimals binding),
 * driven as far as a venue-free harness can drive them. The shape is
 * multiHubCrossSettleE2E's: a record that one repository FINALIZES is handed to the other
 * repository's real apply path, so the two halves of a consensus rule are proven to agree.
 *
 * WHY THIS EXISTS BESIDE THE INDEXER'S OWN bridge_settle SUITE. That suite signs its
 * fixtures over bridge_settle.js's OWN canonical, so it proves the module is
 * self-consistent and can say nothing about the hub. The hub's engine suite has the mirror
 * image of the same blind spot. The canonical is a cross-repository byte-match obligation
 * forever: the day the two drift, every transfer on the platform stops verifying while
 * both suites stay green. Every record below is derived and signed with xchain-hub's
 * CrossChainBridgeEngine and ValidatorIdentity and verified by xchain-indexer's settle
 * pass, which is the only place that drift is visible.
 *
 * WHAT RUNS WHERE.
 *   - The cross-repo and apply cases need no chain rail, no indexer and no hub database.
 *     They run wherever the two sibling repositories are checked out.
 *   - The federated case boots a real MultiValidatorHub mesh, which needs a hub MariaDB
 *     (provisioned HUB_DB_* or Docker) and skips loudly without one. It is the only case
 *     here that exercises PBFT itself; the rest exercise what PBFT produces.
 *
 * The end-to-end AT1/AT2 readouts on the BTC/DOGE regtest rail (real locks,
 * real confirmations, real mirror) are spec row 15 and are NOT claimed by this file.
 ********************************************************************/

'use strict';

const dotenv = require('dotenv');
dotenv.config();

const assert = require('assert');
const crypto = require('crypto');

const HUB = require('../helpers/bridgeHubRecord');
const SETTLE = require('../helpers/bridgeSettleContext');
const { startDisposableHubDb } = require('../helpers/disposableHubDb');
const { seedWeightSnapshot }   = require('../helpers/seededWeightSnapshot');
const { MultiValidatorHub }    = require('../helpers/multiValidatorHubHelper');
const { BridgePendingSource }  = require('../helpers/bridgePendingSource');
const { waitForMesh, waitFor } = require('../helpers/consensusWait');

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

describe('XBRIDGE transfer: hub-signed record to indexer settle pass (base AT1, AT2, AT4; token AT1, AT2, AT5)', function(){
    this.timeout(240_000);

    let ids, validators;

    before(function(){
        ids = HUB.makeIdentities(3);
        validators = HUB.capabilitySet(ids);
    });

    describe('the cross-repository seam', function(){

        it('derives the transfer_id the base spec names, from the spec preimage', function(){
            const row = inLeg(ids);
            // The preimage is written out here rather than read back from the hub helper:
            // asserting the engine's id against the engine's own derivation would pass
            // however the preimage was rewritten, which is the one thing that must not move.
            const expected = sha256([
                NETWORK,
                'BTC:4242',
                'DOGE:' + DEST_ADDR,
                String(SNAPSHOT)
            ].join('|'));
            assert.strictEqual(row.transfer_id, expected,
                'the hub derives a transfer_id the base spec preimage does not produce');
        });

        it('signs the canonical the indexer rebuilds, byte for byte', function(){
            const row = inLeg(ids);
            const hubSide     = HUB.hubCanonical(row);
            const indexerSide = BS.transferCanonical(row);
            assert.strictEqual(indexerSide, hubSide,
                'hub CrossChainBridgeEngine._canonicalMatch and indexer transferCanonical disagree');
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

    describe('base AT1: the IN leg mints on the destination chain', function(){

        it('credits the exact address the record names, at the signed amount, and records the settlement', async function(){
            const row = inLeg(ids);
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: '50', height: CP_HEIGHT })
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, true, 'a hub-signed in leg did not apply: ' + res.reason);
            // Identity, not a count: this tick, this literal amount, this address.
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
            assert.deepStrictEqual(state.debits, [], 'an in leg debited something');
            assert.strictEqual(state.settlements.length, 1);
            assert.strictEqual(state.settlements[0].transfer_id, row.transfer_id);
            assert.strictEqual(state.settlements[0].kind, 'transfer');
            assert.strictEqual(state.settlements[0].block_index, BLOCK);
            // FORMAT 2 is the XCHAIN settle leg; 5 is a general token's.
            assert.strictEqual(state.actions[0].FORMAT, 2, 'the injected settle action is not XBRIDGE v2');
        });

        it('creates the XCHAIN row lazily on a chain that holds none', async function(){
            const row = inLeg(ids);
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: {},       // no XCHAIN row here
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: '50', height: CP_HEIGHT })
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, true, 'the lazy-creation in leg did not apply: ' + res.reason);
            assert.strictEqual(state.injected.length, 1, 'expected exactly one injected token row');
            const tx = state.injected[0];
            assert.strictEqual(tx.isGenesis, true,
                'the injected row did not carry IS_GENESIS, so it would hit the off-BTC ISSUE refusal');
            const fields = tx.data.split('|');
            assert.strictEqual(fields[0], 'ISSUE');
            assert.strictEqual(fields[2], 'XCHAIN', 'the lazily created row is not the GAS tick');
            assert.deepStrictEqual(state.credits, [['XCHAIN', '10.00000000', DEST_ADDR]]);
        });

        it('refuses a FORGED escrow proof and moves nothing (D2)', async function(){
            const row = inLeg(ids);
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                // A well-formed envelope whose checkpoint commits a state root the escrow
                // leaf is not under: the forgery a mint must never be built on.
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: '50', height: CP_HEIGHT, forgeRoot: true })
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, false, 'a forged escrow proof minted units');
            assert.deepStrictEqual(state.credits, [], 'a forged proof still credited');
            assert.deepStrictEqual(state.settlements, [], 'a forged proof still recorded a settlement');
        });

        it('refuses an in leg with no proof at all, rather than defaulting open', async function(){
            const row = inLeg(ids);
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, false, 'an in leg minted with no escrow proof');
            assert.deepStrictEqual(state.credits, []);
        });
    });

    describe('base AT2: the OUT leg releases escrow on the origin chain', function(){

        it('debits the escrow role address and credits the address the burn named', async function(){
            const row = outLeg(ids);
            const { ctx, state, config } = SETTLE.makeSettleContext({
                coin: 'BTC', validators: validators, tokens: XCHAIN_ROW,
                balances: { 7: '5.00000000' },          // the escrow holds 5, the burn asks 2
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, true, 'a hub-signed out leg did not apply: ' + res.reason);
            assert.deepStrictEqual(state.debits,
                [['XCHAIN', '2.00000000', config.ADDRESS.BRIDGE_DOGE]],
                'the release did not debit the DOGE escrow role address on BTC');
            assert.deepStrictEqual(state.credits, [['XCHAIN', '2.00000000', BTC_ADDR]]);
            assert.strictEqual(state.settlements[0].transfer_id, row.transfer_id);
        });

        it('an escrow short of the amount moves nothing (AT4)', async function(){
            const row = outLeg(ids);
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'BTC', validators: validators, tokens: XCHAIN_ROW,
                balances: { 7: '1.00000000' },          // one unit short of the 2 released
                blockIndex: BLOCK, blockTime: BLOCK_TIME
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, false, 'an out leg drained the escrow past zero');
            assert.deepStrictEqual(state.debits, []);
            assert.deepStrictEqual(state.credits, []);
            assert.deepStrictEqual(state.settlements, [],
                'a refused out leg still recorded a settlement, which would make it unretryable');
        });
    });

    describe('base AT4: falsification of a mirrored record', function(){

        // Each case moves ONE property of a record that is otherwise exactly the record the
        // happy path applied, and asserts the LEDGER, not the reason string: a reason the
        // module also defines would prove nothing about the guard.
        const cases = [
            {
                name: 'a bundle signed over other bytes',
                build: () => HUB.signRecord(inLeg([]), ids, {
                    message: HUB.hubCanonical(Object.assign(inLeg([]), { dest_address: 'nAttacker' }))
                })
            },
            {
                name: 'a signer outside the capability snapshot',
                build: () => HUB.signRecord(inLeg([]), HUB.makeIdentities(3))
            },
            {
                name: 'a foreign network',
                build: () => inLeg(ids, { network: 'testnet' })
            },
            {
                name: 'a status that is not finalized',
                build: () => inLeg(ids, { status: 'retracted' })
            },
            {
                name: 'a destination chain that is not this chain',
                build: () => inLeg(ids, { destChain: 'LTC' })
            }
        ];

        cases.forEach((c) => {
            it('applies nothing for ' + c.name, async function(){
                const { ctx, state } = SETTLE.makeSettleContext({
                    coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                    blockIndex: BLOCK, blockTime: BLOCK_TIME,
                    proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                     balance: '50', height: CP_HEIGHT })
                });

                const res = await BS.applyBridgeTransfer(c.build(), ctx);

                assert.strictEqual(res.applied, false, c.name + ' was applied');
                assert.deepStrictEqual(state.credits, [], c.name + ' credited');
                assert.deepStrictEqual(state.debits, [], c.name + ' debited');
                assert.deepStrictEqual(state.settlements, [], c.name + ' recorded a settlement');
            });
        });

        it('applies nothing for a foreign btc_chain_id', async function(){
            const row = inLeg(ids, { btcChainId: 'f'.repeat(64) });
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                chainId: '0'.repeat(64),            // this node's own chain identity
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: '50', height: CP_HEIGHT })
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, false, 'a record minted on a dead chain instance applied');
            assert.deepStrictEqual(state.credits, []);
        });

        it('does not apply a record twice (the local settlement record, not the mirror)', async function(){
            const row = inLeg(ids);
            const seeded = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                settled: [row.transfer_id + '|transfer'],
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: '50', height: CP_HEIGHT })
            });

            const res = await BS.applyBridgeTransfer(row, seeded.ctx);

            assert.strictEqual(res.applied, false, 'an already-settled transfer minted a second time');
            assert.deepStrictEqual(seeded.state.credits, []);
        });
    });

    describe('token AT1, AT2 and AT5: a general token leg', function(){

        const TOKEN_AMOUNT = '5.0000';

        function tokenInLeg(identities, overrides){
            const row = HUB.buildTransferRow(Object.assign({
                snapshotBlock: SNAPSHOT, srcChain: 'BTC', srcActionIndex: 9001, srcAddress: SRC_ADDR,
                destChain: 'DOGE', destAddress: DEST_ADDR, tick: 'FUFU', decimals: 4,
                amount: TOKEN_AMOUNT, effectiveTime: DUE_TIME, network: NETWORK
            }, overrides || {}));
            return HUB.signRecord(row, identities);
        }

        it('creates the BTC root and the BTC.FUFU child owned by the bridge role address, then credits the child', async function(){
            const row = tokenInLeg(ids);
            const { ctx, state, config } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: {},
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'FUFU',
                                                 balance: '50', height: CP_HEIGHT })
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, true, 'a hub-signed token in leg did not apply: ' + res.reason);
            assert.strictEqual(state.injected.length, 2,
                'expected the <ORIGIN> root and the <ORIGIN>.<NAME> child, saw ' + state.injected.length);
            const ticks = state.injected.map(t => t.data.split('|')[2]);
            assert.deepStrictEqual(ticks, ['BTC', 'BTC.FUFU'],
                'the injected rows are not the root then the child: ' + ticks.join(', '));
            state.injected.forEach(t => assert.strictEqual(t.source, config.ADDRESS.BRIDGE_BTC,
                'a bridged row was not created by the BTC bridge role address on DOGE'));
            // The credit lands on the ROOTED name, never on the origin's native name: a
            // credit to bare FUFU would collide with a DOGE-native FUFU.
            assert.deepStrictEqual(state.credits, [['BTC.FUFU', TOKEN_AMOUNT, DEST_ADDR]]);
            assert.strictEqual(state.actions[0].FORMAT, 5, 'a token settle leg is not XBRIDGE v5');
        });

        it('AT5: signed decimals that disagree with an existing child row holding supply apply nothing', async function(){
            const row = tokenInLeg(ids);        // signed decimals 4
            const { ctx, state, config } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators,
                tokens: {
                    'BTC':      { TICK_ID: 20, DECIMALS: 0, SUPPLY: '0',
                                  OWNER: SETTLE.ROLE_ADDRESSES.BRIDGE_BTC },
                    'BTC.FUFU': { TICK_ID: 21, DECIMALS: 8, SUPPLY: '5.00000000',
                                  OWNER: SETTLE.ROLE_ADDRESSES.BRIDGE_BTC }
                },
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'FUFU',
                                                 balance: '50', height: CP_HEIGHT })
            });
            assert.strictEqual(config.ADDRESS.BRIDGE_BTC, SETTLE.ROLE_ADDRESSES.BRIDGE_BTC);

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, false,
                're-precisioning a bridged row that already holds supply was allowed');
            assert.deepStrictEqual(state.credits, [], 'a decimals-mismatched leg still credited');
            assert.deepStrictEqual(state.settlements, []);
        });
    });

    describe('the federation client and the pending read it polls', function(){

        // These drive the REAL engine client (CrossChainBridgeEngine._indexerCall,
        // _recordPending, _effectiveDepth) over real HTTP against the pending source, with
        // no hub, no database and no mesh. Without them the federated block below would be
        // the only thing standing between a mock that drifted from api.js and a round that
        // is silently vacuous on every venue that can run it.

        let source;

        before(async function(){
            source = new BridgePendingSource();
            await source.start();
            source.setPending('shared', {
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
            });
        });

        after(async function(){ if(source) await source.stop(); });

        it('answers getpendingbridgetransfers in the shape the engine parses', async function(){
            const eng = HUB.hubEngine();
            eng.indexers = { BTC: { url: source.urlFor('shared', 'BTC'), key: '' } };

            const res = await eng._indexerCall('BTC', 'getpendingbridgetransfers', { limit: 100 });

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
            const derived = eng._deriveTransferId(res.network, 'BTC', leg.src_action_index,
                                                  leg.dest_chain, leg.dest_address, SNAPSHOT);
            assert.strictEqual(derived, inLeg(ids).transfer_id,
                'a leg served here derives a different transfer_id than the record under test');
        });

        it('a MIN_DEPTH raises the confirmation wait and can never lower it (token AT5)', function(){
            const eng = HUB.hubEngine();
            // The platform depths the base spec names, as coins.resolveConfirmations gives
            // them to the engine.
            eng.confirmations = { BTC: 6, LTC: 12, DOGE: 60 };

            assert.strictEqual(eng._effectiveDepth('BTC', 0), 6, 'an unset MIN_DEPTH moved the platform depth');
            assert.strictEqual(eng._effectiveDepth('BTC', 3), 6,
                'a MIN_DEPTH below the platform depth LOWERED the wait, which an issuer must never be able to do');
            assert.strictEqual(eng._effectiveDepth('BTC', 12), 12, 'a MIN_DEPTH above the platform depth did not raise it');
            assert.strictEqual(eng._effectiveDepth('DOGE', 3), 60, 'the DOGE platform depth was lowered');
            assert.strictEqual(eng._effectiveDepth('BTC', 'nonsense'), 6, 'a junk MIN_DEPTH did not fall back to the platform depth');
        });

        it('serves the origin policy read, and answers an unknown tick with an error the engine abstains on', async function(){
            const eng = HUB.hubEngine();
            eng.indexers = { BTC: { url: source.urlFor('shared', 'BTC'), key: '' } };

            const known = await eng._indexerCall('BTC', 'gettokenpolicy', { tick: 'FUFU', origin_block: 1150 });
            assert.strictEqual(known.policy_hash, BS.policyHash(null, null, false));
            assert.strictEqual(known.origin_block, 1150, 'the read did not answer at the block it was asked for');
            assert.strictEqual(known.sleeping, false);

            const unknown = await eng._indexerCall('BTC', 'gettokenpolicy', { tick: 'NOSUCH', origin_block: 1150 });
            assert.ok(unknown && unknown.error,
                'a tick with no native row answered without an error, so the engine would sign a phantom policy');

            const tip = await eng._indexerCall('BTC', 'getlatestblock', {});
            assert.strictEqual(Number(tip.block_index), SNAPSHOT,
                'the tip read does not answer block_index, so _policyOriginBlock would abstain forever');
        });
    });

    // -----------------------------------------------------------------------------------
    // The federated half: a real PBFT round over a real multi-hub mesh.
    //
    // Everything above proves the two repositories agree about a record. This proves the
    // federation PRODUCES that record: four hubs discover a confirmed leg through the real
    // getpendingbridgetransfers client, independently re-validate it, and PBFT it to a
    // persisted bridge_transfers row, which is then applied by the same indexer pass.
    //
    // Needs a hub MariaDB (provisioned HUB_DB_* or Docker). It brings its own quorum and
    // its own validator registry, so it does NOT need the shared regtest chain rail.
    // -----------------------------------------------------------------------------------
    describe('the federation produces the record (multi-hub PBFT)', function(){

        const COUNT        = 4;
        const PEER_WAIT_MS = 60_000;
        const ROUND_MS     = 20_000;
        const FED_AMOUNT   = '7.00000000';
        const FED_SRC_IDX  = 5150;

        let db, mvh, seed, source, transferRow;

        before(async function(){
            db = await startDisposableHubDb();
            if(!db){
                console.log('Skipping the federated XBRIDGE round: no env hub DB and Docker unavailable');
                this.skip();
            }

            source = new BridgePendingSource();
            await source.start();
            source.setPending('shared', {
                network: NETWORK,
                latestBlockIndex: SNAPSHOT,
                transfersByCoin: {
                    BTC: [ BridgePendingSource.makeLeg({
                        transfer_kind: 'lock', src_chain: 'BTC', src_action_index: FED_SRC_IDX,
                        src_address: SRC_ADDR, dest_chain: 'DOGE', dest_address: DEST_ADDR,
                        tick: 'XCHAIN', decimals: 8, amount: FED_AMOUNT,
                        // Well below SNAPSHOT so the leg is past BTC's regtest depth however
                        // the venue resolves confirmations.
                        block_index: SNAPSHOT - 50
                    }) ]
                }
            });

            mvh = new MultiValidatorHub({
                count: COUNT, basePort: 26500,
                startCrossChain: true, startAttestation: false,
                // The bridge engine reads its anchor from the hub's BTC latest block, which
                // seedWeightSnapshot pins below; the override is the no-BTC fallback and is
                // set so the engine never idles on a null anchor before the seed lands.
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

            // Point every hub's BRIDGE engine at the pending source. The harness repoints
            // the DEX engine's map only, and the bridge engine resolved its own (empty) map
            // at construction, so it is repointed here the same way.
            for(const hub of mvh.hubs){
                const eng = hub.crossChainBridge;
                if(!eng || !eng.indexers) continue;
                eng.indexers.BTC  = { url: source.urlFor('shared', 'BTC'),  key: '' };
                eng.indexers.DOGE = { url: source.urlFor('shared', 'DOGE'), key: '' };
            }

            await Promise.all(mvh.hubs.map(h => h.crossChainBridge._poll().catch(() => {})));

            // Poll the PERSISTED row on every hub rather than a finalize event: the write is
            // started by an un-awaited handler, so an event-count poll clears while the
            // INSERT is still in flight (the trap multiHubCrossSettleE2E documents).
            const held = await waitFor(async () => {
                let seen = 0;
                for(const hub of mvh.hubs){
                    try {
                        const r = await hub.db.doQuery(
                            "SELECT transfer_id FROM bridge_transfers WHERE src_chain = 'BTC' AND src_action_index = ? AND status = 'finalized'",
                            [FED_SRC_IDX]);
                        if(r.length >= 1) seen++;
                    } catch(_){ /* a hub that cannot be read has not persisted it */ }
                }
                return { ok: seen === mvh.hubs.length, seen: seen };
            }, { timeoutMs: ROUND_MS, intervalMs: 200 });

            if(held.ok){
                const rows = await mvh.hubs[0].db.doQuery(
                    'SELECT * FROM bridge_transfers WHERE src_chain = ? AND src_action_index = ? LIMIT 1',
                    ['BTC', FED_SRC_IDX]);
                transferRow = rows[0];
            }
        });

        after(async function(){
            if(seed)   seed.restore();
            if(source) await source.stop();
            if(mvh)    { await mvh.stop(); await mvh.dropDatabases(); }
            if(db)     await db.stop();
        });

        it('finalizes a bridge_transfers row carrying a 2f+1 signature bundle', function(){
            assert.ok(transferRow, 'the federation finalized no bridge_transfers row');
            assert.strictEqual(transferRow.status, 'finalized');
            assert.strictEqual(String(transferRow.tick), 'XCHAIN');
            assert.strictEqual(String(transferRow.dest_address), DEST_ADDR);
            assert.strictEqual(String(transferRow.src_chain), 'BTC');
            assert.strictEqual(Number(transferRow.src_action_index), FED_SRC_IDX);
            const sigs = JSON.parse(transferRow.validator_signatures || '[]');
            assert.ok(sigs.length >= 3, 'expected >= 3 federated signatures, got ' + sigs.length);
        });

        it('the federated row passes the indexer settle pass and mints the exact credit', async function(){
            assert.ok(transferRow, 'no finalized row from before()');
            const pubkeys = JSON.parse(transferRow.validator_signatures).map((s, i) => ({
                pubkey: s.pubkey, source: 'f' + i, weight: '1000'
            }));
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: pubkeys, tokens: XCHAIN_ROW,
                blockIndex: BLOCK,
                // The row's own effective_time carries the hub's relay margin, so the
                // applying block's protocol time is taken from it rather than from a
                // constant that would make the row perpetually not-yet-due.
                blockTime: Number(transferRow.effective_time),
                proof: SETTLE.buildEscrowProof({
                    destChain: 'DOGE', tick: 'XCHAIN', balance: '50',
                    height: Number(transferRow.snapshot_block)
                })
            });

            const res = await BS.applyBridgeTransfer(transferRow, ctx);

            assert.strictEqual(res.applied, true,
                'the indexer refused a genuinely federated record (canonical or quorum drift?): ' + res.reason);
            assert.deepStrictEqual(state.credits, [['XCHAIN', FED_AMOUNT, DEST_ADDR]]);
            assert.strictEqual(state.settlements[0].transfer_id, transferRow.transfer_id);
        });

        it('a tampered federated bundle applies nothing', async function(){
            assert.ok(transferRow, 'no finalized row from before()');
            const tampered = Object.assign({}, transferRow);
            tampered.validator_signatures = JSON.stringify(
                JSON.parse(transferRow.validator_signatures).map(s => ({
                    pubkey: s.pubkey,
                    sig: String(s.sig).slice(0, -1) + (String(s.sig).slice(-1) === '0' ? '1' : '0')
                })));
            const pubkeys = JSON.parse(transferRow.validator_signatures).map((s, i) => ({
                pubkey: s.pubkey, source: 'f' + i, weight: '1000'
            }));
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: pubkeys, tokens: XCHAIN_ROW,
                blockIndex: BLOCK, blockTime: Number(transferRow.effective_time),
                proof: SETTLE.buildEscrowProof({
                    destChain: 'DOGE', tick: 'XCHAIN', balance: '50',
                    height: Number(transferRow.snapshot_block)
                })
            });

            const res = await BS.applyBridgeTransfer(tampered, ctx);

            assert.strictEqual(res.applied, false, 'a tampered federated bundle was applied');
            assert.deepStrictEqual(state.credits, []);
        });
    });
});
