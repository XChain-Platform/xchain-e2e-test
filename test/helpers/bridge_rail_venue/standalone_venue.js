'use strict';

const assert = require('assert');

function buildStandaloneVenue(deps) {
const { mariadb, AttestMirrorVenue } = deps;

/**
 * A DOGE-only venue indexer on the tree's bridge code, following one throwaway hub.
 *
 * WHY THIS IS A SEPARATE ENTRY POINT AND NOT A FLAG ON THE CLASS. Half of the acceptance
 * set is federation-free: the supply-path closures (D62, D63) and the AT9 verdict witness
 * are decisions one indexer makes about one broadcast action, with no transfer, no round
 * and no mirror in them. They still cannot be driven against the STANDING DOGE indexer,
 * which runs `1bbc68ae` and predates every one of those rules, so they need an indexer on
 * bridge code and nothing else. Giving them the whole mesh would make them inherit the
 * mesh's blocker (see resolveVenueQuorum) and stop proving what they can prove.
 *
 * The caller must already be inside the DOGE rail: `_resolveStandingStack` and the chain
 * clone both read the ambient endpoints and INDEXER_DB_*.
 *
 * @returns {Promise<AttestMirrorVenue|null>} null when a dependency is missing; the
 *          venue's own `unavailable` says which
 */
async function startDogeVenue(opts) {
    const o = opts || {};
    const venue = new AttestMirrorVenue({
        label: String(o.label || 'bridgeguard').replace(/[^A-Za-z0-9]/g, ''),
        coin: 'dogecoin',
        network: o.network || 'regtest',
        hubCount: 1,
        indexerCount: 1,
        basePort: o.basePort || 43600,
        // The harness DECODER_DB_* describe Bitcoin.
        useEnvDecoderCredential: false,
        graces: {},
        // The guards venue loads the same tree as the rail venue, or the parity case would be
        // comparing two different builds and calling the difference a grading fact.
        repoRoot: o.repoRoot || process.env.BRIDGE_RAIL_REPO_ROOT || undefined,
    });
    const up = await venue.start();
    if (!up) return null;
    return venue;
}

/**
 * The verdict one action table recorded for a broadcast transaction, on a venue indexer.
 *
 * Polls, because the action has to be mined and then parsed by a node that is catching
 * up. Returns null on timeout rather than throwing, so the caller can say which action
 * never landed instead of asserting against undefined.
 *
 * A verdict lives on the ACTION table (issues.status_id, sends.status_id, ...) and not on
 * `actions`, which is why the table is a parameter; it is validated as an identifier
 * because it is interpolated.
 *
 * @param {object} venue  an AttestMirrorVenue whose indexer 0 is the reader
 * @param {string} table  issues | sends | orders | dispensers | destroys ...
 * @param {string} txHash
 */
async function verdictOf(venue, table, txHash, opts) {
    const o = opts || {};
    assert.ok(/^[a-z_]+$/.test(String(table)), 'bridgeRailVenue: refusing an unsafe table identifier ' + table);
    const ix = venue.indexers[0];
    const db = venue.hubDb;
    const deadline = Date.now() + Number(o.timeoutMs || 300000);
    const sql =
        'SELECT s.status AS status, x.action_index AS action_index ' +
        'FROM `' + table + '` x ' +
        'JOIN actions a ON a.action_index = x.action_index ' +
        'JOIN transactions t ON t.tx_index = a.tx_index ' +
        'JOIN index_transactions it ON it.id = t.tx_hash_id ' +
        'JOIN index_statuses s ON s.id = x.status_id ' +
        'WHERE it.hash = ? LIMIT 1';
    while (Date.now() < deadline) {
        let conn = null;
        try {
            conn = await mariadb.createConnection({
                host: db.host, port: parseInt(db.port, 10), user: db.user, password: db.pass,
                database: String(ix.indexerDbName), connectTimeout: 10000,
            });
            const rows = await conn.query(sql, [String(txHash)]);
            if (rows.length) return { status: String(rows[0].status), actionIndex: String(rows[0].action_index) };
        } catch (e) { /* a fresh indexer may not have built the table yet */ }
        finally { if (conn) await conn.end().catch(() => {}); }
        await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
}

/**
 * The AT9 witness: the three controller-guarded actions on DOGE from a source with no
 * XCHAIN, and the verdict each one carries.
 *
 * WHAT MAKES THIS A WITNESS. AT9 states a NEGATIVE: bringing XCHAIN into existence on a
 * chain must not silently re-grade actions that have nothing to do with the bridge. A
 * negative like that cannot be asserted at one instant, only COMPARED across the event,
 * so this is written to be run twice with its two outputs compared. It takes the label
 * from the caller for the same reason: funding the same address twice would carry the
 * first run's balances into the second and move a verdict for a reason that is not the
 * bridge, which is the false red this parameter exists to prevent.
 *
 * Lives in the helper rather than in either suite so both halves read ONE definition of
 * what is being witnessed. Two copies is how a witness stops witnessing.
 *
 * The caller must already be inside the DOGE rail.
 */
async function driveVerdictWitness(deps, venue, label) {
    const { cryptoHelper, transactionHelper, network, gasTick } = deps;
    const tick = gasTick || 'XCHAIN';
    const src = await cryptoHelper.getNewFundedAddress(
        label + '.SRC', 'dogecoin', network, null, 'legacy', 0, 1, false);
    // An ADDRESS, not a funded one: it is only ever a destination here, and
    // regtestMinerConnector refuses a zero-amount send outright ("Invalid amount: must
    // be a positive finite number"), so asking for 0 coins is an error and not a no-op.
    const dest = await cryptoHelper.getNewAddress(
        label + '.DEST', 'dogecoin', network, null, 'legacy', 0);

    // EXPIRATION IS A UNIX TIMESTAMP, not a block height, and getting that wrong is how
    // this witness first came back useless: at 100 both the ORDER and the DISPENSER
    // refused `invalid: EXPIRATION (past)` before reaching any tick logic at all, so the
    // verdict could not have moved when XCHAIN appeared and the comparison proved
    // nothing. Ninety days out, so the same wire is still live on a re-run tomorrow.
    const expiry = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;

    const sendTx = await transactionHelper.createAndSendTransaction(
        src, 'SEND|0|' + tick + '|1|' + dest.address + '|');
    // Give XCHAIN, get native DOGE: GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP then
    // the get side, the counterparty address, expiration and the two lists.
    const orderTx = await transactionHelper.createAndSendTransaction(
        src, 'ORDER|0|DOGE|' + tick + '|1|0|DOGE||1|0|' + src.address + '|' + expiry + '|||');
    // The dispenser's GET_ADDRESS is where the BUYER's payment lands, so it is the
    // dispenser owner's own address and never the counterparty's.
    const dispTx = await transactionHelper.createAndSendTransaction(
        src, 'DISPENSER|0|DOGE|' + tick + '|1|0|1|DOGE||1|' + src.address + '||||' + expiry + '|||');

    const rows = {
        SEND:      await verdictOf(venue, 'sends', sendTx),
        ORDER:     await verdictOf(venue, 'orders', orderTx),
        DISPENSER: await verdictOf(venue, 'dispensers', dispTx),
    };
    return {
        SEND:      rows.SEND      ? rows.SEND.status      : null,
        ORDER:     rows.ORDER     ? rows.ORDER.status     : null,
        DISPENSER: rows.DISPENSER ? rows.DISPENSER.status : null,
        txids: { SEND: sendTx, ORDER: orderTx, DISPENSER: dispTx },
        source: src.address,
    };
}

return { startDogeVenue, verdictOf, driveVerdictWitness };
}

module.exports = buildStandaloneVenue;
