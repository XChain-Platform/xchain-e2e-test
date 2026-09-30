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
 * Testnet stand-in for the regtest miner's mine(): a testnet cannot be
 * told to produce blocks, so the drill waits for the chain to advance by
 * reading the explorer's fleet status (`last_block` keyed by coin).
 * Nothing here calls a miner RPC.
 ********************************************************************/

'use strict';

// Testnet inclusion latency is measured at 30 to 60 minutes, so the default
// budget is three hours polled once a minute.
const DEFAULT_TIMEOUT_MS       = 3 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readTip(fetchImpl, url, coin) {
    const res = await fetchImpl(url);
    if (!res || !res.ok) {
        throw new Error('status read failed: HTTP ' + (res && res.status));
    }
    const body = await res.json();
    const tip = Number(body && body.last_block && body.last_block[coin]);
    if (!Number.isFinite(tip)) {
        throw new Error('status has no last_block for ' + coin);
    }
    return tip;
}

/**
 * Resolves with the observed tip once it reaches sinceHeight + blocks.
 * Rejects on timeout naming the last height observed. A failed poll is
 * retried until the deadline rather than aborting the wait.
 */
async function waitForBlocks(args) {
    const {
        explorerUrl, coin, sinceHeight, blocks,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
        now = Date.now,
        sleep = realSleep,
        fetchImpl = globalThis.fetch
    } = args;

    const target = sinceHeight + blocks;
    const url = String(explorerUrl).replace(/\/+$/, '') + '/' + coin + '/api/status';
    const deadline = now() + timeoutMs;
    let lastHeight = null;
    let lastError = null;

    for (;;) {
        try {
            lastHeight = await readTip(fetchImpl, url, coin);
            lastError = null;
            if (lastHeight >= target) {
                return lastHeight;
            }
        } catch (err) {
            lastError = err;
        }
        if (now() >= deadline) {
            throw new Error(
                'timed out after ' + timeoutMs + 'ms waiting for ' + coin + ' height ' + target +
                '; last observed height ' + lastHeight +
                (lastError ? ' (last poll error: ' + lastError.message + ')' : '')
            );
        }
        await sleep(pollIntervalMs);
    }
}

module.exports = { waitForBlocks, DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS };
