'use strict';

const assert = require('assert');
const { SEED_ROUND_BASE, COIN_USD_SEED } = require('./constants');

function buildVenueTransferReads(deps) {
const { mariadb, xchainPrice, verdictOf } = deps;

class VenueMethods {
    async waitForBridgeApplied(chain, transferId, opts) {
        const o = opts || {};
        const deadline = Date.now() + Number(o.timeoutMs ||
            (String(chain).toUpperCase() === 'BTC' ? 70 : 25) * 60 * 1000);
        const id = String(transferId);
        while (Date.now() < deadline) {
            let rows = [];
            try {
                rows = await this.queryIndexerDb(chain,
                    'SELECT * FROM bridge_settlements WHERE transfer_id = ? LIMIT 1', [id]);
            } catch (e) {
                // A destination that has not built the table yet has certainly not applied
                // the leg, which is the same answer as an empty result.
                rows = [];
            }
            if (rows.length) {
                this.servedBy('bridgesettlement:' + chain, 'venue ' + chain + ' indexer ' +
                    this['_chainIndexerUrl'](chain));
                return rows[0];
            }
            await new Promise((r) => setTimeout(r, 3000));
        }
        return null;
    }

    /**
     * Poll a venue hub's `bridge_transfers` for a finalized row naming `txHash`.
     *
     * BY PERSISTED ROW, never by event, which is the shape the multi-hub PBFT case in
     * bridgeTransferE2E already uses: a finalized row is what the mirror carries and what
     * an indexer applies, while a round event is an artifact of one hub's process.
     *
     * AND ACROSS EVERY HUB, not just hub 0, because the four do not agree. Measured on the
     * rail 2026-09-12: round `2764c037` finalized `BTC:99 -> DOGE 5 XCHAIN (3 sigs)` and
     * hubs 1, 2 and 3 each wrote the row while hub 0, the one that was not among the three
     * signers, wrote nothing and logged nothing. A poll of hub 0 alone therefore reported
     * "no bridge_transfers row was finalized by the venue federation" for a transfer the
     * federation had finalized four minutes earlier. Which hub is left out is a property of
     * the round, so a drive must ask all of them; `finalizedOn` records who answered, since
     * a row present on some hubs and absent on others is itself a finding.
     *
     * @returns {Promise<object|null>} the row, or null on timeout
     */
    async waitForFinalizedTransfer(match, opts) {
        const o = opts || {};
        const deadline = Date.now() + Number(o.timeoutMs || 240000);
        assert.ok(this.hubs.length, 'bridgeRailVenue: no hub database to poll');
        let last = null;
        while (Date.now() < deadline) {
            const seen = [];
            let found = null;
            for (const hub of this.hubs) {
                let rows = [];
                try {
                    rows = await this.queryHubDb(hub.dbName,
                        'SELECT * FROM bridge_transfers ORDER BY id DESC LIMIT 50');
                } catch (e) { rows = []; }
                for (const row of rows) {
                    if (!match(row)) continue;
                    seen.push(hub.index);
                    if (!found) found = row;
                }
                last = { hub: hub.index, rows: rows.length };
            }
            if (found) { found.finalizedOn = seen; return found; }
            await new Promise((r) => setTimeout(r, 2000));
        }
        this['_lastTransferPoll'] = last;
        return null;
    }

    /**
     * Re-seed the venue hubs' COIN/USD prices, so a DOGE action later in a long drive is
     * still priced.
     *
     * THE PRICE GOES STALE IN THIRTY MINUTES AND THIS DRIVE IS LONGER THAN THAT. The venue
     * seeds DOGE/USD and XCHAIN/USD once at bring-up and its oracle publishes nothing
     * afterwards (`OraclePublisher: no broadcast pipeline configured ... round will remain
     * queued`), while every ISSUE prices its fee against a quote no older than 1800 s. AT2's
     * out leg alone costs forty minutes waiting out the BTC relay margin, so AT5's FUFU
     * issue landed fifty-one minutes after bring-up and was refused `invalid: no current
     * oracle price for DOGE/USD (missing or stale beyond 1800s)`, measured on drive 10. That
     * is a property of the FIXTURE's clock, not of the bridge, so the fixture refreshes it
     * rather than the drive adapting its assertions to it.
     *
     * AND THE HUB ROW IS NOT WHERE THE INDEXER READS. Drive 18 reseeded before every case and
     * AT5 was still refused, with the hub's DOGE/USD row measured 285 s old at the time: the
     * indexer prices off its own MIRROR of `price_snapshots`, the mirror takes live rows only
     * from the WebSocket events a hub emits for rows IT writes, and a row the harness upserts
     * straight into the hub database is announced to nobody. The venue's bring-up seed
     * updates the same two rounds in place, so the mirror kept its bring-up copy until the
     * next hub restart re-paged the table (05:03 and 05:57 on that drive; AT5 sat at 05:51).
     * AT7's lock died the same way on the BTC side, refused `no current oracle price for
     * BTC/USD` by the venue BTC indexer 54 minutes after bring-up.
     *
     * So this writes NEW rounds (a fresh id per row, above every earlier seed so the
     * highest-round selection in getLatestPrice takes them), then cuts each venue indexer's
     * proxied hub sockets so its mirror reconnects and re-pages `price_snapshots`, which is a
     * FULL_REPAGE table on the indexer side, and then HOLDS until each mirror actually holds
     * the new round for the pairs its chain prices. That last wait is the difference between
     * a reseed that happened and a reseed that took, which is what drive 18 could not tell.
     *
     * @param {object} [opts] {timeoutMs} for the mirror confirmation, default 180 s
     * @returns {Promise<object|null>} {round, blockTimestamp, hubsSeeded, mirrors: {BTC, DOGE}}
     *   where each mirror entry is {confirmed, afterMs, pairs}; null when the venue is not up
     */
    async refreshVenuePrices(opts) {
        const o = opts || {};
        if (!this.btcVenue || !this.hubs.length) return null;
        xchainPrice.refuseSeedIfSuppressed('bridgeRailVenue.refreshVenuePrices');
        const hubDbName = this.hubs[0].dbName;
        // The next unused seed round above the venue's own bring-up seeds (9000001 and
        // 9000002 in attestMirrorVenue._seedHubPrices), read off the hub rather than counted
        // here so a second venue in the same process cannot collide with the first.
        const maxRows = await this.queryHubDb(hubDbName,
            'SELECT MAX(round_number) AS r FROM price_snapshots WHERE round_number >= ?', [SEED_ROUND_BASE]);
        const round = Math.max(SEED_ROUND_BASE + 100, Number((maxRows[0] && maxRows[0].r) || 0) + 1);
        // Anchored a minute BEHIND the wall clock: the indexer selects rows whose
        // block_timestamp is at or before the DOGE block's own time, and a regtest block
        // mined seconds after this write carries a time that can trail this host by a few
        // seconds. Sixty seconds of slack costs one minute of the 1800 s window.
        const ts = Math.floor(Date.now() / 1000) - 60;
        const pairs = [['BTC/USD', COIN_USD_SEED], ['DOGE/USD', COIN_USD_SEED],
                       ['XCHAIN/USD', xchainPrice.BOOTSTRAP_XCHAIN_USD]];
        let hubsSeeded = 0;
        for (const hub of this.hubs) {
            for (const [pair, price] of pairs) {
                await this.queryHubDb(hub.dbName,
                    'INSERT INTO price_snapshots ' +
                    '(round_number, coin_pair, price, reference_block, reference_chain, ' +
                    ' block_timestamp, validator_count, consensus_round, consensus_proof, status) ' +
                    "VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '[]', 'finalized') " +
                    'ON DUPLICATE KEY UPDATE price = VALUES(price), status = VALUES(status), ' +
                    ' block_timestamp = VALUES(block_timestamp)',
                    [round, pair, price, ts]);
            }
            hubsSeeded++;
        }
        // The delivery half: see the header. Every venue indexer follows a hub through the
        // harness's own mirror proxy, and dropping its sockets is the lever the ZC4 row
        // injection already relies on (attestMirrorVenue.injectMirrorRow).
        const followers = [];
        for (const v of [this.btcVenue, this.dogeVenue]) {
            if (!v || !Array.isArray(v.indexers)) continue;
            for (const ix of v.indexers) {
                if (ix && ix.mirrorProxy && typeof ix.mirrorProxy.dropSockets === 'function') {
                    ix.mirrorProxy.dropSockets();
                    followers.push(ix);
                }
            }
        }
        const need = { BTC: ['BTC/USD', 'XCHAIN/USD'], DOGE: ['DOGE/USD', 'XCHAIN/USD'] };
        const mirrors = {};
        const started = Date.now();
        const deadline = started + Number(o.timeoutMs || 180000);
        for (const chain of ['BTC', 'DOGE']) {
            const ix = chain === 'BTC' ? this.btcIndexer() : this.dogeIndexer();
            if (!ix) continue;
            let confirmed = false;
            let lastError = null;
            while (Date.now() < deadline && !confirmed) {
                try {
                    let held = 0;
                    for (const pair of need[chain]) {
                        const rows = await this.queryMirrorDb(chain,
                            'SELECT block_timestamp FROM price_snapshots ' +
                            "WHERE coin_pair = ? AND round_number = ? AND status = 'finalized' LIMIT 1",
                            [pair, round]);
                        if (rows.length && Number(rows[0].block_timestamp) === ts) held++;
                    }
                    confirmed = held === need[chain].length;
                } catch (e) { lastError = String(e && e.message).slice(0, 160); }
                if (!confirmed) await new Promise((r) => setTimeout(r, 2000));
            }
            mirrors[chain] = { confirmed: confirmed, afterMs: Date.now() - started, pairs: need[chain],
                               lastError: confirmed ? null : lastError };
        }
        return { round: round, blockTimestamp: ts, hubsSeeded: hubsSeeded,
                 followersDropped: followers.length, mirrors: mirrors };
    }

    /**
     * The freshest finalized quote ONE VENUE INDEXER'S MIRROR holds for a pair, and its age.
     *
     * The reading `readVenuePrice` cannot give: that one reads the hub, and the hub's row
     * being fresh is exactly what drive 18 recorded while the indexer refused a stale one.
     * A priced action is graded against this table and no other, so this is the number a
     * refusal must be read against.
     *
     * @param {string} chain BTC or DOGE, the venue indexer whose mirror is read
     * @param {string} pair  e.g. 'DOGE/USD'
     * @returns {Promise<object|null>} {chain, pair, price, round, blockTimestamp, ageSeconds,
     *   stale, rowCount} or null when that venue indexer is not up
     */
    async readMirrorPrice(chain, pair) {
        const ix = this['_chainIndexer'](chain);
        if (!ix) return null;
        let rows = [];
        try {
            rows = await this.queryMirrorDb(chain,
                'SELECT round_number, price, block_timestamp FROM price_snapshots ' +
                "WHERE coin_pair = ? AND status = 'finalized' AND price IS NOT NULL " +
                'ORDER BY round_number DESC LIMIT 1', [String(pair)]);
        } catch (e) {
            return { chain: String(chain), pair: String(pair), price: null, round: null, blockTimestamp: null,
                     ageSeconds: null, stale: true, rowCount: 0, error: String(e && e.message).slice(0, 160) };
        }
        const now = Math.floor(Date.now() / 1000);
        if (!rows.length) {
            return { chain: String(chain), pair: String(pair), price: null, round: null, blockTimestamp: null,
                     ageSeconds: null, stale: true, rowCount: 0 };
        }
        const ts = Number(rows[0].block_timestamp);
        return { chain: String(chain), pair: String(pair), price: String(rows[0].price),
                 round: Number(rows[0].round_number), blockTimestamp: ts, ageSeconds: now - ts,
                 // The handler's own window (native_fee.js maxAgeSeconds), measured against
                 // the wall clock the next regtest block will carry.
                 stale: (now - ts) > 1800, rowCount: rows.length };
    }

    /**
     * The freshest finalized quote a venue hub holds for one pair, and how old it is RIGHT NOW.
     *
     * MEASURED BEFORE EVERY RESEED, so the reseed cannot hide why a priced action was refused.
     * `refreshVenuePrices` above is the right fix for a quote that has aged past the 1800 s
     * window, and it is also a perfect mask: call it in front of a case and a refusal caused by
     * the PRICING CODE reads exactly like a refusal caused by the CLOCK, because both go away.
     * Reading the row first separates them. A case that was refused with a row this method
     * reports as fresh has found something in the pricing path, not the fixture's clock.
     *
     * Reads hub 0's database (the venue seeds every hub identically, and `_seedHubPrices`
     * writes the same two rounds into each).
     *
     * @param {string} pair e.g. 'DOGE/USD'
     * @returns {Promise<object|null>} {pair, hubDb, price, blockTimestamp, ageSeconds, stale,
     *   rowCount} or null when the venue is not up
     */
    async readVenuePrice(pair) {
        const hubDbName = this.hubs[0] ? this.hubs[0].dbName : null;
        if (!hubDbName) return null;
        const rows = await this.queryHubDb(hubDbName,
            'SELECT round_number, price, block_timestamp FROM price_snapshots ' +
            "WHERE coin_pair = ? AND status = 'finalized' ORDER BY block_timestamp DESC LIMIT 1",
            [String(pair)]);
        const now = Math.floor(Date.now() / 1000);
        if (!rows || !rows.length) {
            return { pair: String(pair), hubDb: hubDbName, price: null, blockTimestamp: null,
                ageSeconds: null, stale: true, rowCount: 0 };
        }
        const ts = Number(rows[0].block_timestamp);
        return { pair: String(pair), hubDb: hubDbName, price: String(rows[0].price),
            round: Number(rows[0].round_number), blockTimestamp: ts, ageSeconds: now - ts,
            // The handler's own window, the one that produced `stale beyond 1800s` on drive 11.
            stale: (now - ts) > 1800, rowCount: rows.length };
    }

    /**
     * A read against one venue indexer's MIRROR database.
     *
     * A venue indexer keeps two databases and conflating them cost this row a whole drive.
     * `indexerDbName` holds the LEDGER it parsed (tokens, credits, bridge_settlements);
     * `mirrorDbName` holds what `hub_db_sync` copied down from the hub (bridge_transfers,
     * policy_snapshots, capability_snapshots). Drive 7 read `bridge_transfers` out of the
     * ledger database, found 0, and reported that the mirror had never delivered the row,
     * while the mirror database held both rows the whole time.
     */
    async queryMirrorDb(chain, sql, params) {
        const ix = this['_chainIndexer'](chain);
        assert.ok(ix, 'bridgeRailVenue: no venue indexer for ' + chain);
        const db = this.hubDb;
        assert.ok(db, 'bridgeRailVenue: the venue has no hubDb; it is not started');
        assert.ok(/^[A-Za-z0-9_]+$/.test(String(ix.mirrorDbName)),
            'bridgeRailVenue: refusing an unsafe database identifier ' + ix.mirrorDbName);
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(ix.mirrorDbName), connectTimeout: 10000,
            });
            return await conn.query(sql, params || []);
        } finally {
            if (conn) await conn.end().catch(() => {});
        }
    }

    /**
     * The finalized transfers one chain's indexer has been handed by the mirror.
     */
    async mirroredTransfers(chain) {
        try {
            return await this.queryMirrorDb(chain,
                "SELECT transfer_id, src_chain, dest_chain, dest_address, amount, tick, status, " +
                "effective_time FROM bridge_transfers WHERE status <> 'retracted' ORDER BY id ASC");
        } catch (e) {
            // A mirror that has not built the table yet carries no transfers, which is the
            // same answer as an empty one.
            return [];
        }
    }

    /**
     * The verdict one broadcast action carries ON THIS VENUE'S OWN LEDGER.
     *
     * Every `*Helper.send*` in the harness waits on the global `indexerDatabase`, which is
     * the STANDING indexer's database for whichever rail is current. For the BTC legs that
     * is the same chain parsed by the same code and the two agree; for the DOGE legs it is
     * a DIFFERENT LEDGER (this venue replays, the standing node cloned its own history), so
     * a drive that waits there is reading a verdict about a ledger no assertion below is
     * about. AT7's airdrop failed exactly that way on drive 7.
     */
    async verdict(chain, table, txHash, opts) {
        const av = String(chain).toUpperCase() === 'BTC' ? this.btcVenue : this.dogeVenue;
        assert.ok(av, 'bridgeRailVenue: no venue for ' + chain);
        return verdictOf(av, table, txHash, opts);
    }

    /**
     * Hold until the bridge is QUIET for `tick`: nothing in flight and the escrow equal to
     * the destination supply on every chain the hub reports.
     *
     * WHY A DRIVE NEEDS THIS BEFORE IT ASSERTS ANYTHING. See `deferBridgeWiring`: arming
     * the engine on a rail with history re-finalizes every historical lock, and those legs
     * land on the destination minutes later, at a moment nothing in the drive controls. A
     * balance delta measured across that window is measuring two events and attributing
     * both to one. So the drive arms the engine, waits here until the backlog has drained,
     * and only then takes the baseline every later assertion is a delta from.
     *
     * AND IT IS MEASURED ON THE SETTLEMENT ROWS, NOT ON `in_flight`. When this was written
     * (2026-09-12) the indexer read had no settled filter, so the hub's in-flight term summed
     * the whole bridge history and `delta` sat permanently negative; indexer d93294d8 filters
     * the read against its mirrored `bridge_transfers`, which fixed the term and BROKE THIS
     * WAIT: the pending list now empties the moment the federation finalizes the backlog,
     * minutes before the destination applies any of it, and drive 18 took its baseline in
     * that gap (escrow 162, supply 0, `backlogApplied: []`). So the backlog is read from
     * two places: the source indexers' pending lists for the legs not yet finalized, and
     * every hub's `bridge_transfers` for the legs that have left those lists, each held
     * against the destination's `bridge_settlements` (`outstandingFinalizedLegs`).
     *
     * @param {string} tick
     * @returns {Promise<{applied: Array, invariant: object}|null>} null on timeout
     */
}

const descriptors = Object.getOwnPropertyDescriptors(VenueMethods.prototype);
delete descriptors.constructor;
return descriptors;
}

module.exports = buildVenueTransferReads;
