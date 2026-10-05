'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = function createReplayNodeConfiguration(deps) {
    const { fs, path, helperDir, XChainHubConnector, XChainIndexerConnector, readHubConfigTree, coinCode, resolveServiceCredential, DEFAULT_BTC_INDEXER_API_PORT, loadHubModule } = deps

    class ReplayNodeConfiguration {
    // carries a verdict: the decoder holds blocks and transactions, the node
    // holds the chain.
    //
    // Endpoints come from the hub the standing stack already serves, exactly as
    // chainRail does, so no credential is written to a file or a command line.
    //
    // WHEN A CALLER HAS TO SUPPLY THEM INSTEAD (`opts.liveChain`). The discovery
    // below is one auth-gated read: `getAllConfig` is a sensitive hub call, and a
    // host whose standing hub carries no key (a shared CI host's may not) can answer
    // nothing, so a node could not be built there at all. The override is the same
    // shape this method returns, so nothing downstream can tell the two apart, and
    // it is VALIDATED rather than trusted: a half-filled override otherwise
    // surfaces as an indexer that boots and then indexes nothing, hours later.
    // A caller sources it from its own process environment, which keeps every
    // credential out of a file, a command line and this rig's log.
    async ['_resolveLiveChain']() {
        if (this.liveChain) return this['_validateLiveChain'](this.liveChain);

        let cfg = null;
        try {
            const hub = new XChainHubConnector(XChainHubConnector.parseEndpoints());
            if (!(await hub.ping())) {
                this.unavailable = 'stack hub unreachable, cannot discover the ' + this.coin + ' decoder database';
                return null;
            }
            // Asked at the CREDENTIAL TIER, so the passwords below can come from the
            // oracle itself rather than from a copy of it. See readHubConfigTree.
            const tree = await readHubConfigTree(hub);
            cfg = tree && tree.configs;
            this.configSecretsRedacted = !tree || tree.secretsRedacted;
        } catch (e) {
            this.unavailable = 'stack hub config lookup failed: ' + (e && e.message);
            return null;
        }
        const svc = cfg && cfg[this.coin] && cfg[this.coin][this.network];
        if (!svc) { this.unavailable = 'stack hub has no config for ' + this.coin + '/' + this.network; return null; }

        const code = coinCode(this.coin);
        const dec  = svc['xchain-decoder'] || {};
        const ixr  = svc['xchain-indexer'] || {};
        const nod  = svc['node'] || {};
        if (!dec.name) { this.unavailable = 'stack hub config carries no decoder database for ' + this.coin; return null; }

        // RESOLVED, never read straight off the tree. A redacted tier serves the
        // sentinel in place of every password here, and handing that to a child is
        // an indexer that boots, authenticates as nobody and sits at height 0 until
        // the drill times out. Refusing now, naming the store to fix, is the whole
        // difference between a diagnosable failure and a manufactured barrier result.
        const allowEnv = this.useEnvCredentials;
        const decCred = resolveServiceCredential({
            oracle: dec, coin: this.coin, network: this.network, allowEnv: allowEnv,
            passKey: 'DECODER_DB_PASS', userKey: 'DECODER_DB_USER',
            what: 'decoder database credential'
        });
        if (decCred.problem) { this.unavailable = decCred.problem; return null; }

        // The coin node's RPC credential. Same treatment, different store keys: this
        // one is what the replaying indexer dials the chain with.
        const nodeCred = resolveServiceCredential({
            oracle: nod, coin: this.coin, network: this.network, allowEnv: allowEnv,
            passKey: 'NODE_PASSWORD', userKey: 'NODE_USER',
            what: 'node RPC credential'
        });
        if (nodeCred.problem) { this.unavailable = nodeCred.problem; return null; }

        this.credentialSources = {
            decoder: decCred.source,
            node: nodeCred.source
        };

        // The hub stores the CONTAINER-internal database host; a host-side process
        // must use the published one, which is the same substitution chainRail makes.
        const dbHost = process.env.DATABASE_URL || '127.0.0.1';
        const dbPort = parseInt(process.env.DATABASE_PORT, 10) || 13306;

        // The standing indexer is read ONLY by a cross-node comparison, so an
        // unresolvable credential drops it to null with a reason rather than
        // failing the whole node: a drill that never opens it must not be blocked
        // by a store it does not need.
        let liveIndexer = null;
        if (ixr.name) {
            const ixrCred = resolveServiceCredential({
                oracle: ixr, coin: this.coin, network: this.network, allowEnv: allowEnv,
                passKey: 'INDEXER_DB_PASS', userKey: 'INDEXER_DB_USER',
                what: 'live indexer database credential'
            });
            if (ixrCred.problem) this.liveIndexerUnavailable = ixrCred.problem;
            else {
                liveIndexer = { host: dbHost, port: dbPort, name: ixr.name, user: ixrCred.user, pass: ixrCred.pass };
                this.credentialSources.liveIndexer = ixrCred.source;
            }
        }

        return {
            feeDestination: await this['_resolveFeeDestination'](code, ixr),
            decoder: { host: dbHost, port: dbPort, name: dec.name, user: decCred.user, pass: decCred.pass },
            liveIndexer: liveIndexer,
            btcOracle: this['_resolveBtcOracle'](cfg, dbHost, dbPort),
            node: Object.assign({}, nod, { user: nodeCred.user, pass: nodeCred.pass }),
            tracker: svc['xchain-utxo-tracker'] || {}
        };
    }

    /**
     * Check a caller-supplied live chain against the shape `_resolveLiveChain`
     * discovers, and normalize it to exactly that shape.
     *
     * FAIL HERE OR FAIL IN SIX HOURS. Every field below is read once, deep inside
     * a child process's environment: a missing decoder password is an indexer that
     * boots, connects to nothing and sits at height 0, and a missing btcOracle key
     * is a hub that refuses every signer-set read. Both read as "the barrier never
     * opened" in a drill's result, which is the one conclusion that must never be
     * manufactured by a typo in a launcher. So the shape is asserted before a
     * process is spawned, and the message names the field rather than the shape.
     *
     * `feeDestination` may be null (a chain whose fee destination is the pinned
     * default) but the KEY has to be present, because an omitted one is far more
     * likely a launcher that forgot it, and a node replaying with the wrong fee
     * destination rejects every fee the chain accepted (see _resolveFeeDestination).
     * `liveIndexer` is genuinely optional: only a cross-node comparison reads it.
     */
    ['_validateLiveChain'](live) {
        const at = (what) => 'oracleBatchReplay[' + this.label + ']: liveChain override is missing ' + what;
        const need = (obj, where, keys) => {
            if (!obj || typeof obj !== 'object') throw new Error(at('`' + where + '`'));
            for (const k of keys) {
                const v = obj[k];
                if (v === undefined || v === null || String(v) === '') throw new Error(at('`' + where + '.' + k + '`'));
            }
        };
        if (!live || typeof live !== 'object') throw new Error(at('everything: it is not an object'));
        need(live.decoder,   'decoder',   ['host', 'port', 'name', 'user', 'pass']);
        need(live.node,      'node',      ['host', 'port', 'user', 'pass']);
        need(live.tracker,   'tracker',   ['host', 'port']);
        need(live.btcOracle, 'btcOracle', ['host', 'port', 'url', 'apiKey']);
        if (!Object.prototype.hasOwnProperty.call(live, 'feeDestination')) throw new Error(at('`feeDestination`'));
        if (live.feeDestination !== null && typeof live.feeDestination !== 'string') {
            throw new Error(at('a usable `feeDestination`: it must be an address string or null, not ' +
                typeof live.feeDestination));
        }
        if (live.liveIndexer) need(live.liveIndexer, 'liveIndexer', ['host', 'port', 'name', 'user', 'pass']);
        return {
            feeDestination: live.feeDestination,
            decoder:     live.decoder,
            liveIndexer: live.liveIndexer || null,
            btcOracle:   Object.assign({ db: null }, live.btcOracle),
            node:        live.node,
            tracker:     live.tracker
        };
    }

    /**
     * The node's BITCOIN CAPABILITY ORACLE: the real BTC indexer its hub resolves
     * qualifying signer sets from.
     *
     * WHY EVERY NODE HERE HAS ONE. Judging a PRICE batch means resolving who was
     * eligible to sign it at the batch's own signed Bitcoin anchor, and capability
     * staking is Bitcoin-only by design. A Bitcoin indexer is therefore a stated
     * PRECONDITION of chain-only reconstruction, not a workaround for it: the
     * alternative would be a second trust path for validator identity that does not
     * go through Bitcoin, which is worse than scoping the claim.
     *
     * Discovered the way every other endpoint in this rig is, through the standing
     * hub's config oracle, so nothing is hardcoded and no credential is assembled
     * here. The one substitution is the API port: the hub stores the
     * CONTAINER-internal one, and a host-side process must dial the published one.
     */
    ['_resolveBtcOracle'](cfg, dbHost, dbPort) {
        const svc = cfg && cfg['bitcoin'] && cfg['bitcoin'][this.network];
        if (!svc) return null;
        const ixr = svc['xchain-indexer'] || {};
        if (!ixr.name) return null;
        const host = process.env.BTC_SERVICE_HOST || 'localhost';
        const port = parseInt(process.env.BTC_INDEXER_API_PORT, 10) || DEFAULT_BTC_INDEXER_API_PORT;
        return {
            host: host,
            port: port,
            url:  'http://' + host + ':' + port,
            ['apiKey']: process.env.BTC_INDEXER_API_KEY || process.env.INDEXER_API_KEY || null,
            db: { host: dbHost, port: dbPort, name: ixr.name, user: ixr.user, pass: ixr.pass }
        };
    }

    /**
     * The fee destination the chain's own fee-bearing actions are paid to.
     *
     * CONFIGURATION, NOT CHAIN STATE, and handing it to a chain-only node is not
     * a shortcut. `FEE_DESTINATION` is a consensus-pinned per-coin address with a
     * regtest-only env override (`resolveFeeDestination`, xchain-indexer
     * src/coins/index.js), so every node on one network MUST hold the same value
     * or their fee verdicts diverge by configuration rather than by replay. A node
     * launched without it uses the pinned default, and MEASURED 2026-08-26 that
     * left this rig with no `fees` row at all on either node: they agreed, but
     * about a chain neither of them was replaying.
     *
     * Taken from the standing node's `feeschedule` RPC, which nativeFeeHelper
     * already names as the source of truth ("the indexer reads its destination
     * from config.ADDRESS.FEE_DESTINATION, NOT from any env the e2e runner happens
     * to export"). The `fees` table is NOT usable for this: MEASURED on the same
     * day, all 235 of its rows carry a NULL destination_id.
     */
    async ['_resolveFeeDestination'](code, cfgIndexer) {
        try {
            const host = process.env[code + '_SERVICE_HOST'] || 'localhost';
            let port = process.env[code + '_INDEXER_API_PORT'];
            if (!port) {
                // Same lift the publish venue performs: the port convention in
                // chainRail.DEFAULT_PORTS is not what this stack actually publishes,
                // and the suite's own per-chain env file is.
                const file = path.resolve(helperDir, '../../.env.' + String(code).toLowerCase());
                if (fs.existsSync(file)) {
                    try { port = require('dotenv').parse(fs.readFileSync(file)).INDEXER_API_PORT; }
                    catch (internal) { /* fall through to the hub's own value */ }
                }
            }
            if (!port) port = cfgIndexer && cfgIndexer.port;
            if (!port) return null;
            const conn = new XChainIndexerConnector(host, port,
                process.env[code + '_INDEXER_API_KEY'] || process.env.INDEXER_API_KEY || null);
            const sched = await conn.call('feeschedule', {});
            if (!sched || sched.error || !sched.feeDestination) return null;
            return String(sched.feeDestination);
        } catch (e) {
            return null;
        }
    }

    // A hub with no validator address: no PeerManager, no PBFT, no OracleRound,
    // and therefore nothing that can put a price in its database except a push
    // arriving from a block. HUB_NETWORK is passed even though a standalone hub
    // reads it only through p2pConfig (see the header): a later version that fixes
    // that should find the right value already here.
    /**
     * The node's capability thresholds, written where the hub reads them.
     *
     * WHY A NODE MUST HAVE THIS TO JUDGE ANYTHING. A hub that has started its
     * capability registry and has NO threshold for a capability refuses to build a
     * snapshot for it at all (`CapabilitySnapshot.resolveMinStake` returns null
     * while `registryReady()` is true, which is a deliberate fail-closed: omitting
     * min_stake would let each indexer apply its own local floor and fork the
     * qualified set). `xchain-hub/src/api.js` calls startCapabilities on every hub,
     * standalone included, so a node launched with no HUB_CAPABILITY_CONFIG resolves
     * NO signer set for a price batch however healthy its Bitcoin oracle is. It is
     * ordinary node configuration, not a test lever.
     *
     * The values are lifted from the hub's OWN canonical coins registry rather than
     * typed here, so they cannot drift from the floor the hub asserts them against
     * (`assertCanonicalMinStakes`, which reads src/coins/BTC.js STAKING.CAPABILITIES).
     */
    ['_writeCapabilityConfig']() {
        const coins = loadHubModule('src/coins/index.js');
        // Staking is Bitcoin-anchored, so BTC's floors are the only ones that gate a
        // quorum, and the hub resolves them for 'mainnet' when its own network is
        // standalone (''). Match that resolution exactly.
        const cfg = coins.getCoinConfig('BTC', 'mainnet');
        const canonical = (cfg && cfg.STAKING && cfg.STAKING.CAPABILITIES) || null;
        if (!canonical) throw new Error('oracleBatchReplay: the hub coins registry carries no BTC STAKING.CAPABILITIES');
        const caps = {};
        for (const cap of Object.keys(canonical)) caps[cap] = { MIN_STAKE: String(canonical[cap].MIN_STAKE) };
        this['_priceMinStake'] = caps.price ? caps.price.MIN_STAKE : null;
        const file = path.join(this['_cwd'], 'capabilities.json');
        fs.writeFileSync(file, JSON.stringify({ CAPABILITIES: caps }, null, 2));
        return file;
    }
    }

    return ReplayNodeConfiguration.prototype
}
