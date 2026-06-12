/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform E2E - SDK-driven Project Registry pattern
 *
 * Project registries are a composition of existing primitives, not a
 * new action (spec: protocol/Project_Registry.md). A project is a
 * TICK; its official-token roster is a TICK-type LIST attested by a
 * LINK to the project's ISSUE — valid only from the project tick's
 * current owner. This suite drives the live regtest stack via
 * sdk.submitAction, dogfoods the sdk.project.* builders, and
 * exercises the authority rule end-to-end:
 *   - owner-published roster LINK is valid (the green-banner attestation)
 *   - a NON-owner cannot attest a roster against someone else's project
 *   - multi-item LISTs serialize as individual pipe segments and
 *     materialize fully in list_items (visible via the explorer roster)
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts, isTransientStackError } = require('./sdkHelper');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';

// An action that the indexer rejects still gets indexed with status 'invalid'.
// Pass requireValid:false so the waiter returns it instead of throwing.
function expectInvalid(opts) { return submitOpts(Object.assign({ requireValid: false }, opts)); }

// setRoster drives two submits inside the SDK (LIST then LINK) without the
// submit() helper's quiesce+retry barrier, so wrap the whole recipe in the
// same transient-stack retry. Only the first leg (LIST) races the tracker —
// the LINK leg waits for the LIST to index, which settles the stack.
async function setRosterWithRetry(sdk, wif, params, opts, attempts = 6) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            await global.utxoTrackerConnector.quiesce({ timeoutMs: 20000, pollMs: 250, regtestMiner: global.regtestMinerConnector });
        } catch (e) { /* best effort */ }
        try {
            return await sdk.setRoster(wif, params, opts);
        } catch (err) {
            lastErr = err;
            if (i < attempts && isTransientStackError(err)) continue;
            throw err;
        }
    }
    throw lastErr;
}

// submitAction's `indexed` result is a transaction ({ actions: [{ action_index }] }) on
// the polling path, or a single action on the WS path — handle both.
function actionIndexOf(indexed) {
    if (!indexed) return undefined;
    if (indexed.action_index !== undefined && indexed.action_index !== null) return indexed.action_index;
    const a = Array.isArray(indexed.actions) ? indexed.actions[0] : null;
    return a ? a.action_index : undefined;
}

// Reliable per-action status (res.indexed.status is flaky across WS/polling paths)
function statusOf(res) {
    const a = res && res.indexed && Array.isArray(res.indexed.actions) ? res.indexed.actions[0] : null;
    return (a && a.status) || (res && res.indexed && res.indexed.status);
}

describe('[sdk] Project registry (TICK + tick-LIST + owner-validated LINK)', function () {
    this.timeout(0);

    let sdk, owner, other;
    let projectTick, projectIssueIndex;
    let memberA, memberB;

    before(async function () {
        sdk   = makeSdk();
        owner = await fundedGasAddress(sdk, 1);
        other = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] owner=' + owner.address + ' other=' + other.address);

        // The project tick (the registry anchor) + two member tokens issued by
        // the community member ("other") under their own names — the curated
        // directory model.
        projectTick = uniqueTick('PROJ');
        memberA     = uniqueTick('MEMA');
        memberB     = uniqueTick('MEMB');

        const proj = await submit(sdk,
            { action: 'ISSUE', params: { tick: projectTick, maxSupply: '1', decimals: '0', lockMaxSupply: '1', mintSupply: '1', description: 'Project registry tick' } },
            { pubkey: owner.address, change: owner.address },
            submitOpts({ wif: owner.wif })
        );
        expect(statusOf(proj), 'project ISSUE').to.equal('valid');
        projectIssueIndex = actionIndexOf(proj.indexed);
        expect(projectIssueIndex, 'project ISSUE action_index').to.not.equal(undefined);

        for (const tick of [memberA, memberB]) {
            const res = await submit(sdk,
                { action: 'ISSUE', params: sdk.nft.unique({ tick }) },
                { pubkey: other.address, change: other.address },
                submitOpts({ wif: other.wif })
            );
            expect(statusOf(res), tick + ' ISSUE').to.equal('valid');
        }
    });

    it('owner publishes a multi-item roster and attests it (setRoster recipe)', async function () {
        const { list, link } = await setRosterWithRetry(sdk, owner.wif, {
            coin:             COIN,
            issueActionIndex: projectIssueIndex,
            ticks:            [memberA, memberB],
            memo:             'roster v1'
        }, submitOpts({ pubkey: owner.address, change: owner.address }));

        expect(statusOf(list), 'roster LIST').to.equal('valid');
        expect(statusOf(link), 'roster LINK (owner attestation)').to.equal('valid');

        // The explorer resolves the current roster from chain state
        const project = await sdk.getProject(projectTick);
        expect(project.total, 'roster size').to.equal(2);
        const ticks = project.members.map((m) => m.tick).sort();
        expect(ticks).to.deep.equal([memberA, memberB].sort());

        // Member token pages carry the membership (the green-banner data)
        const member = await sdk.getToken(memberA);
        expect(member.projects.map((p) => p.project)).to.include(projectTick);
    });

    it('a NON-owner cannot attest a roster against the project (invalid LINK)', async function () {
        // "other" publishes their own list — LIST itself is permissionless...
        const list = await submit(sdk,
            { action: 'LIST', params: sdk.project.rosterParams({ ticks: [memberA] }) },
            { pubkey: other.address, change: other.address },
            submitOpts({ wif: other.wif })
        );
        expect(statusOf(list), 'anyone may publish a LIST').to.equal('valid');

        // ...but only the project owner can LINK it to the project's ISSUE
        const link = await submit(sdk,
            { action: 'LINK', params: sdk.project.attestRosterParams({
                coin:             COIN,
                listActionIndex:  actionIndexOf(list.indexed),
                issueActionIndex: projectIssueIndex
            }) },
            { pubkey: other.address, change: other.address },
            expectInvalid({ wif: other.wif })
        );
        expect(String(statusOf(link)), 'non-owner attestation rejected').to.include('invalid');
    });

    it('a roster edit + re-attestation supersedes the previous roster (latest wins)', async function () {
        // Derive roster v2 from v1 by removing memberB, then re-attest
        const current = await sdk.getProject(projectTick);
        const { list, link } = await setRosterWithRetry(sdk, owner.wif, {
            coin:             COIN,
            issueActionIndex: projectIssueIndex,
            edit:             { listActionIndex: current.roster_action_index, remove: [memberB] },
            memo:             'roster v2'
        }, submitOpts({ pubkey: owner.address, change: owner.address }));
        expect(statusOf(list), 'roster v2 LIST').to.equal('valid');
        expect(statusOf(link), 'roster v2 LINK').to.equal('valid');

        const project = await sdk.getProject(projectTick);
        expect(project.total, 'roster size after removal').to.equal(1);
        expect(project.members.map((m) => m.tick)).to.deep.equal([memberA]);

        // The dropped member no longer carries the membership
        const dropped = await sdk.getToken(memberB);
        expect(dropped.projects.map((p) => p.project)).to.not.include(projectTick);
    });

});
