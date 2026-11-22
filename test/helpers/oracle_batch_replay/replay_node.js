'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const path = require('path')
const { watermarkGraceEnv } = require('./replay_naming')
const { envDescribesCoin } = require('./coin_configuration')
const helperDir = path.resolve(__dirname, '..')

class OracleBatchReplayNode {

    /**
     * @param opts.label          short name used in database names and log lines
     * @param opts.coin/network   chain to index (default dogecoin/regtest)
     * @param opts.basePort       port probe base for the node's hub API and indexer API
     * @param opts.hubDb          an already-started disposableHubDb handle to share.
     *                            Pass one when several nodes (and the publish venue)
     *                            run in the same drill, so the fixed-port container is
     *                            started and removed exactly once.
     * @param opts.repoRoot       monorepo root; defaults to the checkout this file is in
     * @param opts.priceGraceS    HUB_SYNC_PRICE_GRACE_S for this node, or null (default)
     *                            to leave the frozen protocol constant in force. The
     *                            indexer honours this override on regtest only and
     *                            documents it as test tunability; see the note on
     *                            `_startIndexer` for what setting it trades away, and
     *                            NEVER give two nodes in one comparison different values.
     * @param opts.watermarkGraces  { PRICE: s, ORACLE: s, BRIDGE: s, ... } set as
     *                            HUB_SYNC_<NAME>_GRACE_S, the same regtest-only override
     *                            for every barrier; priceGraceS still wins for PRICE.
     * @param opts.liveChain      the live-chain endpoints, supplied instead of discovered.
     *                            Same shape `_resolveLiveChain` returns; see there for why
     *                            a host may have to supply them and what is validated.
     * @param opts.useEnvCredentials  whether the harness environment's DECODER_DB_*,
     *                            INDEXER_DB_* and NODE_* describe this rig's coin.
     *                            Defaults to what the environment's own `COIN`
     *                            declares; see envDescribesCoin for why a wrong-coin
     *                            credential is worse than no credential.
     * @param opts.onLog          fn(which, line) called for every stdout/stderr line the
     *                            hub and indexer emit, so a long-running caller can keep
     *                            its own history of a line class (the price barrier's
     *                            deferrals, say) instead of racing the LOG_TAIL_LINES ring.
     */
    constructor(opts) {
        opts = opts || {};
        this.label    = String(opts.label || 'replay').replace(/[^A-Za-z0-9]/g, '');
        this.coin     = opts.coin    || 'dogecoin';
        this.network  = opts.network || 'regtest';
        this.basePort = opts.basePort || 61000;
        this.repoRoot = opts.repoRoot || path.resolve(helperDir, '../../..');
        this.priceGraceS = opts.priceGraceS === undefined ? null : opts.priceGraceS;
        this.watermarkGraces = watermarkGraceEnv(opts.watermarkGraces);
        this.liveChain   = opts.liveChain || null;
        this['_onLog']      = typeof opts.onLog === 'function' ? opts.onLog : null;

        // Whether the harness environment's credentials apply to THIS rig's coin.
        // Defaulted by what the environment declares rather than assumed, because
        // this rig's default coin is not the harness's (see envDescribesCoin).
        this.useEnvCredentials = opts.useEnvCredentials === undefined
            ? envDescribesCoin(this.coin)
            : !!opts.useEnvCredentials;
        // Which store each credential actually came from, and whether the oracle
        // answered at its credential tier. Reported rather than logged as values:
        // a drill that fails on authentication needs the store name, never the value.
        this.credentialSources     = null;
        this.configSecretsRedacted = null;
        this.liveIndexerUnavailable = null;

        // Why the node could not be built, when it could not be. Non-null means the
        // caller should SKIP: a node that never booted proves nothing either way.
        this.unavailable = null;

        this.hubDb        = opts.hubDb || null;
        this['_ownsHubDb']   = false;
        this.hubDbName    = null;   // the fresh hub's OWN authoritative database
        this.indexerDbName = null;  // the fresh indexer's own database
        this.mirrorDbName = null;   // what hub_db_sync writes the hub's tables down into

        this.hubPort     = null;
        this.indexerPort = null;

        this['_hubProc']     = null;
        this['_indexerProc'] = null;
        this['_logs']        = { hub: [], indexer: [] };
        this['_conn']        = null;   // to the disposable MariaDB (this node's three databases)
        this['_cwd']         = null;   // neutral working directory for the children
        this['_hubSnapshotsAtBoot'] = null;
        this['_live'] = null;          // resolved live-chain endpoints (decoder, node, tracker)
        // This node's registration on the `price` capability precondition list, and
        // the rows it last took. See _registerPriceCapability.
        this['_capabilityTarget'] = null;
        this['_capabilityRows']   = [];
        this['_decoderConn'] = null;
        this['_liveIndexerConn'] = null;
        // The Bitcoin capability oracle this node's hub resolves its signer sets
        // from: the connection its rows are seeded through, the rows written, and
        // the read-back that proves it is a Bitcoin indexer rather than a bypass.
        this['_btcOracleConn']  = null;
        this['_btcStakeRows']   = [];
        this['_btcOracleProof'] = null;
    }
}

function applyMethods(target, source) {
    const descriptors = Object.getOwnPropertyDescriptors(source)
    delete descriptors.constructor
    Object.defineProperties(target, descriptors)
}

module.exports = function createReplayNode(deps) {
    applyMethods(OracleBatchReplayNode.prototype, require('./replay_node_bring_up')(deps))
    applyMethods(OracleBatchReplayNode.prototype, require('./replay_node_configuration')(deps))
    applyMethods(OracleBatchReplayNode.prototype, require('./replay_node_processes')(deps))
    applyMethods(OracleBatchReplayNode.prototype, require('./replay_node_driving')(deps))
    applyMethods(OracleBatchReplayNode.prototype, require('./replay_node_teardown')(deps))
    return OracleBatchReplayNode
}
