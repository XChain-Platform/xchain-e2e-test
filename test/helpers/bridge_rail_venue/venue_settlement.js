'use strict';

const assert = require('assert');
const {
    bridgeSettled, firstHubRowsForSourceLeg, outstandingFinalizedLegs,
} = require('./venue_helpers');
const { overFinalizedSourceLegsByHub } = require('./transfer_diagnostics');
const { indexerCaughtUp } = require('./reorg_controls');

function buildVenueSettlement(deps) {
const { fundUnderBudget, nodeDiagnosis } = deps;

class VenueMethods {
    async waitForRailSettled(tick, opts) {
        const o = opts || {};
        const deadline = Date.now() + Number(o.timeoutMs || 45 * 60 * 1000);
        assert.ok(this.hubs.length, 'bridgeRailVenue: no hub database to poll');
        let last = null;
        while (Date.now() < deadline) {
            const pending = [];
            const applied = [];
            // THE BACKLOG IS THE CHAIN'S, NOT THE MIRROR'S, and asking the mirror would be
            // circular: a fresh venue's mirror is empty at boot, so "nothing pending" would
            // be true a second after the engine was armed and before it had proposed a
            // thing. `getpendingbridgetransfers` answers every valid XBRIDGE leg on the
            // chain, so it is the complete list of what this federation is about to
            // re-finalize.
            for (const src of ['BTC', 'DOGE']) {
                let legs = [];
                try {
                    const res = await this.indexerRpc(src, 'getpendingbridgetransfers', { limit: 500 });
                    legs = (res && Array.isArray(res.transfers)) ? res.transfers : [];
                } catch (e) {
                    // AN UNREADABLE SOURCE INDEXER IS NOT AN EMPTY BACKLOG, and reading it as
                    // one is the worst answer this method can give: it would report the rail
                    // DRAINED while the whole chain's legs were still unsigned, and every
                    // absolute reading taken against that baseline would be arithmetic on a
                    // number nobody had waited for. So the failure becomes an outstanding
                    // entry: the poll can never conclude quiet from a read that did not happen.
                    pending.push({ stage: 'source read unreadable', chain: src,
                                   error: String(e && e.message).slice(0, 200) });
                    continue;
                }
                for (const leg of legs) {
                    if (tick && String(leg.tick) !== String(tick)) continue;
                    const dest = String(leg.dest_chain).toUpperCase();
                    // A leg bound for a chain this venue has no indexer for can never be
                    // observed applying, so waiting on it would hang the whole drive. It is
                    // recorded as unobservable rather than folded into either answer.
                    if (dest !== 'BTC' && dest !== 'DOGE') {
                        this['_unobservableLegs'] = (this['_unobservableLegs'] || []).concat(
                            [{ src: src, dest: dest, actionIndex: String(leg.src_action_index) }]);
                        continue;
                    }
                    const where = { chain: src, dest: dest, actionIndex: String(leg.src_action_index),
                                    amount: String(leg.amount) };
                    const hubRows = await firstHubRowsForSourceLeg(this.hubs,
                        this.queryHubDb.bind(this), src, leg.src_action_index);
                    if (!hubRows.length) { pending.push(Object.assign({ stage: 'unfinalized' }, where)); continue; }
                    const transferId = String(hubRows[0].transfer_id);
                    let settled = [];
                    try {
                        settled = await this.queryIndexerDb(dest,
                            'SELECT * FROM bridge_settlements WHERE transfer_id = ? LIMIT 1', [transferId]);
                    } catch (e) { settled = []; }
                    if (settled.length) applied.push(Object.assign({ transferId: transferId,
                        block: String(settled[0].block_index) }, where));
                    else pending.push(Object.assign({ stage: 'unapplied', transferId: transferId }, where));
                }
            }
            // THE SECOND HALF: the legs the source read no longer lists because a hub row
            // already exists for them. Read across EVERY hub (a hub that did not sign a round
            // may hold no row for it; see waitForFinalizedTransfer) and held against the
            // destination's own settlement record, one read per transfer id.
            const covered = new Set(applied.concat(pending)
                .filter((e) => e.actionIndex !== undefined)
                .map((e) => String(e.chain).toUpperCase() + ':' + String(e.actionIndex)));
            const hubRows = [];
            for (const hub of this.hubs) {
                let rows = [];
                try {
                    rows = await this.queryHubDb(hub.dbName,
                        'SELECT transfer_id, src_chain, src_action_index, dest_chain, amount, status, tick ' +
                        'FROM bridge_transfers');
                } catch (e) { rows = []; }
                for (const r of rows) {
                    hubRows.push({ transferId: r.transfer_id, srcChain: r.src_chain,
                                   srcActionIndex: r.src_action_index, destChain: r.dest_chain,
                                   amount: r.amount, status: r.status, tick: r.tick });
                }
            }
            const settledIds = new Set();
            for (const row of hubRows) {
                const dest = String(row.destChain).toUpperCase();
                if (dest !== 'BTC' && dest !== 'DOGE') continue;
                if (String(row.status) === 'retracted' || settledIds.has(String(row.transferId))) continue;
                let rows = [];
                try {
                    rows = await this.queryIndexerDb(dest,
                        'SELECT block_index FROM bridge_settlements WHERE transfer_id = ? LIMIT 1',
                        [String(row.transferId)]);
                } catch (e) { rows = []; }
                if (rows.length) settledIds.add(String(row.transferId));
            }
            const finalized = outstandingFinalizedLegs(hubRows, covered, (id) => settledIds.has(id), { tick: tick });
            for (const a of finalized.applied) applied.push(a);
            for (const p of finalized.pending) pending.push(p);
            // Reported per poll, not accumulated: a 60 minute wait polls hundreds of times.
            this['_unobservableFinalized'] = finalized.unobservable;
            last = { applied: applied, pending: pending };
            // Published every poll, not only at the timeout: a case that fails for another
            // reason while the drain is still running can then quote how far it had got.
            this['_lastSettlePoll'] = last;
            if (!pending.length) {
                let invariant = null;
                try { invariant = await this.bridgeInvariant(tick); } catch (e) { invariant = null; }
                return { applied: applied, invariant: invariant };
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
        this['_lastSettlePoll'] = last;
        return null;
    }

    /**
     * The source legs this venue's federation finalized more than once, read from every
     * hub database. See `overFinalizedSourceLegs` for what the answer means.
     *
     * Read from the HUB rather than from the destination's `bridge_settlements`, because the
     * duplication happens at finalization: a destination that refused the second mint would
     * still be riding a federation that signed two records for one lock.
     *
     * @returns {Promise<Array>} empty when every finalized leg is unique
     */
    async duplicateSourceTransfers() {
        assert.ok(this.hubs.length, 'bridgeRailVenue: no hub database to read');
        return overFinalizedSourceLegsByHub(this.hubs, this.queryHubDb.bind(this));
    }

    /**
     * Hold until `predicate` answers true, and fail loudly with what was being waited for.
     *
     * WHY IT IS HERE rather than a fixed sleep: a fixed settle wait before an assertion
     * passes or fails on how busy the venue is, and on this rail the venue is three hubs,
     * two indexers and two chains that a peer lane may also be mining. The predicate may be
     * async and may throw, and a throw is treated as "not yet" so a read against a service
     * that is still starting does not end the wait.
     *
     * @param {string} what the thing being waited for, quoted verbatim in the failure
     * @param {function(): (boolean|Promise<boolean>)} predicate
     */
    async waitUntil(what, predicate, opts) {
        const o = opts || {};
        const timeoutMs = Number(o.timeoutMs || 120000);
        const everyMs = Number(o.everyMs || 2000);
        const deadline = Date.now() + timeoutMs;
        let lastError = null;
        while (Date.now() < deadline) {
            try { if (await predicate()) return true; } catch (e) { lastError = e; }
            await new Promise((r) => setTimeout(r, everyMs));
        }
        assert.fail('bridgeRailVenue: waited ' + Math.round(timeoutMs / 1000) + 's for ' + what +
            ' and it never happened' + (lastError ? '. The last read failed with: ' +
            String(lastError.message).slice(0, 200) : '') + '\n' + this.indexerTails(40));
    }

    /**
     * One chain's `ledger_hash` and `actions_hash` as STRINGS, at a height or at the tip.
     *
     * THE JOIN IS THE WHOLE POINT, and its absence is what AT3b and AT3c died on the first
     * time they ran: `blocks` carries `ledger_hash_id` and `actions_hash_id`, ids into
     * `index_transactions`, and there is no `ledger_hash` column at all, so a SELECT naming
     * one fails with `Unknown column 'ledger_hash' in 'SELECT'`. AT3's claim is that a BTC
     * reorg moves NO DOGE hash, so the reading has to be the hash itself rather than an id
     * that could be re-pointed.
     *
     * @param {string} chain BTC or DOGE
     * @param {number} [blockIndex] the height to read; the tip when omitted
     */
    async blockHashes(chain, blockIndex) {
        const at = (blockIndex === undefined || blockIndex === null) ? null : Number(blockIndex);
        const rows = await this.queryIndexerDb(chain,
            'SELECT b.block_index AS block_index, lh.hash AS ledger_hash, ah.hash AS actions_hash ' +
            'FROM blocks b ' +
            'LEFT JOIN index_transactions lh ON (lh.id = b.ledger_hash_id) ' +
            'LEFT JOIN index_transactions ah ON (ah.id = b.actions_hash_id) ' +
            (at === null ? '' : 'WHERE b.block_index = ? ') +
            'ORDER BY b.block_index DESC LIMIT 1',
            at === null ? [] : [at]);
        assert.ok(rows.length, 'bridgeRailVenue: the ' + chain + ' venue ledger holds no block ' +
            (at === null ? 'at all' : at) + ', so there is no hash to compare');
        return rows;
    }

    /**
     * Both venue indexers' tip heights, for a diagnosis. Never throws: this is called from
     * a failure path, where a second failure would replace the finding with its own.
     */
    async venueTips() {
        const tips = {};
        const chains = this.ltcIndexer() ? BRIDGE_CHAINS : ['BTC', 'DOGE'];
        for (const chain of chains) {
            try {
                const answer = await this.indexerRpc(chain, 'getblockhashes', {});
                tips[chain] = answer ? Number(answer.block_index) : null;
            } catch (e) { tips[chain] = 'unreadable: ' + String(e && e.message).slice(0, 80); }
        }
        return tips;
    }

    /**
     * Hold until one venue indexer has parsed `height`.
     *
     * WHY A VENUE READ NEEDS THIS. The action helpers return once the STANDING indexer has
     * graded the action: `sendSendV0` waits on the standing ledger's send, credit and debit
     * rows and knows nothing of the venue, whose indexers parse the same block on their own
     * clock (a hub mirror bootstrap in the middle of a block parse stretches it past ten
     * seconds). A venue read taken straight after such a helper can therefore see the ledger
     * as it stood one block earlier, and a delta measured across that gap reads as "the
     * action was not credited" when the fact is that its block was not parsed yet. So a venue
     * read that follows a standing-helper broadcast waits here first, on the confirming block
     * (`confirmedHeight`) or on the node's tip.
     *
     * The target is validated up front, outside the poll: a NaN height inside the predicate
     * would be caught and retried for the whole budget, and the failure would then name a
     * slow indexer instead of the caller's bad number.
     *
     * @param {string} chain   BTC or DOGE
     * @param {number} height  the block the caller needs parsed
     * @param {string} [what]  why, quoted in the timeout message
     * @param {{timeoutMs?: number, everyMs?: number}} [opts]
     * @returns {Promise<{caughtUp: boolean, have: number, want: number, behind: number}>} the last reading
     */
    async waitForVenueTip(chain, height, what, opts) {
        const o = opts || {};
        let last = indexerCaughtUp(null, height);
        await this.waitUntil('the venue ' + chain + ' indexer to reach block ' + last.want +
            (what ? ' ' + what : ''),
            async () => {
                const answer = await this.indexerRpc(chain, 'getblockhashes', {});
                last = indexerCaughtUp(answer ? answer.block_index : null, height);
                return last.caughtUp;
            },
            { timeoutMs: o.timeoutMs || 180000, everyMs: o.everyMs || 2000 });
        return last;
    }

    /**
     * Fund an address under a budget, so a stalled funding call fails the case with a
     * diagnosis instead of hanging the drive.
     *
     * The wait itself is `fundUnderBudget`; what this adds is the venue's own readings on a
     * breach: both chains' tip heights before the call and at the breach, which separate
     * "the chain stopped" from "the chain moved and this transaction still never reached a
     * block". Every funding call in the three rail suites goes through here.
     *
     * @param {string} label the drive's name for the address
     * @param {function(): Promise} fn the funding call, already bound to its rail
     */
    async funded(label, fn, opts) {
        const tipsAtStart = await this.venueTips();
        return fundUnderBudget(label, fn, Object.assign({}, opts, {
            diagnose: async (wait) => ({ tipsAtStart: tipsAtStart, tipsAtBreach: await this.venueTips(),
                node: await nodeDiagnosis(wait ? wait.txid : null) }),
        }));
    }
}

const descriptors = Object.getOwnPropertyDescriptors(VenueMethods.prototype);
delete descriptors.constructor;
return descriptors;
}

module.exports = buildVenueSettlement;
