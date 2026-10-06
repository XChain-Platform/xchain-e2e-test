'use strict';

const assert = require('assert');
const { bridgeVenueIndexerEnv } = require('./environment');
const { roleConfigFor } = require('./venue_helpers');
const { indexerCaughtUp } = require('./reorg_controls');

function buildVenueReads(deps) {
const { axios, mariadb, AttestMirrorVenue, chainRail } = deps;

class VenueMethods {
    async hubRpc(hubIndex, method, params) {
        const hub = this.hubs[hubIndex];
        assert.ok(hub, 'bridgeRailVenue: no hub ' + hubIndex);
        const res = await axios.post(hub.apiUrl,
            { jsonrpc: '2.0', id: Date.now(), method: method, params: params || {} },
            { timeout: 20000 });
        if (res.data && res.data.error) {
            throw new Error('bridgeRailVenue: hub ' + hubIndex + ' ' + method + ' answered error ' +
                JSON.stringify(res.data.error));
        }
        return res.data ? res.data.result : null;
    }

    /**
     * JSON-RPC against a venue indexer by chain code.
     */
    async indexerRpc(chain, method, params) {
        const url = this['_chainIndexerUrl'](chain);
        return this['_indexerRpcUrl'](chain, url, method, params);
    }

    async ['_indexerRpcUrl'](chain, url, method, params) {
        assert.ok(url, 'bridgeRailVenue: no venue indexer for ' + chain);
        const res = await axios.post(url,
            { jsonrpc: '2.0', id: Date.now(), method: method, params: params || {} },
            { timeout: 30000 });
        if (res.data && res.data.error) {
            throw new Error('bridgeRailVenue: ' + chain + ' indexer ' + method + ' answered error ' +
                JSON.stringify(res.data.error));
        }
        const result = res.data ? res.data.result : null;
        if (result && result.error) {
            throw new Error('bridgeRailVenue: ' + chain + ' indexer ' + method + ' refused: ' + result.error);
        }
        return result;
    }

    /**
     * `getbridgebalances` on one chain's venue indexer, with the serving indexer recorded.
     */
    async bridgeBalances(chain, tick) {
        const answer = await this.indexerRpc(chain, 'getbridgebalances', { tick: String(tick || 'XCHAIN') });
        this.servedBy('bridgebalances:' + chain, 'venue ' + chain + ' indexer ' + this['_chainIndexerUrl'](chain));
        return answer;
    }

    /**
     * `getbridgeinvariant` from one hub. Read from a hub rather than assembled here: the
     * in-flight term is the hub's own view of what it has signed and not yet seen applied,
     * and nothing outside the hub can rebuild it.
     */
    async bridgeInvariant(tick, hubIndex) {
        const answer = await this.hubRpc(hubIndex === undefined ? 0 : hubIndex,
            'getbridgeinvariant', tick ? { tick: String(tick) } : {});
        this.servedBy('bridgeinvariant', 'venue hub ' + (hubIndex === undefined ? 0 : hubIndex));
        return answer;
    }

    /**
     * A read against one venue indexer's own ledger database.
     *
     * Direct SQL rather than an RPC because the per-address balance the acceptance tests
     * assert on has no open read: `getbridgebalances` reports supply and the escrow roles,
     * and the drive needs an arbitrary address. The connection is to the venue's own
     * disposable MariaDB, never the standing stack's.
     */
    async queryIndexerDb(chain, sql, params) {
        const ix = this['_chainIndexer'](chain);
        assert.ok(ix, 'bridgeRailVenue: no venue indexer for ' + chain);
        return this['_queryIndexerDb'](ix, sql, params);
    }

    async ['_queryIndexerDb'](ix, sql, params) {
        const db = this.hubDb;
        assert.ok(db, 'bridgeRailVenue: the venue has no hubDb; it is not started');
        assert.ok(/^[A-Za-z0-9_]+$/.test(String(ix.indexerDbName)),
            'bridgeRailVenue: refusing an unsafe database identifier ' + ix.indexerDbName);
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(ix.indexerDbName), connectTimeout: 10000,
            });
            return await conn.query(sql, params || []);
        } finally {
            if (conn) await conn.end().catch(() => {});
        }
    }

    /**
     * Replay one borrowed chain from genesis into a new venue database.
     *
     * The returned handle owns only the replay indexer. Its database and process are
     * separate from the live venue indexer, while both follow the same venue hubs.
     */
    async replayIndexer(chain) {
        const tick = String(chain).toUpperCase();
        const coins = { BTC: 'bitcoin', DOGE: 'dogecoin', LTC: 'litecoin' };
        assert.ok(coins[tick], 'bridgeRailVenue: unsupported replay chain ' + chain);
        const liveIx = this['_chainIndexer'](tick);
        assert.ok(liveIx, 'bridgeRailVenue: no live venue indexer to replay ' + tick);
        const rail = tick === 'BTC' ? this.btcRail : (tick === 'DOGE' ? this.dogeRail : this.ltcRail);
        assert.ok(rail, 'bridgeRailVenue: no ' + tick + ' rail is available for replay');
        const serial = ++this['_replaySerial'];
        const replay = new AttestMirrorVenue({
            // Short enough that the stamped replay database names stay under MariaDB's 64.
            label: this.label.replace(/^bridgerail/, 'br') + tick.toLowerCase() + 'rp' + serial,
            coin: coins[tick],
            network: this.network,
            attachHubs: this.btcVenue.hubs,
            hubDb: this.btcVenue.hubDb,
            indexerCount: 1,
            useEnvDecoderCredential: tick === 'BTC',
            basePort: this.basePort + 600 + (serial * 200),
            graces: {},
            repoRoot: this.repoRoot || undefined,
            freshIndexers: true,
            replayChain: true,
            seedAttachedHubPrices: true,
            indexerExtraEnv: bridgeVenueIndexerEnv({ indexerUrls: {
                BTC: this.btcIndexerUrl(), DOGE: this.dogeIndexerUrl(), LTC: this.ltcIndexerUrl(),
            }, admission: this.admission.indexer }),
        });
        try {
            const up = await chainRail.withRail(rail, () => replay.start());
            if (!up) throw new Error('bridgeRailVenue: replay ' + tick + ' indexer did not start: ' +
                String(replay.unavailable || 'unknown reason'));
            const replayIx = replay.indexers[0];
            assert.ok(replayIx, 'bridgeRailVenue: replay ' + tick + ' venue built no indexer');
            assert.notStrictEqual(String(replayIx.indexerDbName), String(liveIx.indexerDbName),
                'bridgeRailVenue: replay ' + tick + ' must use a fresh database');
            const tip = await this.indexerRpc(tick, 'getblockhashes', {});
            const target = indexerCaughtUp(null, tip && tip.block_index).want;
            await this.waitUntil('the replay ' + tick + ' indexer to reach live venue block ' + target,
                async () => {
                    const answer = await this['_indexerRpcUrl'](tick, replayIx.apiUrl, 'getblockhashes', {});
                    return indexerCaughtUp(answer && answer.block_index, target).caughtUp;
                }, { timeoutMs: 14400000, everyMs: 2000 });
            let stopped = false;
            const handle = {
                chain: tick, indexer: replayIx, databaseName: replayIx.indexerDbName,
                queryDb: (sql, params) => this['_queryIndexerDb'](replayIx, sql, params),
                stop: async () => {
                    if (stopped) return;
                    stopped = true;
                    this['_replayVenues'].delete(handle);
                    await replay.stop();
                },
            };
            this['_replayVenues'].add(handle);
            return handle;
        } catch (e) {
            await replay.stop().catch(() => {});
            throw e;
        }
    }

    /**
     * The balance one address holds in one tick, on one venue indexer, as a decimal string.
     *
     * Credits minus debits rather than a `balances` projection, because that is the sum the
     * ledger itself is built from and it cannot disagree with the rows an assertion quotes.
     * Returns '0' for an address the chain has never seen, which is the honest reading: an
     * absent row and a zero balance are the same claim about spendable units.
     */
    async addressBalance(chain, address, tick) {
        const rows = await this.queryIndexerDb(chain,
            `SELECT
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses ad ON (ad.id=c.address_id)
                    INNER JOIN index_tickers   ti ON (ti.id=c.tick_id)
                    WHERE ad.address=? AND ti.tick=?) AS cr,
                (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses ad ON (ad.id=d.address_id)
                    INNER JOIN index_tickers   ti ON (ti.id=d.tick_id)
                    WHERE ad.address=? AND ti.tick=?) AS dr`,
            [String(address), String(tick), String(address), String(tick)]);
        if (!rows.length) return '0';
        const cr = Number(rows[0].cr), dr = Number(rows[0].dr);
        return String(cr - dr);
    }

    /**
     * The token row for a tick on one chain, projected to the PARAMETERS.
     *
     * AT1 asserts the DOGE row "matches BTC's parameters byte for byte". `SELECT *` cannot
     * state that: a token row carries per-chain facts that MUST differ, and comparing them
     * would make the assertion impossible to pass rather than meaningful. So the projection
     * is every column of `tokens` MINUS the exclusion set below, taken from the live schema
     * rather than a list retyped here, which is what keeps a column added tomorrow inside
     * the comparison instead of silently outside it.
     *
     * THE EXCLUSIONS, each with the reason it is one:
     *   id, tick_id                per-chain surrogate keys into that chain's own tables
     *   action_index,
     *   last_action_index          the consensus action index the row was created at, which
     *                              is a different position in a different chain's history
     *   supply                     BTC holds every unit ever minted; a foreign chain holds
     *                              the shadow of its escrow. Equal supplies would be the bug
     *   owner_id                   an id into THIS chain's index_addresses. The owner is
     *                              compared by ROLE instead (see ownerRole below), because
     *                              ADDRESS.GAS is a different string on every chain
     *   coin_price, coin_floor     market state, not an issuance parameter
     *   bridged                    set by the first applied v3 lock, per chain by definition
     *   escrow_action_index        an ORDER/SWAP/DISPENSER holding ownership, per chain
     *
     * @returns {Promise<{params: object, ownerAddress: (string|null)}|null>}
     */
    async tokenParameters(chain, tick) {
        const EXCLUDE = new Set(['id', 'tick_id', 'action_index', 'last_action_index', 'supply',
            'owner_id', 'coin_price', 'coin_floor', 'bridged', 'escrow_action_index']);
        const rows = await this.queryIndexerDb(chain,
            `SELECT tk.*, ad.address AS owner_address
             FROM tokens tk
             INNER JOIN index_tickers ti ON (ti.id=tk.tick_id)
             LEFT  JOIN index_addresses ad ON (ad.id=tk.owner_id)
             WHERE ti.tick=? LIMIT 1`,
            [String(tick)]);
        if (!rows.length) return null;
        const row = rows[0];
        const params = {};
        for (const key of Object.keys(row)) {
            if (EXCLUDE.has(key) || key === 'owner_address') continue;
            // Normalised to a string so a driver that hands back BigInt on one chain and
            // Number on the other cannot fail an assertion about the LEDGER.
            params[key] = row[key] === null || row[key] === undefined ? null : String(row[key]);
        }
        return { params: params, ownerAddress: row.owner_address === undefined ? null : row.owner_address };
    }

    /**
     * The address one protocol role resolves to on a chain, read from the INDEXER'S OWN
     * per-chain config module in this tree.
     *
     * NOT an RPC, and the first cut's `getinfo` was the bug: the indexer serves no such
     * method (measured on the rail 2026-09-12, `-32601 Method not found - getinfo`), and
     * its allowlist has no read that answers the ADDRESS role map at all. The addresses
     * are compile-time constants of `src/coins/<COIN>.js` per network, so the honest
     * source is the same module the running indexer resolved them from: a difference
     * between this read and the indexer's behaviour would be a difference between two
     * loads of one file, which is not a thing that happens.
     *
     * Loaded lazily so the pure layer stays requirable without the indexer on disk.
     */
    async roleAddress(chain, role) {
        const config = roleConfigFor(chain, this.network);
        const addresses = (config && config.ADDRESS) || {};
        return addresses[String(role)] === undefined ? null : addresses[String(role)];
    }

    /**
     * Does this chain's ledger hold a row for `tick` at all? AT1's precondition.
     */
    async hasTokenRow(chain, tick) {
        const rows = await this.queryIndexerDb(chain,
            'SELECT 1 AS present FROM tokens tk INNER JOIN index_tickers ti ON (ti.id=tk.tick_id) ' +
            'WHERE ti.tick=? LIMIT 1', [String(tick)]);
        return rows.length > 0;
    }

    /**
     * Hold until the DESTINATION indexer has APPLIED the leg named by `transferId`.
     *
     * WHY THIS IS A SEPARATE BARRIER FROM `waitForFinalizedTransfer`, measured on the rail
     * 2026-09-12 rather than reasoned about. A finalized `bridge_transfers` row means the
     * FEDERATION agreed; it says nothing about the destination. Between the two sit the
     * hub push, the destination's mirror sync, the D2 escrow-proof fetch and the block the
     * v2 in leg is injected into. AT1 read the destination balance the instant the hub row
     * appeared, got 0, and reported "the DOGE balance did not gain exactly 5" for a mint
     * that had not been attempted yet: a real assertion failing on a fixture race, which is
     * the most expensive kind of red because it reads as a protocol fault.
     *
     * BY THE SETTLEMENT ROW, keyed on the transfer id, never by watching a balance move.
     * `bridge_settlements` is the destination's own record that it applied THIS leg, so the
     * wait cannot be satisfied by some other credit arriving, and the row it returns carries
     * the block the leg landed in, which the evidence quotes.
     *
     * AND THE WAIT IS LONG BY DESIGN, so the budget is not a guess. The hub stamps
     * `effective_time = now + relayMarginFloorS(destChain)` and every indexer applies the
     * row at the first block whose time reaches it (xchain-hub src/lib/relay_margin.js:
     * 4 nominal blocks of the DESTINATION chain, so 240s to DOGE and 2400s to BTC), and
     * off mainnet the block time a handler compares against is median-time-past, which
     * lags the tip by roughly half the median window. Measured on the rail 2026-09-12:
     * a lock finalized at 17:38:02 carried effective_time 17:42:02. So an out leg to BTC
     * needs the better part of an hour and a budget under that reports "never applied"
     * for a transfer that was on schedule.
     *
     * @param {string} chain       destination chain code, as the venue spells it
     * @param {string} transferId  `bridge_transfers.transfer_id`
     * @returns {Promise<object|null>} the settlement row, or null on timeout
     */
}

const descriptors = Object.getOwnPropertyDescriptors(VenueMethods.prototype);
delete descriptors.constructor;
return descriptors;
}

module.exports = buildVenueReads;
