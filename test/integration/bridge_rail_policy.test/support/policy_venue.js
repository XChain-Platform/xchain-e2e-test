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

const READABLE_WAIT_ROUNDS = 12;
const READABLE_WAIT_MS = 5000;
const SAFE_DATABASE = /^[A-Za-z0-9_]+$/;

function readableHeight(status) {
    const value = status && status.body && status.body.indexerBlock;
    if (value === null || value === undefined || value === '') return null;
    const height = Number(value);
    return Number.isFinite(height) ? height : null;
}

async function unreadableIndexes(venue) {
    const readings = await Promise.all(venue.indexers.map(async (indexer) => {
        try { return readableHeight(await venue.statusOf(indexer.index)); }
        catch (e) { return null; }
    }));
    return venue.indexers.filter((internalIndexer, i) => readings[i] === null);
}

async function waitForUnreadableIndexes(venue, options) {
    const opts = options || {};
    const rounds = Number(opts.rounds || READABLE_WAIT_ROUNDS);
    const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let unreadable = [];
    for (let round = 0; round < rounds; round++) {
        unreadable = await unreadableIndexes(venue);
        if (!unreadable.length || round + 1 === rounds) return unreadable;
        await sleep(Number(opts.waitMs || READABLE_WAIT_MS));
    }
    return unreadable;
}

async function rebuildIndexer(venue, indexer) {
    // Reject a database name that cannot safely be interpolated into the rebuild statement.
    if (!SAFE_DATABASE.test(String(indexer.indexerDbName || ''))) {
        throw new Error('policy rail venue indexer ' + indexer.index + ' has an unsafe database name');
    }
    const tail = typeof venue.logTail === 'function' ? venue.logTail('indexer' + indexer.index) : '';
    console.log('POLICY RAIL: rebuilding unreadable venue BTC indexer ' + indexer.index +
        (tail ? '\n' + tail : ''));
    // Recreate only the disposable venue clone after its process has released the database.
    await venue['_kill'](indexer.proc);
    indexer.proc = null;
    await venue['_conn'].query('DROP DATABASE IF EXISTS `' + indexer.indexerDbName + '`');
    await venue['_spawnIndexer'](indexer.index);
}

async function repairUnreadableIndexers(venue, options) {
    const unreadable = await waitForUnreadableIndexes(venue, options);
    if (!unreadable.length) return [];
    for (const indexer of unreadable) await rebuildIndexer(venue, indexer);
    const remaining = await waitForUnreadableIndexes(venue, options);
    if (remaining.length) {
        throw new Error('policy rail venue BTC indexer(s) still have no readable height after rebuild: ' +
            remaining.map((indexer) => indexer.index).join(', '));
    }
    return unreadable.map((indexer) => indexer.index);
}

function policyBridgeRailVenue(BaseVenue) {
    return class PolicyBridgeRailVenue extends BaseVenue {
        async start() {
            const started = await super.start();
            if (started && this.label === 'bridgerailpolicy' && this.btcVenue) {
                await repairUnreadableIndexers(this.btcVenue);
            }
            return started;
        }
    };
}

module.exports = {
    policyBridgeRailVenue,
    readableHeight,
    repairUnreadableIndexers,
};
