'use strict';

const assert = require('assert');

function buildVenueDiagnostics(deps) {
const { mariadb } = deps;

class VenueMethods {

    /**
     * What credited this chain's bridge escrow address OTHER than an XBRIDGE leg, net of
     * debits, with the crediting actions listed.
     *
     * WHY THE DRIVE NEEDS IT. The escrow is a plain address and D65 is the ruling that a
     * stray SEND to it is the sender's own loss and mints nothing: the units stay there for
     * good, and the escrow key is nobody's, so they can never be spent back out. This rail
     * has carried three such SENDs from earlier drive attempts, so the escrow balance is
     * permanently ABOVE the destination supply by their total, and the acceptance claim
     * "the invariant reads equal on BTC and DOGE" is only an identity once they are
     * subtracted. Measured here rather than assumed, off the venue's own ledger, so the
     * number a case asserts with is the one that ledger holds and not a constant retyped
     * from a previous drive.
     *
     * @returns {Promise<{net: number, credits: number, debits: number, byAction: Array}>}
     */
    async escrowNonBridgeCredits(chain, role, tick) {
        const address = await this.roleAddress(chain, role);
        assert.ok(address, 'bridgeRailVenue: no ' + role + ' address on ' + chain);
        const sum = async (table) => {
            const rows = await this.queryIndexerDb(chain,
                'SELECT ia.action AS action, COUNT(*) AS n, ' +
                'COALESCE(SUM(CAST(m.amount AS DECIMAL(60,18))),0) AS total ' +
                'FROM ' + table + ' m ' +
                'INNER JOIN index_addresses ad ON (ad.id=m.address_id) ' +
                'INNER JOIN index_tickers   ti ON (ti.id=m.tick_id) ' +
                'INNER JOIN actions a ON (a.action_index=m.action_index) ' +
                'INNER JOIN index_actions ia ON (ia.id=a.action_id) ' +
                'WHERE ad.address = ? AND ti.tick = ? AND ia.action <> \'XBRIDGE\' ' +
                'GROUP BY ia.action',
                [String(address), String(tick)]);
            return rows.map((r) => ({ action: String(r.action), count: Number(r.n),
                total: Number(r.total), table: table }));
        };
        const credits = await sum('credits');
        const debits = await sum('debits');
        const total = (rows) => rows.reduce((n, r) => n + Number(r.total || 0), 0);
        this.servedBy('escrowNonBridge:' + chain, 'venue ' + chain + ' indexer ledger database');
        return { address: address, credits: total(credits), debits: total(debits),
                 net: total(credits) - total(debits), byAction: credits.concat(debits) };
    }

    /**
     * A read against one venue hub's own database.
     */
    async queryHubDb(dbName, sql, params) {
        const db = this.hubDb;
        assert.ok(db, 'bridgeRailVenue: the venue has no hubDb; it is not started');
        assert.ok(/^[A-Za-z0-9_]+$/.test(String(dbName)),
            'bridgeRailVenue: refusing an unsafe database identifier ' + dbName);
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(dbName), connectTimeout: 10000,
            });
            return await conn.query(sql, params || []);
        } finally {
            if (conn) await conn.end().catch(() => {});
        }
    }

    /**
     * Every hub's tail, for a refusal that needs to name which hub said what.
     */
    hubTails(lines) {
        const n = Number(lines || 40);
        return this.hubs.map((h) => '--- hub ' + h.index + ' ---\n' +
            String(this.btcVenue.logTail('hub' + h.index) || '').split('\n').slice(-n).join('\n')).join('\n');
    }

    indexerTails(lines) {
        const n = Number(lines || 40);
        const out = [];
        // Every BTC indexer, since each follows its own hub and a refusal or a reorg push can
        // be logged by any one of them.
        for (const ix of (this.btcVenue ? this.btcVenue.indexers : [])) {
            out.push('--- venue BTC indexer ' + ix.index + ' (hub ' + ix.followsHub + ') ---\n' +
                String(this.btcVenue.logTail('indexer' + ix.index) || '').split('\n').slice(-n).join('\n'));
        }
        if (this.dogeVenue) out.push('--- venue DOGE indexer ---\n' +
            String(this.dogeVenue.logTail('indexer0') || '').split('\n').slice(-n).join('\n'));
        if (this.ltcVenue) out.push('--- venue LTC indexer ---\n' +
            String(this.ltcVenue.logTail('indexer0') || '').split('\n').slice(-n).join('\n'));
        return out.join('\n');
    }

    async stop() {
        // Attached and replay venues borrow the BTC venue's hubs and hub database, so
        // stopping the owner first would leave them talking to a mesh that is gone.
        for (const replay of [...this['_replayVenues']]) {
            await replay.stop().catch(() => {});
        }
        if (this.ltcVenue)  { await this.ltcVenue.stop().catch(() => {});  this.ltcVenue = null; }
        if (this.dogeVenue) { await this.dogeVenue.stop().catch(() => {}); this.dogeVenue = null; }
        if (this.btcVenue)  { await this.btcVenue.stop().catch(() => {});  this.btcVenue = null; }
    }
}

const descriptors = Object.getOwnPropertyDescriptors(VenueMethods.prototype);
delete descriptors.constructor;
return descriptors;
}

module.exports = buildVenueDiagnostics;
