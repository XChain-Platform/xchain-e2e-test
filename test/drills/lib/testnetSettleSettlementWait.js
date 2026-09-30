'use strict';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.rows)) return payload.rows;
    if (Array.isArray(payload.result)) return payload.result;
    if (payload.result && Array.isArray(payload.result.data)) return payload.result.data;
    if (payload.result && Array.isArray(payload.result.rows)) return payload.result.rows;
    return [];
}

function rowForMatch(payload, matchId) {
    return asRows(payload).find((row) => row && String(row.match_id) === String(matchId)) || null;
}

function releaseAddresses(row, coin) {
    const directFields = [
        'released_to', 'release_to', 'release_address', 'payout_address', 'payout_addr',
        'destination', 'destination_address', 'recipient', 'recipient_address', 'get_address'
    ];
    const addresses = directFields.map((field) => row[field]).filter((value) => value !== undefined && value !== null);
    const chain = String(coin || '').toUpperCase();
    if (String(row.a_chain || '').toUpperCase() === chain) addresses.push(row.b_payout_addr);
    if (String(row.b_chain || '').toUpperCase() === chain) addresses.push(row.a_payout_addr);
    for (const release of [row.release, row.escrow_release]) {
        if (release && typeof release === 'object') {
            addresses.push(release.to, release.address, release.destination, release.recipient);
        }
    }
    return addresses.filter((value) => value !== undefined && value !== null).map(String);
}

function statusFor(payload, row, httpStatus) {
    if (row && row.status !== undefined && row.status !== null) return row.status;
    if (row) return 'settled';
    if (payload && payload.status !== undefined && payload.status !== null) return payload.status;
    return httpStatus;
}

function rowIsSettled(row) {
    if (row.status === undefined || row.status === null) return true;
    return ['settled', 'complete', 'completed', 'released'].includes(String(row.status).toLowerCase());
}

async function readSettlement(fetchImpl, url, matchId) {
    try {
        const response = await fetchImpl(url, { method: 'GET' });
        const payload = response && typeof response.json === 'function' ? await response.json() : response;
        const httpStatus = response && response.ok === false ? 'HTTP ' + response.status : null;
        const row = httpStatus ? null : rowForMatch(payload, matchId);
        return { row, status: statusFor(payload, row, httpStatus) };
    } catch (error) {
        return { row: null, status: error && error.message ? error.message : String(error) };
    }
}

function pollConfig(args) {
    const timeout = Number(args.timeoutMs);
    const interval = Number(args.pollIntervalMs);
    return {
        now: typeof args.now === 'function' ? args.now : Date.now,
        sleep: typeof args.sleep === 'function' ? args.sleep : defaultSleep,
        fetchImpl: args.fetchImpl || global.fetch,
        timeoutMs: Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULT_TIMEOUT_MS,
        pollIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_MS
    };
}

async function pollSettlement(args, accepts) {
    const config = pollConfig(args);
    const deadline = config.now() + config.timeoutMs;
    const base = String(args.explorerUrl || '').replace(/\/+$/, '');
    const url = base + '/' + args.coin + '/api/cross_chain_settlements/' +
        encodeURIComponent(String(args.matchId)) + '/match';
    let lastStatus = null;
    for (;;) {
        const reading = await readSettlement(config.fetchImpl, url, args.matchId);
        lastStatus = reading.status;
        if (reading.row && accepts(reading.row)) {
            return { settled: true, lastStatus, row: reading.row };
        }
        const remaining = deadline - config.now();
        if (remaining <= 0) return { settled: false, lastStatus, row: reading.row };
        await config.sleep(Math.min(config.pollIntervalMs, remaining));
    }
}

async function awaitBtcSettlement(args) {
    const result = await pollSettlement(args, (row) =>
        rowIsSettled(row) && releaseAddresses(row, args.coin).includes(String(args.dogeMakerBtcRecv)));
    if (result.settled) return result.row;
    const error = new Error('BTC settlement timed out; last status: ' + String(result.lastStatus));
    error.lastStatus = result.lastStatus;
    throw error;
}

async function observeDogeSettlement(args) {
    const result = await pollSettlement(args, rowIsSettled);
    return { settled: result.settled, lastStatus: result.lastStatus };
}

module.exports = { awaitBtcSettlement, observeDogeSettlement };
