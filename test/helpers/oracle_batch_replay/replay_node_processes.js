'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = function createReplayNodeProcesses(deps) {
    const { path, spawn, waitFor, processListening, BOOT_WAIT_MS, XChainHubConnector, ident, coinCode, LOG_TAIL_LINES } = deps

    class ReplayNodeProcesses {
    async ['_startHub']() {
        const capabilityConfig = this['_writeCapabilityConfig']();
        const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            HUB_DB_HOST:   this.hubDb.host,
            HUB_DB_PORT:   String(this.hubDb.port),
            HUB_DB_NAME:   this.hubDbName,
            HUB_DB_USER:   this.hubDb.user,
            HUB_DB_SECRET: this.hubDb.pass,
            HUB_PORT:      String(this.hubPort),
            HUB_HOST:      '127.0.0.1',
            HUB_NETWORK:   this.network,
            HUB_ALLOW_UNAUTHENTICATED: 'true',
            TELEMETRY_ENABLED: 'false',
            CORS_ORIGIN:   'http://localhost',

            // THE HUB'S PER-IP REQUEST CEILING, raised because of what this
            // deployment IS, not to get past a check.
            //
            // MEASURED: at the shipped default of 100 requests per minute a
            // chain-only node THROTTLES ITSELF. Its indexer walks the chain as fast
            // as it can and consults its own hub as it goes, so a replay crosses 100
            // requests in seconds, and the price_batch pushes then come back
            // "Too many requests" as a plain-text 429 the push client reports as
            // `Invalid JSON response: Unexpected token 'T'`. The reconstruction is
            // lost to an abuse guard rather than to anything about the chain.
            //
            // The ceiling is an abuse guard for a hub serving the public; this hub is
            // bound to 127.0.0.1 and its only client is the node's own indexer, which
            // is the single-node deployment the default is not sized for. It gates no
            // validation, no quorum and no verdict, and BOTH nodes in the comparison
            // get the identical value.
            HUB_RATE_LIMIT_RPM: '60000',

            // THE BITCOIN CAPABILITY ORACLE, wired the way a properly configured node
            // wires one: an explicit per-coin indexer URL, which is the first thing
            // `XChainHub.resolveIndexerUrl` consults. The hub still VERIFIES the
            // endpoint is a Bitcoin indexer for itself before it trusts a
            // BTC-anchored read (`indexerCoinMismatch`), and nothing here switches
            // that check off; _verifyBtcOracle asks the same question first so the
            // drill's own evidence carries the answer.
            BTC_INDEXER_API_URL: this['_live'].btcOracle.url,

            // Per-capability MIN_STAKE. Without it the hub's capability registry is
            // live but empty and every price snapshot is refused; see
            // _writeCapabilityConfig.
            HUB_CAPABILITY_CONFIG: capabilityConfig
        };
        if (this['_live'].btcOracle.apiKey) env.BTC_INDEXER_API_KEY = String(this['_live'].btcOracle.apiKey);
        this['_hubProc'] = this['_spawn']('hub', path.join(this.repoRoot, 'xchain-hub', 'src', 'api.js'), [], env);

        const up = await waitFor(
            () => processListening(this['_hubProc'], '127.0.0.1', this.hubPort),
            { timeoutMs: BOOT_WAIT_MS, intervalMs: 500 }
        );
        if (!up.ok) {
            throw new Error('oracleBatchReplay[' + this.label + ']: the fresh hub did not listen on 127.0.0.1:' +
                this.hubPort + ' within ' + up.waitedMs + 'ms.\n' + this['_tail']('hub'));
        }

        const connector = new XChainHubConnector(['http://127.0.0.1:' + this.hubPort]);
        if (!(await connector.ping())) {
            throw new Error('oracleBatchReplay[' + this.label + ']: the fresh hub listened on 127.0.0.1:' +
                this.hubPort + ' but did not answer ping.\n' + this['_tail']('hub'));
        }
        this.hubConnector = connector;

        // The zero this rig's whole claim rests on, measured rather than assumed:
        // how many price snapshots the fresh hub held BEFORE any block reached it.
        try {
            const rows = await this['_conn'].query(
                'SELECT COUNT(*) AS c FROM `' + ident(this.hubDbName, 'database name') + '`.price_snapshots');
            this['_hubSnapshotsAtBoot'] = Number(rows[0].c);
        } catch (internal) { this['_hubSnapshotsAtBoot'] = null; }
    }

    // The indexer, pointed at the live decoder (the chain) and at NOTHING else
    // that holds state. Three separate databases, and the distinction between the
    // last two is load-bearing: HUB_DB_* is the indexer's local MIRROR, which
    // hub_db_sync owns and re-pages from the hub on every bootstrap. Pointing it
    // at the hub's own authoritative database instead would put the hub's rows
    // under a replication client that deletes and repages them.
    async ['_startIndexer'](live) {
        const env = {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            INDEXER_COIN:    coinCode(this.coin),
            INDEXER_NETWORK: this.network,
            INDEXER_API_PORT: String(this.indexerPort),
            INDEXER_ALLOW_UNAUTHENTICATED: 'true',

            DECODER_DB_HOST: String(live.decoder.host),
            DECODER_DB_PORT: String(live.decoder.port),
            DECODER_DB_NAME: String(live.decoder.name),
            DECODER_DB_USER: String(live.decoder.user),
            DECODER_DB_PASS: String(live.decoder.pass),

            INDEXER_DB_HOST: this.hubDb.host,
            INDEXER_DB_PORT: String(this.hubDb.port),
            INDEXER_DB_NAME: this.indexerDbName,
            INDEXER_DB_USER: this.hubDb.user,
            INDEXER_DB_PASS: this.hubDb.pass,

            HUB_DB_HOST: this.hubDb.host,
            HUB_DB_PORT: String(this.hubDb.port),
            HUB_DB_NAME: this.mirrorDbName,
            HUB_DB_USER: this.hubDb.user,
            HUB_DB_PASS: this.hubDb.pass,
            HUB_DB_SYNC_ENABLED: 'true',
            HUB_API_URL: 'http://127.0.0.1:' + this.hubPort,

            NODE_URL:      String(live.node.host || '127.0.0.1'),
            NODE_PORT:     String(live.node.port || ''),
            NODE_USER:     String(live.node.user || ''),
            NODE_PASSWORD: String(live.node.pass || ''),

            UTXO_TRACKER_URL:      String(live.tracker.host || ''),
            UTXO_TRACKER_API_PORT: String(live.tracker.port || ''),

            // The push outbox retries on a 30s cadence by default. A replay pushes
            // a round the moment it parses one and then keeps walking blocks, so a
            // half-minute floor on the first retry is the difference between a
            // mirror that keeps up with the block loop and one that does not.
            HUB_PUSH_RETRY_INTERVAL_MS: '2000',
            HUB_PUSH_RETRY_BASE_MS:     '2000',
            HUB_DB_SYNC_POLL_INTERVAL:  '5000',

            CORS_ORIGIN: 'http://localhost'
        };

        // The chain's own fee destination, under both names the stack uses. See
        // _resolveFeeDestination: this is node configuration every node on one
        // network must share, and a node that replays with the pinned default
        // rejects every fee the chain accepted.
        if (live.feeDestination) {
            env['XCHAIN_FEE_DESTINATION_' + env.INDEXER_COIN + '_' + this.network.toUpperCase()] = live.feeDestination;
            env.FEE_DESTINATION = live.feeDestination;
        }

        // THE PRICE BARRIER, and why a caller may want to move it.
        //
        // MEASURED 2026-08-26 on DOGE regtest: with HUB_SYNC_WATERMARK_GRACE_S.price
        // at its new 4800, a chain-only node walks the whole history in minutes and
        // then STOPS dead at the first block younger than 4800 seconds, repeating
        // "Deferring block N (price time-sync) ... mirror max round timestamp 0,
        // stream watermark at <hub wall clock>" once a minute. The barrier's two
        // escapes are "the mirror holds a round at/past this block's time" (never,
        // for a node whose hub is empty) and "watermark >= blockTime + grace", and
        // the watermark is the hub's clock, so the node cannot reach a freshly mined
        // tip until 80 minutes of WALL time have passed. That is the documented
        // trade of raising the grace, now observed rather than predicted, and it
        // means a drill that publishes and then replays cannot finish inside a
        // sensible budget at the frozen value.
        //
        // The indexer sanctions a regtest-only override for exactly this
        // (`resolveWatermarkGrace`: "operator override honored ONLY on regtest (test
        // tunability)"), and it is IGNORED with a loud warning off regtest, so it can
        // never travel to a real network. Setting it lowers how much mirror coverage
        // a node insists on before processing a block, which is a real property, so
        // any comparison must give BOTH nodes the same value and a drill about the
        // barrier itself (AT5) must not set it at all.
        Object.assign(env, this.watermarkGraces);
        if (this.priceGraceS !== null) env.HUB_SYNC_PRICE_GRACE_S = String(this.priceGraceS);

        // --no-node-snapshot mirrors the package's own `api` script: the contract VM
        // binding will not load under a Node snapshot, and a replay of this chain
        // runs DEPLOY and EXECUTE.
        this['_indexerProc'] = this['_spawn']('indexer', path.join(this.repoRoot, 'xchain-indexer', 'src', 'api.js'),
            ['--no-node-snapshot'], env);

        // Ready when the node has written its own schema and started walking the
        // chain, which is the first moment `blocks` can be read at all.
        const up = await waitFor(async () => {
            if (this['_indexerProc'].exitCode !== null) return { ok: false, dead: true };
            try {
                const rows = await this['_conn'].query(
                    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [this.indexerDbName]);
                return { ok: Number(rows[0].c) > 0, tables: Number(rows[0].c) };
            } catch (internal) { return { ok: false }; }
        }, { timeoutMs: BOOT_WAIT_MS, intervalMs: 1000 });
        if (!up.ok) {
            throw new Error('oracleBatchReplay[' + this.label + ']: the fresh indexer never created its schema in ' +
                this.indexerDbName + ' within ' + up.waitedMs + 'ms.\n' + this['_tail']('indexer'));
        }
    }

    ['_spawn'](which, script, nodeArgs, env) {
        const proc = spawn(process.execPath, [...nodeArgs, script], {
            cwd: this['_cwd'], env: env, stdio: ['ignore', 'pipe', 'pipe']
        });
        const keep = (buf) => {
            const lines = String(buf).split('\n').filter((l) => l.length > 0);
            const log = this['_logs'][which];
            log.push(...lines);
            if (log.length > LOG_TAIL_LINES) log.splice(0, log.length - LOG_TAIL_LINES);
            // The hook sees every line as it arrives, before the ring drops it. A
            // run measured in hours produces far more than LOG_TAIL_LINES, so a
            // caller that needs a line class kept whole cannot get it from _tail.
            // Its failure is its own: a throwing hook must not kill the node.
            if (this['_onLog']) {
                for (const line of lines) {
                    try { this['_onLog'](which, line); } catch (internal) { /* a log hook cannot break the run */ }
                }
            }
        };
        proc.stdout.on('data', keep);
        proc.stderr.on('data', keep);
        proc.on('error', (e) => keep('spawn error: ' + (e && e.message)));
        return proc;
    }

    ['_tail'](which) {
        const log = this['_logs'][which] || [];
        return '  last ' + log.length + ' line(s) from the ' + which + ':\n    ' + log.join('\n    ');
    }
    }

    return ReplayNodeProcesses.prototype
}
