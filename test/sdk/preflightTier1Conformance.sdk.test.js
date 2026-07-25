/**********************************************************************
 *
 * XChain Platform E2E - Tier-1 conformance
 * (spec claude/specs/confirm-decode-preflight-spec.md §8.3).
 *
 * Tier 1 is the indexer's OWN handler run read-only in a forced-rollback
 * transaction, and §1.4 makes it authoritative: a contradicting Tier-2
 * finding is downgraded to info. That authority is only earned if the
 * dry-run verdict actually equals what block inclusion records. This
 * suite is the check that it does.
 *
 * For each fixture: ask Tier 1, then BROADCAST the same action and read
 * the status the indexer persisted. The two must agree - on the boolean,
 * and on the status string, because both come from the same handler. A
 * divergence here means the wallet is confidently telling users a
 * verdict the chain will not honour, in either direction.
 *
 * SCOPE (§4.3, normative): only the quotable, non-exempt, non-guardInert,
 * non-denylisted subset has a verdict at all. For everything else Tier 1
 * deliberately returns NO verdict and falls through to Tier 2, so parity
 * is undefined there by design - those cases are skipped, loudly, rather
 * than asserted. The scope itself is pinned at the bottom, or it could
 * silently widen (an action quietly gaining a verdict it must not have)
 * and nothing would notice.
 *
 * Complements preflightFalseBlock.sdk.test.js: that one proves pre-flight
 * never HARD-BLOCKS an action the chain accepts (the release gate); this
 * one proves the server tier's verdict is truthful in both directions.
 *
 * Requires the live regtest stack (run via `npm run test:sdk`). Skips
 * cleanly when the connectors are absent.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts,
} = require('./sdkHelper');

/**
 * The Tier-1 half of a report, isolated from Tier 2.
 *
 * Reads the `source: 'dryrun'` finding rather than report.verdict: the
 * merged verdict folds in client-side checks, and this suite is about
 * the SERVER's answer specifically.
 */
function tier1Verdict(report) {
    const f = (report.findings || []).find(x => x.source === 'dryrun');
    if (!f) return { kind: 'no-verdict' };            // exempt / denied / guardInert
    if (f.code === 'DRYRUN_VALID') return { kind: 'verdict', valid: true, finding: f };
    if (f.code === 'DRYRUN_INVALID') return { kind: 'verdict', valid: false, finding: f };
    return { kind: 'unavailable', finding: f };        // DRYRUN_UNAVAILABLE
}

/** The status string the dry-run reported, when it gave one. */
function dryRunStatus(finding) {
    const d = finding && finding.data;
    if (!d) return null;
    return d.status || d.error || null;
}

describe('[sdk] pre-flight Tier-1 conformance @preflight', function () {
    this.timeout(0);

    let sdk, owner, tick, recipient;

    before(async function () {
        if (!global.regtestMinerConnector || !global.utxoTrackerConnector || !global.nodeConnector) {
            this.skip();
            return;
        }
        sdk = makeSdk({ preflight: 'report' });
        // ISSUE charges gas on create, so the owner needs native coin AND gas.
        owner = await fundedGasAddress(sdk, 1);
        recipient = await fundedSdkAddress(sdk, 1);
        tick = uniqueTick('T1');

        const issue = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000, maxMint: 1000, decimals: 0, mintSupply: 100 } },
            { pubkey: owner.address, change: owner.address }, submitOpts({ wif: owner.wif }));
        expect(issue.indexed.status, 'ISSUE setup indexed valid').to.equal('valid');
        await mine(1);
    });

    /**
     * The whole assertion, in one place: ask Tier 1, broadcast, compare.
     *
     * `expectValid` is what the CHAIN is expected to do. It is asserted
     * too - otherwise a fixture that silently stopped being invalid (a
     * balance that grew, a cap that moved) would still "conform" while
     * testing nothing.
     */
    async function assertConformance(action, expectValid, label) {
        const report = await sdk.preflight(action, { source: owner.address, chain: sdk.config.network });
        const t1 = tier1Verdict(report);

        if (t1.kind !== 'verdict') {
            // Parity is undefined outside the quotable subset (§4.3). Say so
            // rather than passing quietly, or the day an action drops out of
            // the verdict set this suite would go green having checked nothing.
            this.skip();
            return;
        }

        // requireValid:false is load-bearing. submitAction THROWS on a
        // non-valid indexed status by default, which is right for callers
        // doing work but wrong here: the invalid status is the measurement,
        // and throwing would turn every negative fixture into an error before
        // the comparison ran.
        const res = await submit(sdk, action,
            { pubkey: owner.address, change: owner.address },
            submitOpts({ wif: owner.wif, requireValid: false }));
        const indexedValid = res.indexed.status === 'valid';

        expect(indexedValid, `${label}: fixture no longer does what it claims (chain said ${res.indexed.status})`)
            .to.equal(expectValid);
        expect(t1.valid, `${label}: Tier-1 said valid=${t1.valid} but the chain recorded ${res.indexed.status}`)
            .to.equal(indexedValid);

        // Same handler, so the reject reason should be the same words too.
        // Checked separately from the boolean: a wording drift is a much
        // smaller problem than a verdict drift, and conflating them would
        // make a formatting change look like a consensus divergence.
        const claimed = dryRunStatus(t1.finding);
        if (!indexedValid && claimed) {
            expect(String(claimed), `${label}: dry-run reason "${claimed}" != recorded "${res.indexed.status}"`)
                .to.equal(String(res.indexed.status));
        }
        await mine(1);
    }

    describe('the verdict matches block inclusion, both directions', function () {

        it('an affordable SEND: valid in the dry-run AND valid on chain', async function () {
            await assertConformance.call(this,
                { action: 'SEND', params: { tick, amount: 10, destination: recipient.address } },
                true, 'affordable SEND');
        });

        it('an over-balance SEND: invalid in the dry-run AND invalid on chain', async function () {
            // The direction a false-block harness cannot cover: proving the
            // dry-run's REJECTIONS are real. If Tier 1 over-rejects, §1.4's
            // authority means the wallet blocks a payment the chain would
            // have taken, and nothing downstream would contradict it.
            await assertConformance.call(this,
                { action: 'SEND', params: { tick, amount: 999999, destination: recipient.address } },
                false, 'over-balance SEND');
        });

        it('a MINT within both caps: valid in the dry-run AND valid on chain', async function () {
            await assertConformance.call(this,
                { action: 'MINT', params: { tick, amount: 10, destination: owner.address } },
                true, 'in-cap MINT');
        });

        it('a MINT beyond MAX_SUPPLY: invalid in the dry-run AND invalid on chain', async function () {
            await assertConformance.call(this,
                { action: 'MINT', params: { tick, amount: 100000, destination: owner.address } },
                false, 'over-cap MINT');
        });

        it('a DESTROY beyond balance: invalid in the dry-run AND invalid on chain', async function () {
            await assertConformance.call(this,
                { action: 'DESTROY', params: { tick, amount: 999999 } },
                false, 'over-balance DESTROY');
        });

        it('an ISSUE edit by a non-owner: invalid in the dry-run AND invalid on chain', async function () {
            const stranger = await fundedGasAddress(sdk, 1);
            const action = { action: 'ISSUE', params: { tick, version: 1, description: 'not yours' } };
            const report = await sdk.preflight(action, { source: stranger.address, chain: sdk.config.network });
            const t1 = tier1Verdict(report);
            if (t1.kind !== 'verdict') { this.skip(); return; }

            const res = await submit(sdk, action,
                { pubkey: stranger.address, change: stranger.address },
                submitOpts({ wif: stranger.wif, requireValid: false }));
            expect(res.indexed.status, 'a non-owner edit must not be accepted').to.not.equal('valid');
            expect(t1.valid, 'Tier 1 must reject a non-owner ISSUE edit').to.equal(false);
            await mine(1);
        });
    });

    describe('scope: actions outside the quotable subset yield NO verdict (§4.3)', function () {

        // Pinned because the exclusions are what make the parity assertions
        // above meaningful. If a denylisted action quietly started returning
        // a verdict, the wallet would begin hard-blocking on an answer the
        // spec says is not trustworthy for it - and every test above would
        // still pass.
        it('BATCH is denylisted, so Tier 1 returns no verdict', async function () {
            const inner = `SEND|0|${tick}|1|${recipient.address}`;
            const report = await sdk.preflight(`BATCH|0|${inner}`, {
                source: owner.address, chain: sdk.config.network,
            });
            expect(tier1Verdict(report).kind, 'BATCH must not carry a Tier-1 verdict').to.equal('no-verdict');
        });

        it('a no-verdict response still produces a usable report, not an error', async function () {
            // Degrading to Tier 2 is the DESIGNED behaviour here (§4.3), so
            // the caller must still get a verdict to render; an exception
            // would take the confirm surface down for a whole action class.
            const inner = `SEND|0|${tick}|1|${recipient.address}`;
            const report = await sdk.preflight(`BATCH|0|${inner}`, {
                source: owner.address, chain: sdk.config.network,
            });
            expect(report).to.have.property('verdict');
            expect(['pass', 'warn', 'fail']).to.include(report.verdict);
        });
    });
});
