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
 * XChain Platform E2E - pre-flight FALSE-BLOCK invariant harness
 * (spec claude/reports/confirm-decode-preflight/SPEC.md §8.2).
 *
 * THE release-gating invariant: a pre-flight `error` must NEVER block
 * an action the indexer would accept. This suite proves it against the
 * live regtest stack in three classes:
 *
 *   (a) chain-observable: build an action the indexer ACCEPTS, run
 *       pre-flight in 'report' mode, and assert it produced no
 *       non-overridable error. (A non-overridable error on an accepted
 *       action is the CI failure.) A sample of `pass` verdicts is then
 *       actually broadcast and confirmed `valid` to bound false-allows.
 *
 *   (b) intra-BATCH sequential: a MINT-then-SEND-the-minted batch the
 *       indexer accepts must not error on the SEND leg (the §4.7
 *       projected-delta rule).
 *
 *   (c) REAL on-chain references (added 2026-07-26 after ): build
 *       the dispenser / list on chain, then pre-flight an action that
 *       references it and require NO error of any severity. Classes (a)
 *       and (b) only reject non-overridable errors, which is why they
 *       stayed green through  - that bug raised
 *       DISPENSER_NOT_FOUND, a network-sourced and therefore overridable
 *       error, on every live dispenser in existence.
 *
 * Two things class (c) made visible, worth keeping in mind when reading
 * a failure here:
 *
 *   - Tier 1 MASKS client-tier false errors wherever it can run: a valid
 *     dry-run flattens a client `error` to `info`. So the damage from a
 *     broken client check concentrates precisely on the rows Tier 1
 *     cannot adjudicate - DISPENSE above all, which is fee-exempt AND
 *     moves native coin. A DISPENSER cancel with the same broken
 *     resolver underneath passes this suite, because the dry-run covers
 *     for it.
 *   - An overridable error on an accepted action is still a false block
 *     from the user's seat: the confirm screen says the network expects
 *     failure and gates Approve behind an acknowledgment of something
 *     untrue.
 *
 * Structural pre-indexer fails (encoding-size, delimiter corruption)
 * are asserted at the client tier in the SDK unit suites; here we only
 * exercise what the live indexer can actually adjudicate.
 *
 * Requires the live regtest stack (run via `npm run test:sdk`, which
 * --requires initialCheck to stand up the connectors). Skips cleanly
 * when those globals are absent. Runs on any of the three chains; first
 * green run was litecoin-regtest 2026-07-26 (the BTC decoder was in an
 * over-deep-reorg halt, ).
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts,
} = require('./sdkHelper');

// Venue coin code (BTC/LTC/DOGE), set by the initialCheck beforeAll hook.
// Same resolution the trading suite uses.
const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';

// A non-overridable error is the only kind that HARD-blocks Approve /
// throws under 'enforce'. Network-sourced (overridable) errors and
// warnings are allowed on accepted actions - the user can proceed.
function nonOverridableErrors(report) {
    return report.findings.filter(f => f.severity === 'error' && f.overridable === false);
}

// The STRICTER invariant, and the one that matters for the rows below.
//
//  shipped a pre-flight that reported every live dispenser as
// nonexistent. The finding it raised was DISPENSER_NOT_FOUND, which is
// network-sourced and therefore OVERRIDABLE - so the non-overridable test
// above would have passed it, and did, for as long as the bug existed.
//
// An overridable error on an action the indexer ACCEPTS is still a false
// block where the user sits: the confirm screen tells them the network
// expects this to fail and refuses Approve until they tick "Sign anyway"
// on a warning that is simply untrue. On a DISPENSE, that untrue warning
// sits in front of an action that moves native coin. So for any action we
// have just proven the chain accepts, the bar is NO error of any severity.
function anyErrors(report) {
    return report.findings.filter(f => f.severity === 'error')
        .map(f => f.code + (f.overridable === false ? ' (hard)' : ' (overridable)') + ': ' + f.message);
}

function actionIndexOf(indexed) {
    if (!indexed) return null;
    if (indexed.action_index !== undefined && indexed.action_index !== null) return indexed.action_index;
    const a = Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : null;
}

describe('[sdk] pre-flight false-block invariant @preflight', function () {
    this.timeout(0);

    let sdk, issuer, tick;

    before(async function () {
        if (!global.regtestMinerConnector || !global.utxoTrackerConnector || !global.nodeConnector) {
            this.skip();
            return;
        }
        sdk = makeSdk({ preflight: 'report' });
        // ISSUE charges an XCHAIN gas fee on create, so the issuer needs
        // both native coin (tx fee) and gas.
        issuer = await fundedGasAddress(sdk, 1);
        tick = uniqueTick('PF');
        // Create + seed a token so accepted actions have real state.
        const issue = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 1000000, decimals: 0, mintSupply: 1000 } },
            { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
        expect(issue.indexed.status, 'ISSUE indexed valid').to.equal('valid');
        await mine(1);
    });

    describe('class (a): accepted actions must not be hard-blocked', function () {

        it('a well-funded SEND is accepted AND pre-flight raises no non-overridable error', async function () {
            const recipient = await fundedSdkAddress(sdk, 1);
            const action = { action: 'SEND', params: { tick, amount: 10, destination: recipient.address } };

            const report = await sdk.preflight(action, { source: issuer.address, chain: sdk.config.network });
            expect(nonOverridableErrors(report), 'no false hard-block on an acceptable SEND').to.deep.equal([]);

            // Sample: actually broadcast a `pass`/`warn` verdict and confirm valid.
            if (report.verdict !== 'fail') {
                const res = await submit(sdk, action,
                    { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
                expect(res.indexed.status, 'broadcast SEND confirmed valid').to.equal('valid');
            }
        });

        it('an owner ISSUE edit is accepted AND not hard-blocked', async function () {
            const action = { action: 'ISSUE', params: { tick, version: 1, description: 'updated' } };
            const report = await sdk.preflight(action, { source: issuer.address, chain: sdk.config.network });
            expect(nonOverridableErrors(report), 'owner edit must not be hard-blocked').to.deep.equal([]);
        });

        it('an empty-eligible SWEEP is accepted AND not hard-blocked (valid no-op)', async function () {
            const dest = await fundedSdkAddress(sdk, 1);
            const action = { action: 'SWEEP', params: { destination: dest.address } };
            const report = await sdk.preflight(action, { source: issuer.address, chain: sdk.config.network });
            expect(nonOverridableErrors(report), 'SWEEP must not be hard-blocked').to.deep.equal([]);
        });
    });

    // These are the §4.4 rows Tier 1 cannot adjudicate, which makes the client
    // tier the ONLY pre-sign protection on them - and every one was broken
    //  while this suite was green, because this suite did not look.
    // Each case builds the referenced object ON CHAIN first, so a finding of
    // "does not exist" is provably false rather than arguably so.
    describe('class (c): actions referencing REAL on-chain objects', function () {

        it('a DISPENSE against a real open dispenser raises no error at all', async function () {
            const giveTick = uniqueTick('PFD');
            const iss = await submit(sdk,
                { action: 'ISSUE', params: { tick: giveTick, maxSupply: 1000000, maxMint: 0, decimals: 0, mintSupply: 1000 } },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            expect(iss.indexed.status, 'ISSUE for the dispenser token').to.equal('valid');

            const disp = await submit(sdk,
                {
                    action: 'DISPENSER',
                    params: {
                        giveCoin: COIN, giveTick, giveAmount: 10, giveEscrow: 100,
                        getCoin: COIN, getAmount: 100000, getAddress: issuer.address,
                        expiration: Math.floor(Date.now() / 1000) + 86400,
                    },
                },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            expect(disp.indexed.status, 'DISPENSER open indexed valid').to.equal('valid');

            const idx = actionIndexOf(disp.indexed);
            expect(idx, 'dispenser action_index resolvable').to.not.equal(null);

            const report = await sdk.preflight(`DISPENSE|0|${idx}`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            expect(anyErrors(report),
                'a dispense against a dispenser that exists and is open must not be flagged').to.deep.equal([]);
        });

        it('a DISPENSER cancel by its owner raises no error at all', async function () {
            const giveTick = uniqueTick('PFC');
            await submit(sdk,
                { action: 'ISSUE', params: { tick: giveTick, maxSupply: 1000000, maxMint: 0, decimals: 0, mintSupply: 1000 } },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            const disp = await submit(sdk,
                {
                    action: 'DISPENSER',
                    params: {
                        giveCoin: COIN, giveTick, giveAmount: 10, giveEscrow: 100,
                        getCoin: COIN, getAmount: 100000, getAddress: issuer.address,
                        expiration: Math.floor(Date.now() / 1000) + 86400,
                    },
                },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            expect(disp.indexed.status, 'DISPENSER open indexed valid').to.equal('valid');
            const idx = actionIndexOf(disp.indexed);

            const report = await sdk.preflight(`DISPENSER|1|${idx}`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            expect(anyErrors(report), 'the owner cancelling their own open dispenser must not be flagged').to.deep.equal([]);
        });

        it('an AIRDROP against a real LIST raises no LIST_NOT_FOUND', async function () {
            const member = await fundedSdkAddress(sdk, 1);
            const list = await submit(sdk,
                { action: 'LIST', params: { type: 1, item: member.address } },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            expect(list.indexed.status, 'LIST create indexed valid').to.equal('valid');
            const listIdx = actionIndexOf(list.indexed);
            expect(listIdx, 'list action_index resolvable').to.not.equal(null);

            const report = await sdk.preflight(`AIRDROP|0|${tick}|1|${listIdx}`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            const notFound = report.findings.filter(f => f.code === 'LIST_NOT_FOUND');
            expect(notFound, 'a list that exists on chain must not be reported missing').to.deep.equal([]);
        });

        // Teeth for class (c): the same checks must still fire on references
        // that genuinely are absent, or the three cases above would pass just
        // as well against a pre-flight that had stopped checking anything.
        it('still flags a dispenser and a list that genuinely do not exist', async function () {
            const ghost = 999999999;
            const dispenseReport = await sdk.preflight(`DISPENSE|0|${ghost}`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            expect(dispenseReport.findings.some(f => f.code === 'DISPENSER_NOT_FOUND'),
                'a nonexistent dispenser must still be flagged').to.equal(true);

            const airdropReport = await sdk.preflight(`AIRDROP|0|${tick}|1|${ghost}`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            expect(airdropReport.findings.some(f => f.code === 'LIST_NOT_FOUND'),
                'a nonexistent list must still be flagged').to.equal(true);
        });
    });

    // The MIRROR of class (c). Class (c) catches a client check that fires when
    // it should not; this catches one that CANNOT fire at all.
    //
    // A check reading a field name the explorer does not serve returns null,
    // skips, and reports nothing - which is indistinguishable from a clean pass.
    // That is how MINT_OVER_MAX, SUPPLY_EXCEEDED, AMOUNT_FORMAT_INVALID and
    // NOT_OWNER came to be dead against the live API for as long as they
    // existed: the token document is nested (info/mints/supply/locks) and every
    // one of them was reading a flat top-level name.
    //
    // Nothing else in the suite could see it, because Tier 1's dry-run catches
    // these same cases and the report looks correct. So each assertion here
    // requires a finding whose `source` is 'client' - the dry-run agreeing is
    // not evidence that the client tier works, and in 'local' mode or against a
    // dead explorer the client tier is all there is.
    describe('class (d): certified client checks must actually FIRE', function () {
        let capTick;

        before(async function () {
            capTick = uniqueTick('PFM');
            const iss = await submit(sdk,
                { action: 'ISSUE', params: { tick: capTick, maxSupply: 1000, maxMint: 100, decimals: 0, mintSupply: 0 } },
                { pubkey: issuer.address, change: issuer.address }, submitOpts({ wif: issuer.wif }));
            expect(iss.indexed.status, 'ISSUE with known caps indexed valid').to.equal('valid');
        });

        const clientFinding = (report, code) =>
            report.findings.find(f => f.code === code && f.source === 'client');

        it('MINT_OVER_MAX fires from the CLIENT tier against the real token document', async function () {
            const report = await sdk.preflight(`MINT|0|${capTick}|1000`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            const f = clientFinding(report, 'MINT_OVER_MAX');
            expect(f, 'the per-tx cap check must fire client-side, not only via the dry-run').to.not.equal(undefined);
        });

        it('SUPPLY_EXCEEDED fires from the CLIENT tier', async function () {
            const report = await sdk.preflight(`MINT|0|${capTick}|100000`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            const f = clientFinding(report, 'SUPPLY_EXCEEDED');
            expect(f, 'the supply-headroom check must fire client-side').to.not.equal(undefined);
        });

        it('NOT_OWNER fires from the CLIENT tier for a non-owner ISSUE edit', async function () {
            const stranger = await fundedSdkAddress(sdk, 1);
            const report = await sdk.preflight(`ISSUE|1|${capTick}|hijacked`,
                { source: stranger.address, chain: sdk.config.network, preflight: 'report' });
            const f = clientFinding(report, 'NOT_OWNER');
            expect(f, 'the ownership check must fire client-side').to.not.equal(undefined);
        });

        it('a legal mint draws no client error', async function () {
            const report = await sdk.preflight(`MINT|0|${capTick}|10`,
                { source: issuer.address, chain: sdk.config.network, preflight: 'report' });
            expect(report.findings.filter(f => f.severity === 'error' && f.source === 'client')
                .map(f => f.code), 'a mint inside both caps must not be flagged').to.deep.equal([]);
        });
    });

    describe('class (b): intra-BATCH sequential projection', function () {
        it('MINT-then-SEND-the-minted is accepted AND the SEND leg is not hard-blocked', async function () {
            const recipient = await fundedSdkAddress(sdk, 1);
            // Build the BATCH action string directly: MINT 100, then SEND 50
            // of the just-minted supply. A naive balance check on the SEND
            // leg (ignoring the MINT) would false-block; the projected-delta
            // rule must prevent that.
            const mintStr = `MINT|0|${tick}|100|${issuer.address}`;
            const sendStr = `SEND|0|${tick}|50|${recipient.address}`;
            const batchStr = `BATCH|0|${mintStr};${sendStr}`;

            const report = await sdk.preflight(batchStr, { source: issuer.address, chain: sdk.config.network });
            expect(nonOverridableErrors(report),
                'MINT-then-SEND batch must not hard-block the SEND leg').to.deep.equal([]);
        });
    });

    describe('positive control: pre-flight DOES flag a genuinely bad action', function () {
        it('a SEND far exceeding balance is flagged (error), proving the harness has teeth', async function () {
            const recipient = await fundedSdkAddress(sdk, 1);
            const action = { action: 'SEND', params: { tick, amount: 999999999, destination: recipient.address } };
            const report = await sdk.preflight(action, { source: issuer.address, chain: sdk.config.network });
            const hasBalanceError = report.findings.some(f => f.code === 'BALANCE_INSUFFICIENT' && f.severity === 'error');
            const dryRunInvalid = report.findings.some(f => f.code === 'DRYRUN_INVALID');
            expect(hasBalanceError || dryRunInvalid, 'over-balance SEND should be flagged').to.equal(true);
        });
    });
});
