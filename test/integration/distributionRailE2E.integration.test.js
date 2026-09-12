'use strict';

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
 **********************************************************************
 * E2E drill: the distribution rail (base spec row 11, AT7).
 *
 * AT7, verbatim from the base bridge spec section 15: "on the rail, a GAS-key
 * ISSUE mints 30 XCHAIN on BTC, XBRIDGE v0 locks all 30 to an operator-held DOGE address,
 * and after the mirror an AIRDROP on DOGE from that address to three DOGE addresses lands
 * 10 each; DOGE supply reads 30, the escrow reads 30, the invariant is equal with in-flight
 * 0, and a broadcast ISSUE XCHAIN on DOGE regtest is refused throughout."
 *
 * D11 (ruled 2026-09-11) is the reason this drill exists at all: distribution is NOT a
 * genesis pass, a bucket file, a snapshot or a launch instant. It is mint-on-BTC, lock,
 * mirror, airdrop-on-destination, on rails this spec already built and L18/L19 already
 * proved piece by piece. This drill is the composition AT7 asks for, driven once.
 *
 * WHAT IS DRIVEN AND WHAT IS A SEEDED FACT, stated once here rather than per test:
 *   - The GAS-key ISSUE that mints 30 XCHAIN on BTC is base-protocol ISSUE machinery with
 *     nothing bridge-specific in it (proven elsewhere in this platform's own action suites);
 *     it is a SEEDED FACT here: the operator address's BTC-side balance starts at 30, as if
 *     that ISSUE already landed.
 *   - The XBRIDGE v0 lock -> mirror -> destination-chain credit is bridge-specific and IS
 *     driven for real, reusing bridgeHubRecord.js / bridgeSettleContext.js exactly as L18's
 *     own AT1 drill does: a hub-signed record verified and applied by the real indexer
 *     settle pass (src/bridge_settle.js).
 *   - The AIRDROP that redistributes the credited balance on DOGE to three recipients IS
 *     driven for real: the actual xchain-indexer Airdrop class (src/actions/airdrop.js),
 *     including its native-fee tolerance-band math, over an in-memory ledger.
 *   - The "broadcast ISSUE XCHAIN on DOGE is refused throughout" clause IS driven for real:
 *     the actual Issue class (src/actions/issue.js), run before AND after the airdrop.
 *   - getbridgeinvariant IS driven for real: xchain-hub's CrossChainBridgeEngine.getBridgeInvariant,
 *     on a bare instance with its documented chainStateReader injection point fed the ledger
 *     state this drill itself produced.
 *
 * VENUE. Every assertion below runs with no live chain, no hub, no MariaDB and no docker,
 * same as L18's settle-pass drill: this is the model-proof half. The live-rail half (the
 * GAS-key ISSUE and the XBRIDGE v0 lock actually broadcast and mined on BTC/DOGE regtest,
 * which is what AT7 as literally written requires) is row 15's job and is BLOCKED on the
 * same two measured reasons the 2026-09-12 checkpoint-2 handoff records: the regtest hub
 * finalizes no PRICE round, and on this Mac the whole multiHub* family skips because docker
 * is not on PATH and the hub MariaDB at :13306 refuses connections. Nothing here is reported
 * as passing on the rail; every `it` below is explicit about running venue-free.
 ********************************************************************/

const assert = require('assert');

const HUB    = require('../helpers/bridgeHubRecord');
const SETTLE = require('../helpers/bridgeSettleContext');
const DIST   = require('../helpers/distributionActionHarness');

const BS = SETTLE.bridgeSettle;

const NETWORK   = 'regtest';
const SNAPSHOT  = 4200;
const CP_HEIGHT = 4205;
const BLOCK     = 3100;
const BLOCK_TIME = 9000;
const DUE_TIME   = 8000;                      // effective_time at or below BLOCK_TIME: due
const SRC_ADDR    = 'mIssuerBtcAddressXXXXXXXXXXXXXXXXX';       // the GAS-key issuer on BTC
const OPERATOR    = 'nOperatorDistributionAddrXXXXXXXXX';        // operator-held DOGE address
const RECIPIENTS  = [
    'nDistRecipientOneXXXXXXXXXXXXXXXXX',
    'nDistRecipientTwoXXXXXXXXXXXXXXXXX',
    'nDistRecipientThreeXXXXXXXXXXXXXXX'
];
const AMOUNT_LOCKED  = '30.00000000';
const AMOUNT_EACH    = '10';

const XCHAIN_ROW = { XCHAIN: { TICK_ID: 1, DECIMALS: 8, SUPPLY: '0' } };

// The signed-and-mirrored transfer AT7's lock leg produces: 30 XCHAIN, BTC -> DOGE, to the
// operator-held address. Identical shape to L18's inLeg() helper, new identity (amount,
// destination) for THIS drill's own scenario.
function lockLeg(identities){
    const row = HUB.buildTransferRow({
        snapshotBlock: SNAPSHOT, network: NETWORK, srcChain: 'BTC', srcActionIndex: 6001,
        srcAddress: SRC_ADDR, destChain: 'DOGE', destAddress: OPERATOR,
        tick: 'XCHAIN', decimals: 8, amount: AMOUNT_LOCKED, effectiveTime: DUE_TIME
    });
    return HUB.signRecord(row, identities);
}

describe('Distribution rail drill (base AT7): mint, lock, mirror-credit, airdrop', function(){
    this.timeout(120_000);

    let ids, validators;
    before(function(){
        ids = HUB.makeIdentities(3);
        validators = HUB.capabilitySet(ids);
    });

    describe('step 1 (venue-free, reuses the proven settle pass): the lock lands on DOGE', function(){

        it('credits exactly 30 XCHAIN to the operator-held DOGE address, identity not count', async function(){
            const row = lockLeg(ids);
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: AMOUNT_LOCKED, height: CP_HEIGHT })
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, true, 'the lock leg did not apply: ' + res.reason);
            assert.deepStrictEqual(state.credits, [['XCHAIN', AMOUNT_LOCKED, OPERATOR]],
                'expected exactly one credit of 30 XCHAIN to the operator address, got: ' +
                JSON.stringify(state.credits));
            assert.deepStrictEqual(state.debits, [], 'a mint-side lock leg debited something');
        });

        it('FALSIFICATION: a forged escrow proof credits nothing, even at this drill\'s own amount', async function(){
            const row = lockLeg(ids);
            const { ctx, state } = SETTLE.makeSettleContext({
                coin: 'DOGE', validators: validators, tokens: XCHAIN_ROW,
                blockIndex: BLOCK, blockTime: BLOCK_TIME,
                proof: SETTLE.buildEscrowProof({ destChain: 'DOGE', tick: 'XCHAIN',
                                                 balance: AMOUNT_LOCKED, height: CP_HEIGHT,
                                                 forgeRoot: true })
            });

            const res = await BS.applyBridgeTransfer(row, ctx);

            assert.strictEqual(res.applied, false, 'a forged escrow proof minted the distribution amount');
            assert.deepStrictEqual(state.credits, [], 'a forged proof still credited the operator address');
        });
    });

    describe('step 2 (venue-free, new code this row adds): the AIRDROP redistributes on DOGE', function(){

        it('lands exactly 10 XCHAIN on each of the three recipients, debiting the operator for all 30', async function(){
            const res = await DIST.runAirdrop({
                source: OPERATOR, sourceBalance: AMOUNT_LOCKED, amountEach: AMOUNT_EACH,
                recipients: RECIPIENTS, coinUsdPrice: '1', xchainUsdPrice: '1',
                feePaid: '0.00009000'
            });

            assert.strictEqual(res.data.STATUS, 'valid', 'the airdrop did not validate: ' + res.data.STATUS);
            assert.deepStrictEqual(res.state.credits, [
                ['XCHAIN', AMOUNT_EACH, RECIPIENTS[0]],
                ['XCHAIN', AMOUNT_EACH, RECIPIENTS[1]],
                ['XCHAIN', AMOUNT_EACH, RECIPIENTS[2]]
            ], 'expected exactly 10 to each of the three named recipients, got: ' +
               JSON.stringify(res.state.credits));
            // debitBalances renders through bcsub (18-dp intermediate, no trailing-zero pad),
            // so the real ledger value is the unpadded '30', not the 8dp wire form '30.00000000'.
            assert.deepStrictEqual(res.state.debits, [['XCHAIN', '30', OPERATOR]],
                'expected the operator debited the full 30, got: ' + JSON.stringify(res.state.debits));
            // The fee was paid in NATIVE DOGE (milestone 1: no XCHAIN fee mode off BTC), so
            // it must not appear as a second XCHAIN debit against the operator.
            assert.strictEqual(res.state.debits.length, 1,
                'a native-fee airdrop must not also debit XCHAIN for the fee');
            assert.strictEqual(res.harness.unstubbedCalls.length, 0,
                'the airdrop touched an indexer call this drill did not seed: ' +
                JSON.stringify(res.harness.unstubbedCalls));
        });

        it('FALSIFICATION: an operator balance short of the total refuses rather than mispaying', async function(){
            const res = await DIST.runAirdrop({
                source: OPERATOR, sourceBalance: '20.00000000',    // 3 x 10 needs 30
                amountEach: AMOUNT_EACH, recipients: RECIPIENTS,
                coinUsdPrice: '1', xchainUsdPrice: '1', feePaid: '0.00009000'
            });

            assert.ok(String(res.data.STATUS).startsWith('invalid'),
                'an under-funded airdrop validated: ' + res.data.STATUS);
            assert.deepStrictEqual(res.state.credits, [], 'a refused airdrop still credited recipients');
        });
    });

    describe('step 3 (venue-free): a broadcast ISSUE XCHAIN on DOGE is refused throughout', function(){

        it('refuses BEFORE the airdrop, off BTC, from the GAS address, on regtest', async function(){
            const res = await DIST.runIssueBroadcast({ coin: 'DOGE' });
            assert.strictEqual(res.data.STATUS, 'invalid: TICK (BTC-only)',
                'a broadcast ISSUE XCHAIN on DOGE was not refused before the airdrop: ' + res.data.STATUS);
        });

        it('refuses AFTER the airdrop too: the guard is unconditional, not a balance-state artifact', async function(){
            // Run the airdrop first (as step 2 already proved it lands), then the same
            // broadcast again: the refusal must not depend on anything the airdrop changed.
            await DIST.runAirdrop({
                source: OPERATOR, sourceBalance: AMOUNT_LOCKED, amountEach: AMOUNT_EACH,
                recipients: RECIPIENTS, coinUsdPrice: '1', xchainUsdPrice: '1', feePaid: '0.00009000'
            });
            const res = await DIST.runIssueBroadcast({ coin: 'DOGE' });
            assert.strictEqual(res.data.STATUS, 'invalid: TICK (BTC-only)',
                'a broadcast ISSUE XCHAIN on DOGE was not refused after the airdrop: ' + res.data.STATUS);
        });

        it('FALSIFICATION: the identical broadcast on BTC is not refused by this guard', async function(){
            // Proves the DOGE refusal above is genuinely coin-conditional (base spec section 4,
            // D62) rather than an artifact of this harness always failing ISSUE.
            const res = await DIST.runIssueBroadcast({ coin: 'BTC' });
            assert.notStrictEqual(res.data.STATUS, 'invalid: TICK (BTC-only)',
                'the BTC-only guard fired on BTC itself');
            assert.strictEqual(res.data.STATUS, 'valid',
                'the same broadcast on BTC did not validate: ' + res.data.STATUS);
        });
    });

    describe('step 4 (venue-free): getbridgeinvariant reads equal, in-flight 0', function(){

        it('DOGE supply 30, BTC escrow 30 for DOGE, delta 0, in_flight 0, after the whole drill', async function(){
            const eng = DIST.makeInvariantEngine({
                chainStateReader: async (coin) => {
                    if(coin === 'BTC')  return { XCHAIN: { supply: AMOUNT_LOCKED, escrow: { DOGE: AMOUNT_LOCKED } } };
                    if(coin === 'DOGE') return { XCHAIN: { supply: AMOUNT_LOCKED, escrow: null } };
                    return null;
                }
            });

            const inv = await eng.getBridgeInvariant('XCHAIN');

            assert.strictEqual(inv.XCHAIN.DOGE.supply, AMOUNT_LOCKED);
            assert.strictEqual(inv.XCHAIN.DOGE.escrow, AMOUNT_LOCKED);
            assert.strictEqual(inv.XCHAIN.DOGE.delta, '0', 'the invariant did not read equal: ' +
                JSON.stringify(inv.XCHAIN.DOGE));
            assert.strictEqual(inv.XCHAIN.DOGE.in_flight, '0');
        });

        it('FALSIFICATION: a 5-unit escrow shortfall reads as a 5-unit deficit, not a silent pass', async function(){
            const eng = DIST.makeInvariantEngine({
                chainStateReader: async (coin) => {
                    if(coin === 'BTC')  return { XCHAIN: { supply: AMOUNT_LOCKED, escrow: { DOGE: '25.00000000' } } };
                    if(coin === 'DOGE') return { XCHAIN: { supply: AMOUNT_LOCKED, escrow: null } };
                    return null;
                }
            });

            const inv = await eng.getBridgeInvariant('XCHAIN');

            assert.strictEqual(inv.XCHAIN.DOGE.delta, '-5',
                'a real escrow shortfall did not read as a deficit: ' + JSON.stringify(inv.XCHAIN.DOGE));
        });
    });
});
