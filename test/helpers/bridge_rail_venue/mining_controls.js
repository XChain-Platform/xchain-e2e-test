'use strict';

const assert = require('assert');

/**
 * Run `fn` with the regtest miner's adaptive auto-mine loop paused, always resuming
 * even when `fn` throws.
 *
 * WHY AT3C NEEDED THIS, measured on the rail 2026-09-13. The case waits for a mint to
 * land on the DESTINATION chain before it orphans the SOURCE lock, and that wait is
 * bounded by the destination's own clock, never by BTC: xchain-hub/src/lib/relay_margin.js
 * stamps `effective_time` off wall-clock time, and the destination indexer applies the
 * leg at the first destination block whose time reaches it. No part of that wait needs
 * another BTC block. But the standing miner keeps mining BTC on its own ambient cadence
 * regardless (measured near 20s on the shared rail), so a wait of a few minutes quietly
 * pushed the orphan target past `assertShallowOrphan`'s window every time ("orphaning
 * from 1938 at tip 1953 is 16 blocks deep" against a 12-block window). Freezing BTC for
 * exactly the span that does not need it removes the drift without touching the window.
 *
 * The miner's own pause only stops its auto-mine loop: `generate_blocks` is exposed with no
 * pause gate, so a drive that mines through external loops keeps moving the tips. Those
 * loops honour flag files instead: `BRIDGE_RAIL_MINER_PAUSE_FILE` controls the BTC loop and
 * `BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE` controls the DOGE loop. Each configured file exists
 * for the span and is removed in the same finally, so the corresponding loop skips its call.
 *
 * @param {{pauseMining: function, resumeMining: function}} miner  the regtest miner connector
 * @param {function(): Promise<*>} fn
 * @param {{pauseFile?: string}} [opts]  the flag path, defaulting to the environment variable
 * @returns {Promise<*>} fn's resolved value
 */
async function withMiningPaused(miner, fn, opts) {
    assert.ok(miner && typeof miner.pauseMining === 'function' && typeof miner.resumeMining === 'function',
        'withMiningPaused: needs a connector with pauseMining()/resumeMining()');
    const pauseFile = (opts && opts.pauseFile !== undefined) ? opts.pauseFile
        : (process.env.BRIDGE_RAIL_MINER_PAUSE_FILE || '');
    const dogePauseFile = process.env.BRIDGE_RAIL_DOGE_MINER_PAUSE_FILE || '';
    const pauseFiles = [pauseFile, dogePauseFile].filter(Boolean);
    const fs = require('fs');
    await miner.pauseMining();
    try {
        for (const file of pauseFiles) fs.writeFileSync(file, String(process.pid) + '\n');
        return await fn();
    } finally {
        for (const file of pauseFiles) { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } }
        await miner.resumeMining();
    }
}

module.exports = { withMiningPaused };
