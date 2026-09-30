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
 *********************************************************************/

'use strict';

const RELEASE_MEMPOOL_TIMEOUT_MS = 30000;
const RELEASE_MEMPOOL_POLL_MS = 100;

function newMempoolCount(baseline, current) {
    const before = new Set(baseline);
    return current.filter((txid) => !before.has(txid)).length;
}

async function waitForReleaseMempool(node, baseline, expected, options) {
    const opts = options || {};
    const timeoutMs = Number(opts.timeoutMs || RELEASE_MEMPOOL_TIMEOUT_MS);
    const pollMs = Number(opts.pollMs || RELEASE_MEMPOOL_POLL_MS);
    const now = opts.now || Date.now;
    const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + timeoutMs;
    let seen = 0;
    while (now() < deadline) {
        const current = await node.getRawMempool();
        seen = newMempoolCount(baseline, current);
        if (seen >= expected) return;
        await sleep(pollMs);
    }
    throw new Error('policy rail release saw ' + seen + '/' + expected + ' UNSTAKE transaction(s) in the mempool');
}

async function settleReleaseBatch(options) {
    const entries = options.entries;
    const baseline = await options.node.getRawMempool();
    const settlement = Promise.allSettled(entries.map((entry, index) =>
        Promise.resolve().then(() => options.send(entry, index))));
    await waitForReleaseMempool(options.node, baseline, entries.length, options);
    await options.mine(1);
    return settlement;
}

function addedCapabilityMembers(baseline, current) {
    // Treat an unreadable view as pending instead of claiming the release completed.
    if (!current || current.error) return null;
    const before = new Set(baseline.pubkeys);
    return current.pubkeys.filter((pubkey) => !before.has(pubkey));
}

async function waitForCapabilityBaseline(options) {
    const now = options.now || Date.now;
    const deadline = now() + Number(options.timeoutMs || 0);
    let added = null;
    do {
        const current = await options.read();
        added = addedCapabilityMembers(options.baseline, current);
        // Finish only after every signer outside the opening roster has left the buried view.
        if (added && !added.length) return current;
        // Stop advancing the shared chain once the release budget is spent.
        if (now() >= deadline) break;
        await options.advance(Math.max(1, deadline - now()));
    } while (now() <= deadline);
    const detail = added ? added.map((pubkey) => String(pubkey).slice(0, 16)).join(', ') : 'unreadable set';
    throw new Error('policy rail bootstrap release did not restore its capability baseline: ' + detail);
}

module.exports = { settleReleaseBatch, waitForCapabilityBaseline };
