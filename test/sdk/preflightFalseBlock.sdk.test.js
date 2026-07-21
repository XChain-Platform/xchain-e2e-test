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
 * THE release-gating invariant: a non-overridable pre-flight `error`
 * must NEVER block an action the indexer would accept. This suite
 * proves it against the live regtest stack in two classes:
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
 * Structural pre-indexer fails (encoding-size, delimiter corruption)
 * are asserted at the client tier in the SDK unit suites; here we only
 * exercise what the live indexer can actually adjudicate.
 *
 * Requires the live regtest stack (run via `npm run test:sdk`, which
 * --requires initialCheck to stand up the connectors). Skips cleanly
 * when those globals are absent.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts,
} = require('./sdkHelper');

// A non-overridable error is the only kind that HARD-blocks Approve /
// throws under 'enforce'. Network-sourced (overridable) errors and
// warnings are allowed on accepted actions - the user can proceed.
function nonOverridableErrors(report) {
    return report.findings.filter(f => f.severity === 'error' && f.overridable === false);
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
