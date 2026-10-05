'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

module.exports = function createReplayNodeBringUp(deps) {
    const { fs, os, path, mariadb, startDisposableHubDb, pickFreePorts, replayDbNames, ident, XChainIndexerConnector, applyPriceCapabilityRows, removePriceCapabilityRows, applyPriceCapabilityStakes, removePriceCapabilityStakes, CANONICAL_REORG_BUFFER, registerPriceCapabilityTarget, connectTo, readFeeCoordinates, readChainHeight } = deps

    class ReplayNodeBringUp {
    // ---- bring-up -------------------------------------------------------

    // Build the node. Returns true when it is usable, false with `unavailable`
    // set when a dependency this rig does not own is missing.
    async up() {
        const live = await this['_resolveLiveChain']();
        if (!live) return false;

        if (!this.hubDb) {
            this.hubDb = await startDisposableHubDb();
            this['_ownsHubDb'] = true;
            if (!this.hubDb) { this.unavailable = 'no env hub DB and Docker unavailable'; return false; }
        }

        const stamp = process.pid + '_' + Date.now().toString(36);
        const dbNames = replayDbNames(this.label, stamp);
        this.hubDbName     = dbNames.hub;
        this.indexerDbName = dbNames.indexer;
        this.mirrorDbName  = dbNames.mirror;

        this['_conn'] = await mariadb.createConnection({
            host: this.hubDb.host, port: parseInt(this.hubDb.port, 10),
            user: this.hubDb.user, password: this.hubDb.pass, connectTimeout: 10_000
        });
        // The mirror database is the one neither process creates for itself: the hub
        // makes its own, the indexer makes its own, and hub_db_sync only ever writes
        // into a database that is already there.
        await this['_conn'].query('CREATE DATABASE IF NOT EXISTS `' + ident(this.mirrorDbName, 'database name') + '`');
        await this['_provisionMirrorSchema']();

        // A neutral working directory. Both `src/api.js` files call dotenv.config(),
        // which reads `<cwd>/.env`; run from the checkout, the indexer would silently
        // inherit the standing stack's settings for every variable this rig does not
        // set, which is exactly the class of contamination AT2 exists to rule out.
        this['_cwd'] = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-at2-' + this.label + '-'));

        const [hubPort, indexerPort] = await pickFreePorts(2, this.basePort);
        this.hubPort     = hubPort;
        this.indexerPort = indexerPort;

        this['_live'] = live;
        // A node with no Bitcoin view cannot resolve who was eligible to sign a
        // batch, so it is not a configuration this rig can measure anything in. Say
        // so and SKIP, rather than running a comparison whose only possible outcome
        // is "neither node could judge a PRICE".
        if (!live.btcOracle) {
            this.unavailable = 'the stack hub names no bitcoin/' + this.network + ' indexer, so a node here ' +
                'could not be given the Bitcoin capability oracle chain-only reconstruction requires';
            return false;
        }
        this['_btcOracleProof'] = await this['_verifyBtcOracle'](live.btcOracle);
        if (!this['_btcOracleProof']) { this.unavailable = this.unavailable || 'BTC capability oracle unusable'; return false; }

        await this['_startHub']();
        await this['_startIndexer'](live);
        await this['_registerPriceCapability']();
        return true;
    }

    /**
     * Prove the endpoint this node's hub will trust is a BITCOIN indexer.
     *
     * This is the same question `XChainHub.indexerCoinMismatch` asks before it
     * lets a BTC-anchored read happen at all (`getblockhashes` is the one
     * federation read that names the chain it answers for), asked HERE as well so
     * the drill's evidence carries the answer instead of the operator having to
     * take the wiring on trust. A rig that had quietly pointed the hub at the
     * landing chain's own indexer, or switched the guard off, fails here.
     */
    async ['_verifyBtcOracle'](oracle) {
        try {
            const conn = new XChainIndexerConnector(oracle.host, oracle.port, oracle.apiKey);
            const hashes = await conn.call('getblockhashes', {});
            const coin = hashes && hashes.coin ? String(hashes.coin).toUpperCase() : null;
            if (coin !== 'BTC') {
                this.unavailable = 'the capability oracle at ' + oracle.url + ' reports coin "' + coin +
                    '", not BTC; a signer set resolved there would be another chain\'s state';
                return null;
            }
            return { url: oracle.url, coin: coin, network: hashes.network, height: Number(hashes.block_index) };
        } catch (e) {
            this.unavailable = 'the BTC capability oracle at ' + oracle.url + ' did not answer: ' + (e && e.message);
            return null;
        }
    }

    /**
     * Put this node's own hub-mirror database on the list of landing chains that
     * must carry the `price` capability snapshot, and take whatever set a venue in
     * this process has already published for.
     *
     * WHY A NODE NEEDS THIS AT ALL. Judging a PRICE batch means resolving the
     * qualifying signer set at the batch's signed BTC anchor, and off BTC that set
     * comes only from mirrored `capability_snapshots` (capability staking is
     * BTC-only). This node reads that table through its HUB_DB_* connection, which
     * is the MIRROR database, so that is where the rows have to be.
     *
     * WHY THE ROWS CANNOT ARRIVE THE PRODUCTION WAY HERE. In production the rows
     * are the hub's own persist at finalization, carried down by hub_db_sync. This
     * node's hub is empty by construction: no peers, no oracle round, nothing to
     * persist, so the mirror it re-pages is empty of them too. That is the point of
     * the rig, not a defect of it, and it is exactly why the precondition has to be
     * supplied as SETUP. The definition, and the full statement of what it stands in
     * for, live once in oracleBatchVenue; this only names the database.
     *
     * NOTHING ABOUT THE REPLAY CLAIM IS WEAKENED. The rows are a validator set, not
     * a price and not a verdict: every price_snapshots row this node holds is still
     * rebuilt from the chain by its own hub, and every action verdict is still
     * reached by its own indexer running the full parse, signature and quorum path.
     * Both nodes in a comparison register the same way, so neither is given an
     * advantage the other lacks.
     */
    async ['_registerPriceCapability']() {
        const table = '`' + ident(this.mirrorDbName, 'database name') + '`.capability_snapshots';
        const query = (sql, args) => this['_conn'].query(sql, args);
        this['_capabilityRows'] = [];
        this['_capabilityTarget'] = {
            label: 'AT2 node ' + this.label + ' (hub mirror + BTC capability oracle)',
            apply: async (rows) => {
                await applyPriceCapabilityRows(query, rows, table);
                this['_capabilityRows'] = rows.slice();
                // The node's HUB does not read the row above: it asks its Bitcoin
                // oracle. Both stores get the same set, which is the relationship
                // production keeps (the hub's Bitcoin read is what it later persists
                // and mirrors down for its indexer).
                this['_btcStakeRows'] = await applyPriceCapabilityStakes(await this['_btcOracleQuery'](), rows);
                await this['_probeBtcOracle'](rows);
            },
            remove: async (rows) => {
                await removePriceCapabilityRows(query, rows, table);
                if (this['_btcStakeRows'].length > 0) {
                    await removePriceCapabilityStakes(await this['_btcOracleQuery'](), this['_btcStakeRows']);
                    this['_btcStakeRows'] = [];
                }
            }
        };
        const applied = await registerPriceCapabilityTarget(this['_capabilityTarget']);
        if (applied > 0) {
            console.log('oracleBatchReplay[' + this.label + ']: applied ' + applied + ' `price` capability row(s) ' +
                'to this node\'s hub mirror AND to its Bitcoin capability oracle (setup standing in for the ' +
                'federation\'s own on-chain stake; see _registerPriceCapability).');
        }
    }

    // A query(sql, args) against the Bitcoin oracle's own database, opened once and
    // pinned to that schema so the row helpers never have to name it.
    async ['_btcOracleQuery']() {
        // Only a drill that publishes through oracleBatchVenue seeds a signer set
        // into the oracle, and only such a drill can name the oracle's database. A
        // node whose Bitcoin view is a REAL federation's indexer (the live-chain
        // override case) reads a real stake and seeds nothing, so reaching here
        // with no database means a seed was attempted against an oracle this node
        // has no write path to; say that rather than dying inside the driver.
        if (!this['_live'].btcOracle.db) {
            throw new Error('oracleBatchReplay[' + this.label + ']: this node\'s Bitcoin capability oracle was ' +
                'given no database, so a `price` capability seed cannot be applied to it. Only a drill that ' +
                'publishes its own federation through oracleBatchVenue needs that seed.');
        }
        if (!this['_btcOracleConn']) {
            this['_btcOracleConn'] = await connectTo(this['_live'].btcOracle.db);
            await this['_btcOracleConn'].query('USE `' + ident(this['_live'].btcOracle.db.name, 'database name') + '`');
        }
        return (sql, args) => this['_btcOracleConn'].query(sql, args);
    }

    /**
     * Ask the oracle the question the hub is about to ask, at the height the hub
     * will actually ask it at.
     *
     * MEASURED, NEVER ASSUMED. `CapabilitySnapshot.buriedBlockIndex` subtracts
     * CANONICAL_REORG_BUFFER before it resolves anything, so the height that
     * reaches the indexer is (anchor - buffer) and a set that exists only at the
     * anchor is invisible. Reading it back here turns "the seed should be visible"
     * into a number in the run's own log, and a mismatch between this count and the
     * federation's size is the first thing a red rung should be checked against.
     */
    async ['_probeBtcOracle'](rows) {
        const anchor = Number(rows[0].snapshotBlock);
        const buried = Math.max(0, anchor - CANONICAL_REORG_BUFFER);
        try {
            const oracle = this['_live'].btcOracle;
            const conn   = new XChainIndexerConnector(oracle.host, oracle.port, oracle.apiKey);
            const at = async (h) => {
                const r = await conn.call('getcapabilityvalidators',
                    { capability: 'price', block_index: h, min_stake: this['_priceMinStake'] });
                return (r && r.count !== undefined) ? Number(r.count) : ('error: ' + JSON.stringify(r).slice(0, 120));
            };
            const weightsAt = async (h) => {
                const r = await conn.call('getstakeweightsbycapability',
                    { capability: 'price', block_index: h, min_stake: this['_priceMinStake'] });
                if (Array.isArray(r)) return r.length;
                if (r && Array.isArray(r.validators)) return r.validators.length;
                if (r && r.count !== undefined) return Number(r.count);
                return 'error: ' + JSON.stringify(r).slice(0, 120);
            };
            this['_btcOracleProof'].anchorHeight    = anchor;
            this['_btcOracleProof'].queriedHeight   = buried;
            this['_btcOracleProof'].priceSetAtAnchor = await at(anchor);
            this['_btcOracleProof'].priceSetAtBuried = await at(buried);
            this['_btcOracleProof'].priceWeightSetAtAnchor = await weightsAt(anchor);
            this['_btcOracleProof'].priceWeightSetAtBuried = await weightsAt(buried);
            console.log('oracleBatchReplay[' + this.label + ']: Bitcoin capability oracle ' + oracle.url +
                ' (coin ' + this['_btcOracleProof'].coin + ', tip ' + this['_btcOracleProof'].height + ') answers the ' +
                '`price` set as ' + this['_btcOracleProof'].priceSetAtBuried + ' validator(s) at block ' + buried +
                ', the buried height CapabilitySnapshot resolves for a batch anchored at ' + anchor +
                ' (' + this['_btcOracleProof'].priceSetAtAnchor + ' at the anchor itself). The source-keyed weight ' +
                'read used under STAKE_WEIGHTED_QUORUM answers ' +
                this['_btcOracleProof'].priceWeightSetAtBuried + ' validator(s) at that buried height (' +
                this['_btcOracleProof'].priceWeightSetAtAnchor + ' at the anchor).');
            if (this['_btcOracleProof'].priceSetAtBuried > 0 &&
                this['_btcOracleProof'].priceWeightSetAtBuried === 0) {
                console.warn('oracleBatchReplay[' + this.label + ']: the two resolvers disagree at block ' + buried +
                    ': the count read sees ' + this['_btcOracleProof'].priceSetAtBuried + ' validator(s), while the ' +
                    'source-keyed weight read the hub gates on under STAKE_WEIGHTED_QUORUM sees nobody. A `0 ' +
                    'verified signers` refusal means the stake sources or their minimum weights need checking.');
            }
        } catch (e) {
            console.warn('oracleBatchReplay[' + this.label + ']: could not read the Bitcoin capability oracle ' +
                'back: ' + (e && e.message));
        }
    }

    // The fee destination this node was launched with, for the run's evidence.
    feeDestination() { return this['_live'] ? this['_live'].feeDestination : null; }

    // What this node's Bitcoin capability oracle is and what it answered: the URL,
    // the coin it reported for ITSELF, its tip, the height the hub resolves at once
    // the reorg burial is applied, and the size of the `price` set there.
    btcOracleEvidence() { return this['_btcOracleProof']; }

    // Which actions the STANDING chain charged a fee for, as chain coordinates.
    // See readFeeCoordinates for why the set has to come from a node with a
    // complete price history rather than from either side of the comparison.
    async liveChainFeeCoordinates(opts) {
        // The ONE reader of `liveIndexer`, which is why the field is optional: a
        // cross-node comparison (AT2) cannot run without a standing node to take
        // the fee-bearing coordinate set from, while a single-node observation
        // (the barrier drill) never asks. Refusing here names which of the two
        // this node was built for, instead of failing as a null host in the driver.
        if (!this['_live'] || !this['_live'].liveIndexer) {
            throw new Error('oracleBatchReplay[' + this.label + ']: this node was built with a live-chain override ' +
                'that names no `liveIndexer`, so the standing chain\'s fee-bearing coordinates cannot be read. ' +
                'A cross-node verdict comparison needs them; a single-node barrier observation does not.');
        }
        if (!this['_liveIndexerConn']) this['_liveIndexerConn'] = await connectTo(this['_live'].liveIndexer);
        return readFeeCoordinates(this['_liveIndexerConn'], this['_live'].liveIndexer.name, opts);
    }

    // The chain's own height, read from the decoder the node reads. This is the
    // number a caller needs to say "caught up", and it is deliberately not the
    // node's own progress: a node that is caught up and one that has stopped both
    // report a height that stops moving.
    async decoderHeight() {
        if (!this['_decoderConn']) this['_decoderConn'] = await connectTo(this['_live'].decoder);
        return readChainHeight(this['_decoderConn'], this['_live'].decoder.name);
    }

    /**
     * Give the mirror database its schema.
     *
     * NOBODY ELSE DOES THIS, and that is a real property of the code rather than
     * an oversight of this rig. `XChainIndexer.start()` calls verifyTables() on
     * `indexerDb` only, so the hub-mirror tables it creates land in the INDEXER's
     * database; the mirror `hubDb` is never touched. Left empty, HubDbSync's
     * bootstrap probes SHOW COLUMNS on each table, gets 1146, logs
     * "not ready for bootstrap ... will retry" forever, and the price barrier
     * never opens on mirror content. `hubDbWsMirror.integration.test.js` sets its
     * own replica up from the shipped DDL for exactly this reason, and this is
     * the same move.
     *
     * The WHOLE indexer schema is applied rather than only the seven mirrored
     * tables, because `hubDb` is not just hub_db_sync's target: the settlement
     * path reads stakes, delegations and validator_rewards through the same
     * connection (`db.js`'s `(indexer.hubDb || this)` idiom). In the single-host
     * topology that connection is a full schema, so making it one here is
     * matching production rather than padding.
     */
    async ['_provisionMirrorSchema']() {
        const dir = path.join(this.repoRoot, 'xchain-indexer', 'src', 'sql');
        const db  = ident(this.mirrorDbName, 'database name');
        await this['_conn'].query('USE `' + db + '`');
        let created = 0;
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.sql')) continue;
            // Strip the license block and every `--` comment before splitting: a
            // trailing comment can carry a ';' and would otherwise cut a CREATE TABLE
            // in half. Same reduction hubDbWsMirror's readDDL performs.
            const sql = fs.readFileSync(path.join(dir, file), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
            for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
                try { await this['_conn'].query(stmt); created++; }
                catch (e) { /* a DDL this schema version cannot apply is not this rig's to fix */ }
            }
        }
        this['_mirrorStatements'] = created;
    }

    // Discover the live chain's decoder database and node RPC, the only two
    // populated things a node here is given. Both are read-only and neither
    }

    return ReplayNodeBringUp.prototype
}
