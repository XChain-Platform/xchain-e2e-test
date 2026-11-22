'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = function createReplayNodeDriving(deps) {
    const { waitFor, readChainHeight, REPLAY_WAIT_MS, ident, readPriceSnapshots, readPriceActions, readActionVerdicts, plain } = deps

    class ReplayNodeDriving {
    // ---- driving --------------------------------------------------------

    /**
     * Block until the node has processed up to `height`.
     *
     * Deliberately watches its OWN `blocks` table rather than an API: the claim
     * AT2 makes is about what the node's database ends up holding, and a health
     * endpoint can report progress the block transaction later rolls back.
     */
    async waitForHeight(height, opts) {
        opts = opts || {};
        const target = Number(height);
        const result = await waitFor(async () => {
            if (this['_indexerProc'] && this['_indexerProc'].exitCode !== null) return { ok: false, dead: true };
            try {
                const at = await readChainHeight(this['_conn'], this.indexerDbName);
                return { ok: at.height !== null && at.height >= target, at: at.height };
            } catch (internal) { return { ok: false, at: null }; }
        }, { timeoutMs: opts.timeoutMs || REPLAY_WAIT_MS, intervalMs: opts.intervalMs || 2000 });

        if (!result.ok) {
            const at = result.last && result.last.at;
            const dead = result.last && result.last.dead;
            throw new Error('oracleBatchReplay[' + this.label + ']: ' +
                (dead ? 'the indexer process exited' : 'the node reached block ' + at + ' of ' + target) +
                ' after ' + result.waitedMs + 'ms.\n' + this['_tail']('indexer'));
        }
        return result;
    }

    /**
     * Block until this node has no push left to deliver.
     *
     * WHY A DRAIN AND NOT A FIXED PAUSE. The reconstruction is asynchronous
     * relative to the block loop: `actions/price/index.js` write-aheads a durable
     * `pending_hub_pushes` row inside the block transaction and HubPushQueue
     * delivers it afterwards, retrying on a backoff. Reading the hub after a fixed
     * pause therefore measures whichever of the two won a race, and a queue still
     * holding rows reads exactly like a chain that rebuilt nothing. Waiting for the
     * outbox to empty makes the read a statement about the reconstruction.
     *
     * It is a WAIT and not a rescue: nothing here retries, re-pushes or forgives a
     * refusal. A queue that will not drain still returns, still leaves its rows to
     * be printed with their last error, and still fails the assertions it should.
     */
    async waitForPushDrain(opts) {
        opts = opts || {};
        const db = ident(this.indexerDbName, 'database name');
        const result = await waitFor(async () => {
            try {
                const rows = await this['_conn'].query(
                    "SELECT COUNT(*) AS c FROM `" + db + "`.pending_hub_pushes WHERE status = 'pending'");
                return { ok: Number(rows[0].c) === 0, pending: Number(rows[0].c) };
            } catch (internal) {
                // No such table means no hub push path at all, which is not something
                // to wait on.
                return { ok: true, pending: null };
            }
        }, { timeoutMs: opts.timeoutMs || 180_000, intervalMs: opts.intervalMs || 2000 });
        if (!result.ok) {
            console.warn('oracleBatchReplay[' + this.label + ']: ' + (result.last && result.last.pending) +
                ' hub push(es) were still undelivered after ' + result.waitedMs + 'ms; reading anyway so the ' +
                'run reports what the node actually holds and why.');
        }
        return result;
    }

    // ---- reading --------------------------------------------------------

    // What the node's own hub holds. This is the authoritative reconstruction:
    // rows here arrived through PriceAggregator from a block and from nowhere
    // else, because this hub has no peers and no oracle round.
    async hubPriceSnapshots(opts)    { return readPriceSnapshots(this['_conn'], this.hubDbName, opts); }
    // What the indexer's settlement path actually reads, once hub_db_sync has
    // carried the hub's rows back down. The full loop is only closed when both
    // agree.
    async mirrorPriceSnapshots(opts) { return readPriceSnapshots(this['_conn'], this.mirrorDbName, opts); }
    async priceActions(opts)         { return readPriceActions(this['_conn'], this.indexerDbName, opts); }
    async actionVerdicts(opts)       { return readActionVerdicts(this['_conn'], this.indexerDbName, opts); }
    async chainHeight()              { return readChainHeight(this['_conn'], this.indexerDbName); }

    // The node's own outbox, for a failure that needs to say whether a push was
    // never made, or was made and refused. Delivered rows are DELETED by design,
    // so an empty queue means either "nothing to push" or "everything landed";
    // the snapshot counts settle which.
    async hubPushQueue() {
        const db = ident(this.indexerDbName, 'database name');
        try {
            return plain(await this['_conn'].query(
                'SELECT push_type, status, attempts, last_error, COUNT(*) AS c FROM `' + db + '`.pending_hub_pushes ' +
                'GROUP BY push_type, status, attempts, last_error ORDER BY c DESC LIMIT 20'));
        } catch (e) { return [{ error: 'pending_hub_pushes unreadable: ' + (e && e.message) }]; }
    }

    // Evidence that the node really was isolated, rather than an assurance that
    // it was. Three independent facts: it was launched with no P2P identity and
    // no seed nodes (so `xchain-hub/src/api.js` builds no p2pConfig and
    // startP2P/startConsensus/startOracle all return immediately), its hub knew
    // no validators, and its hub held no price snapshot before a block was
    // replayed into it.
    async isolationEvidence() {
        const out = {
            p2pValidatorAddrSet: false,
            seedNodesSet:        false,
            hubSnapshotsAtBoot:  this['_hubSnapshotsAtBoot'],
            hubValidators:       null
        };
        try {
            const rows = await this['_conn'].query(
                'SELECT COUNT(*) AS c FROM `' + ident(this.hubDbName, 'database name') + '`.validators');
            out.hubValidators = Number(rows[0].c);
        } catch (internal) { out.hubValidators = null; }
        return out;
    }

    logTail(which) { return this['_tail'](which || 'indexer'); }
    }

    return ReplayNodeDriving.prototype
}
