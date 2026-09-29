'use strict';

// A drive that starts while the standing mining loops are gone does not fail: every wait for a
// block, a confirmation or a finalized snapshot simply never ends, and the verify that
// launched it is cut at its cap with a log that stops mid-wait. Reading each chain's node tip
// twice, apart, turns that into a named failure in the first minute.

const DEFAULT_BUDGET_MS = 90 * 1000;
const DEFAULT_POLL_MS = 5 * 1000;

function miningNodeTipReaders(opts) {
    return {
        BTC: () => opts.btcNode.getBlockCount(),
        DOGE: () => opts.withRail(opts.dogeRail,
            () => opts.dogeRail.globals.nodeConnector.getBlockCount()),
    };
}

/**
 * Wait for every named chain's tip to rise above the height first read.
 *
 * Readers run one after another, never together: the DOGE reader swaps the harness globals
 * for the length of its call. A reader that resolves to null or undefined has no tip yet; that
 * chain gets its own budget to show one and is stalled with a null height when it never gets one.
 *
 * @param {object} opts
 * @param {Object<string, function(): Promise<number>>} opts.readers tip height per chain name
 * @param {function(number): Promise<void>} opts.sleep
 * @param {function(): number} opts.now
 * @param {number} [opts.budgetMs]
 * @param {number} [opts.pollMs]
 * @returns {Promise<{alive: boolean, stalled: Array<{chain: string, height: (number|null)}>}>}
 */
async function readTipAdvance(opts) {
    const budgetMs = opts.budgetMs === undefined ? DEFAULT_BUDGET_MS : opts.budgetMs;
    const pollMs = opts.pollMs === undefined ? DEFAULT_POLL_MS : opts.pollMs;
    const chains = Object.keys(opts.readers);
    const tipDeadline = opts.now() + budgetMs;
    const readTip = async (chain) => {
        const value = await opts.readers[chain]();
        return value === null || value === undefined ? null : Number(value);
    };
    const first = {};
    for (const chain of chains) first[chain] = await readTip(chain);
    while (chains.some((chain) => first[chain] === null) && opts.now() < tipDeadline) {
        await opts.sleep(pollMs);
        for (const chain of chains) if (first[chain] === null) first[chain] = await readTip(chain);
    }
    const rose = new Set();
    const deadline = opts.now() + budgetMs;
    while (rose.size < chains.length && opts.now() < deadline) {
        await opts.sleep(pollMs);
        for (const chain of chains) {
            if (rose.has(chain) || first[chain] === null) continue;
            const height = await readTip(chain);
            if (height !== null && height > first[chain]) rose.add(chain);
        }
    }
    const stalled = chains.filter((chain) => !rose.has(chain)).map((chain) => ({ chain, height: first[chain] }));
    return { alive: stalled.length === 0, stalled };
}

/**
 * The failure text for chains whose tip did not move, naming a pause flag left behind when
 * one is present since that is the one cause an operator clears with a single file removal.
 *
 * @param {Array<{chain: string, height: (number|null)}>} stalled
 * @param {number} budgetMs how long the tips were watched
 * @param {Array<string>} pauseFilesPresent pause flag paths that exist right now
 * @returns {string}
 */
function minerStallReason(stalled, budgetMs, pauseFilesPresent) {
    const heights = stalled.map((s) => s.chain + (s.height === null ? ' has no tip row' : ' tip ' + s.height)).join(', ');
    const flags = pauseFilesPresent.length
        ? ' A mining pause flag exists: ' + pauseFilesPresent.join(', ') + '.'
        : ' No pause flag exists, so the standing mining loop for that chain is not running.';
    return 'the standing regtest mining loop is not producing blocks: ' + heights + ' did not rise in ' +
        Math.round(budgetMs / 1000) + 's.' + flags +
        ' This is an INSTRUMENT failure and says nothing about the bridge.';
}

module.exports = { DEFAULT_BUDGET_MS, miningNodeTipReaders, readTipAdvance, minerStallReason };
