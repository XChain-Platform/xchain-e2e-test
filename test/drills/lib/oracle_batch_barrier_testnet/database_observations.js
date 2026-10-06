'use strict';

const path = require('path');
const { ident, finite, num } = require('./common');

async function decoderBlock(conn, dbName, height) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT block_index, block_time FROM `' + db + '`.blocks WHERE block_index = ?', [height]);
    if (rows.length === 0) return null;
    return { height: num(rows[0].block_index), blockTime: num(rows[0].block_time) };
}

async function decoderBlockTransactionCount(conn, dbName, height) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT COUNT(*) AS n FROM `' + db + '`.transactions WHERE block_index = ?', [height]);
    if (rows.length === 0) return null;
    return num(rows[0].n);
}

async function decoderRange(conn, dbName) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT MIN(block_index) AS lo, MAX(block_index) AS hi FROM `' + db + '`.blocks');
    return { first: num(rows[0].lo), last: num(rows[0].hi) };
}

async function mirrorNewestRound(conn, dbName, blockTime) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT round_number, block_timestamp FROM `' + db + '`.price_snapshots ' +
        "WHERE status = 'finalized' AND block_timestamp <= ? ORDER BY round_number DESC LIMIT 1", [blockTime]);
    if (rows.length === 0) return { round: null, blockTimestamp: null };
    return { round: num(rows[0].round_number), blockTimestamp: num(rows[0].block_timestamp) };
}

const internalProtocolTimeModules = new Map();

function loadProtocolTime(repoRoot) {
    const key = String(repoRoot);
    if (internalProtocolTimeModules.has(key)) return internalProtocolTimeModules.get(key);
    const modulePath = path.join(key, 'xchain-indexer', 'src', 'consensus', 'protocol_time.js');
    let present = true;
    try {
        require.resolve(modulePath);
    } catch (error) {
        present = false;
    }
    const mod = present ? require(modulePath) : null;
    internalProtocolTimeModules.set(key, mod);
    return mod;
}

async function previousBlockTimes(conn, dbName, height, span) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT block_time FROM `' + db + '`.blocks ' +
        'WHERE block_index < ? AND block_time IS NOT NULL ' +
        'ORDER BY block_index DESC LIMIT ?', [height, span]);
    return rows.map((row) => num(row.block_time));
}

async function resolveBarrierBlockTime(conn, dbName, height, rawBlockTime, network, repoRoot) {
    const mod = loadProtocolTime(repoRoot);
    if (!mod) {
        return {
            blockTime: null,
            source: 'unavailable',
            note: 'xchain-indexer/src/consensus/protocol_time.js could not be loaded from ' + repoRoot +
                ', so the clock the barrier gates on is unknown'
        };
    }
    if (!mod.isProtocolTimeMtpActive(network)) {
        return {
            blockTime: finite(rawBlockTime),
            source: 'raw',
            note: 'protocol time is the raw stamp on ' + network
        };
    }
    const previous = await previousBlockTimes(conn, dbName, height, mod.MEDIAN_TIME_SPAN);
    const resolved = mod.protocolTime(network, rawBlockTime, previous);
    return {
        blockTime: finite(resolved),
        source: finite(resolved) === finite(rawBlockTime) ? 'mtp-equals-raw' : 'mtp',
        note: 'median time past over ' + previous.length + ' preceding stamp(s)'
    };
}

async function mirrorMaxFinalizedTimestamp(conn, dbName) {
    const db = ident(dbName, 'database name');
    const rows = await conn.query(
        'SELECT MAX(block_timestamp) AS ts FROM `' + db + '`.price_snapshots ' +
        "WHERE status = 'finalized'");
    if (rows.length === 0) return null;
    return num(rows[0].ts);
}

async function batchCoverage(conn, indexerDb, hubDb, mirrorDb) {
    const indexer = ident(indexerDb, 'database name');
    const batches = await conn.query(
        'SELECT action_index, batch_first_round, batch_last_round, round_count, validation_status ' +
        'FROM `' + indexer + '`.prices WHERE version = 0 AND batch_first_round IS NOT NULL ' +
        'ORDER BY batch_first_round ASC');
    const valid = batches.filter((batch) => String(batch.validation_status) === 'valid');
    const wanted = new Set();
    for (const batch of valid) {
        const first = num(batch.batch_first_round);
        const last = num(batch.batch_last_round);
        if (first === null || last === null || last < first) continue;
        for (let round = first; round <= last; round++) wanted.add(round);
    }
    const held = async (dbName) => {
        const db = ident(dbName, 'database name');
        const rows = await conn.query('SELECT DISTINCT round_number FROM `' + db + '`.price_snapshots');
        return new Set(rows.map((row) => num(row.round_number)));
    };
    const inHub = await held(hubDb);
    const inMirror = await held(mirrorDb);
    const missingFromHub = [...wanted].filter((round) => !inHub.has(round)).sort((a, b) => a - b);
    const missingFromMirror = [...wanted].filter((round) => !inMirror.has(round)).sort((a, b) => a - b);
    return {
        batchesParsed: batches.length,
        batchesValid: valid.length,
        batchStatuses: batches.reduce((counts, batch) => {
            const key = String(batch.validation_status);
            counts[key] = (counts[key] || 0) + 1;
            return counts;
        }, {}),
        roundsCarried: wanted.size,
        roundsInHub: inHub.size,
        roundsInMirror: inMirror.size,
        missingFromHub: { count: missingFromHub.length, sample: missingFromHub.slice(0, 25) },
        missingFromMirror: { count: missingFromMirror.length, sample: missingFromMirror.slice(0, 25) }
    };
}

async function blockActions(conn, indexerDb, tables, height) {
    const db = ident(indexerDb, 'database name');
    const rows = await conn.query(
        'SELECT a.action_index, a.tx_index, a.tx_vout, ia.action AS action, itx.hash AS tx_hash ' +
        'FROM `' + db + '`.actions a JOIN `' + db + '`.index_actions ia ON ia.id = a.action_id ' +
        'LEFT JOIN `' + db + '`.transactions t ON t.tx_index = a.tx_index ' +
        'LEFT JOIN `' + db + '`.index_transactions itx ON itx.id = t.tx_hash_id ' +
        'WHERE a.block_index = ? ORDER BY a.tx_index, a.tx_vout', [height]);
    const byIndex = new Map();
    for (const row of rows) {
        byIndex.set(num(row.action_index), {
            actionIndex: num(row.action_index),
            action: String(row.action),
            txIndex: num(row.tx_index),
            txVout: num(row.tx_vout),
            txHash: row.tx_hash === null || row.tx_hash === undefined ? null : String(row.tx_hash),
            verdicts: []
        });
    }
    for (const table of tables) {
        const tableName = ident(table, 'table name');
        let verdictRows;
        try {
            verdictRows = await conn.query(
                'SELECT d.action_index, s.status FROM `' + db + '`.`' + tableName + '` d ' +
                'JOIN `' + db + '`.actions a ON a.action_index = d.action_index ' +
                'JOIN `' + db + '`.index_statuses s ON s.id = d.status_id ' +
                'WHERE a.block_index = ?', [height]);
        } catch (error) {
            continue;
        }
        for (const verdict of verdictRows) {
            const entry = byIndex.get(num(verdict.action_index));
            if (entry) entry.verdicts.push({ table: tableName, status: String(verdict.status) });
        }
    }
    return [...byIndex.values()];
}

module.exports = {
    decoderBlock,
    decoderBlockTransactionCount,
    decoderRange,
    mirrorNewestRound,
    loadProtocolTime,
    previousBlockTimes,
    resolveBarrierBlockTime,
    mirrorMaxFinalizedTimestamp,
    batchCoverage,
    blockActions
};
