'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = function createReplayNodeTeardown(deps) {
    const { fs, ident, removePriceCapabilityStakes, unregisterPriceCapabilityTarget } = deps

    class ReplayNodeTeardown {
    // ---- teardown -------------------------------------------------------

    // Give everything back, in reverse order, never letting one failure skip the
    // rest. Both processes die, all three databases are dropped, the neutral
    // working directory goes, and the shared MariaDB handle is only stopped by
    // the node that started it.
    async down() {
        const problems = [];
        const attempt = async (label, fn) => {
            try { await fn(); } catch (e) { problems.push(label + ': ' + (e && e.message)); }
        };

        // Off the capability-target list first, so a venue still coming up cannot
        // push rows into databases this teardown is about to drop.
        if (this['_capabilityTarget']) {
            await attempt('capability target unregister', async () => unregisterPriceCapabilityTarget(this['_capabilityTarget']));
            this['_capabilityTarget'] = null;
        }
        // The hub-mirror rows need no DELETE: all three of this node's databases are
        // dropped below, which takes them with it. The Bitcoin capability oracle is
        // the STANDING stack's, so its rows are the one thing this node has to give
        // back by hand, and giving them back is what keeps a drill's federation out
        // of every later reader's validator set.
        if (this['_btcStakeRows'].length > 0) {
            const rows = this['_btcStakeRows'];
            this['_btcStakeRows'] = [];
            await attempt('btc capability oracle seed cleanup', async () =>
                removePriceCapabilityStakes(await this['_btcOracleQuery'](), rows));
        }

        await attempt('indexer stop', async () => this['_kill'](this['_indexerProc']));
        await attempt('hub stop',     async () => this['_kill'](this['_hubProc']));
        this['_indexerProc'] = this['_hubProc'] = null;

        if (this['_conn']) {
            for (const name of [this.mirrorDbName, this.indexerDbName, this.hubDbName]) {
                if (!name) continue;
                await attempt('drop ' + name, async () =>
                    this['_conn'].query('DROP DATABASE IF EXISTS `' + ident(name, 'database name') + '`'));
            }
            await attempt('conn close', async () => this['_conn'].end());
            this['_conn'] = null;
        }
        if (this['_decoderConn']) {
            await attempt('decoder conn close', async () => this['_decoderConn'].end());
            this['_decoderConn'] = null;
        }
        if (this['_liveIndexerConn']) {
            await attempt('live indexer conn close', async () => this['_liveIndexerConn'].end());
            this['_liveIndexerConn'] = null;
        }
        // The oracle's database is the standing stack's, not this rig's, so its
        // seeded rows are removed explicitly (the unregister above already did it)
        // and only the connection is given back here.
        if (this['_btcOracleConn']) {
            await attempt('btc oracle conn close', async () => this['_btcOracleConn'].end());
            this['_btcOracleConn'] = null;
        }

        if (this['_cwd']) {
            await attempt('cwd', async () => fs.rmSync(this['_cwd'], { recursive: true, force: true }));
            this['_cwd'] = null;
        }
        if (this.hubDb && this['_ownsHubDb']) {
            await attempt('hub db stop', async () => this.hubDb.stop());
            this.hubDb = null;
        }

        if (problems.length > 0) console.warn('oracleBatchReplay[' + this.label + ']: teardown problems: ' + problems.join(' | '));
        return problems;
    }

    async ['_kill'](proc) {
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
        const ended = new Promise((resolve) => proc.once('exit', resolve));
        proc.kill('SIGTERM');
        const settled = await Promise.race([ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 15_000))]);
        if (!settled) { proc.kill('SIGKILL'); await ended; }
    }
    }

    return ReplayNodeTeardown.prototype
}
