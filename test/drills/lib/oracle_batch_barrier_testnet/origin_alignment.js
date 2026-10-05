'use strict';

const axios = require('axios');
const { EXPLORER_COIN, finite, num } = require('./common');

function normalizeHash(h) {
    if (h === null || h === undefined) return null;
    const s = String(h).trim().toLowerCase();
    return s === '' ? null : s;
}

function normalizeName(n) {
    if (n === null || n === undefined) return null;
    const s = String(n).trim().toUpperCase();
    return s === '' ? null : s;
}

function normalizeOriginRow(r) {
    r = r || {};
    const pick = (a, b) => (r[a] !== undefined ? r[a] : r[b]);
    return {
        actionIndex: finite(pick('action_index', 'actionIndex')),
        blockIndex: finite(pick('block_index', 'blockIndex')),
        txIndex: finite(pick('tx_index', 'txIndex')),
        txVout: finite(pick('tx_vout', 'txVout')),
        txHash: normalizeHash(pick('tx_hash', 'txHash')),
        action: normalizeName(pick('action', 'action'))
    };
}

function buildOriginActionIndex(rows) {
    const byHash = new Map();
    let oldest = null;
    let newest = null;
    for (const raw of rows || []) {
        const r = normalizeOriginRow(raw);
        if (r.blockIndex !== null) {
            oldest = oldest === null ? r.blockIndex : Math.min(oldest, r.blockIndex);
            newest = newest === null ? r.blockIndex : Math.max(newest, r.blockIndex);
        }
        if (r.txHash === null) continue;
        if (!byHash.has(r.txHash)) byHash.set(r.txHash, []);
        byHash.get(r.txHash).push(r);
    }
    return {
        byHash,
        rowCount: (rows || []).length,
        hashCount: byHash.size,
        oldestBlock: oldest,
        newestBlock: newest
    };
}

function alignOnTxHash(nodeAction, index, height) {
    const refuse = (reason, extra) =>
        Object.assign({ aligned: false, origin: null, reason }, extra || {});
    if (!index || !(index.byHash instanceof Map)) return refuse('origin-actions-unavailable');
    const hash = normalizeHash(nodeAction && nodeAction.txHash);
    if (hash === null) return refuse('node-action-has-no-tx-hash');
    const h = finite(height);
    const span = { oldestBlock: index.oldestBlock, newestBlock: index.newestBlock, rows: index.rowCount };
    const onHash = index.byHash.get(hash) || [];
    if (onHash.length === 0) {
        if (index.rowCount === 0) return refuse('origin-actions-unavailable', { originWindow: span });
        if (h !== null && index.oldestBlock !== null && h < index.oldestBlock) {
            return refuse('origin-window-does-not-cover-block', { originWindow: span });
        }
        if (h !== null && index.newestBlock !== null && h > index.newestBlock) {
            return refuse('origin-has-not-reached-this-block', { originWindow: span });
        }
        return refuse('origin-has-no-action-on-this-tx', { originWindow: span });
    }
    const inBlock = h === null ? onHash : onHash.filter((candidate) => finite(candidate.blockIndex) === h);
    if (inBlock.length === 0) {
        return refuse('origin-filed-this-tx-in-another-block',
            { originBlocks: [...new Set(onHash.map((candidate) => finite(candidate.blockIndex)))] });
    }
    let narrowed = inBlock;
    const name = normalizeName(nodeAction && nodeAction.action);
    const named = inBlock.filter((candidate) => normalizeName(candidate.action) !== null);
    if (name !== null && named.length > 0) {
        const same = named.filter((candidate) => normalizeName(candidate.action) === name);
        if (same.length === 0) {
            return refuse('origin-has-no-such-action-on-this-tx', {
                nodeActionName: name,
                originActionNames: [...new Set(named.map((candidate) => normalizeName(candidate.action)))]
            });
        }
        narrowed = same;
    }
    const vout = finite(nodeAction && nodeAction.txVout);
    if (narrowed.length > 1 && vout !== null) {
        const sameVout = narrowed.filter((candidate) => finite(candidate.txVout) === vout);
        if (sameVout.length > 0) narrowed = sameVout;
    }
    if (narrowed.length > 1) {
        return refuse('ambiguous-tx-hash-candidates', {
            candidates: narrowed.map((candidate) => finite(candidate.actionIndex))
        });
    }
    return { aligned: true, origin: narrowed[0], reason: 'aligned' };
}

class OriginView {
    constructor(settings) {
        this.indexerUrl = settings.originIndexerUrl;
        this.explorer = settings.explorerUrl + '/' + EXPLORER_COIN + '/api';
        this.indexerUnavailable = null;
    }

    async ['_rpc'](method, params) {
        if (!this.indexerUrl) {
            const error = new Error('AT5_ORIGIN_INDEXER_URL not set');
            error.code = 'NOT_CONFIGURED';
            throw error;
        }
        const res = await axios.post(this.indexerUrl,
            { jsonrpc: '2.0', id: 1, method, params: params || {} },
            { timeout: 20_000, validateStatus: () => true });
        const body = res.data || {};
        if (body.error) {
            const error = new Error(String(body.error.message || body.error));
            error.code = body.error.code;
            throw error;
        }
        return body.result;
    }

    async latestBlock() {
        try {
            const result = await this['_rpc']('getlatestblock', {});
            this.indexerUnavailable = null;
            return {
                source: 'origin-indexer',
                blockIndex: num(result && result.block_index),
                decoderBlock: num(result && result.decoder_block),
                lag: num(result && result.lag)
            };
        } catch (error) {
            this.indexerUnavailable = error && error.code === -32001
                ? 'unauthorized (-32001)' : String(error && error.message);
            try {
                const res = await axios.get(this.explorer + '/actions?limit=1', { timeout: 20_000 });
                const row = res.data && res.data.data && res.data.data[0];
                return {
                    source: 'explorer-actions',
                    unavailable: this.indexerUnavailable,
                    newestActionBlock: num(row && row.block_index),
                    blockIndex: null,
                    decoderBlock: null,
                    lag: null
                };
            } catch (explorerError) {
                return {
                    source: 'none',
                    unavailable: this.indexerUnavailable,
                    explorerError: String(explorerError && explorerError.message),
                    blockIndex: null,
                    lag: null
                };
            }
        }
    }

    async action(actionIndex) {
        try {
            const res = await axios.get(this.explorer + '/action/' + encodeURIComponent(String(actionIndex)),
                { timeout: 20_000, validateStatus: () => true });
            if (res.status === 404) return { found: false, status: null };
            if (res.status !== 200 || !res.data || res.data.error) {
                return { found: false, status: null, error: 'http ' + res.status };
            }
            const data = res.data;
            return {
                found: true,
                status: data.status === undefined || data.status === null ? null : String(data.status),
                action: data.action === undefined ? null : data.action,
                blockIndex: num(data.block_index),
                txIndex: num(data.tx_index)
            };
        } catch (error) {
            return { found: false, status: null, error: String(error && error.message) };
        }
    }

    async recentActions(limit) {
        const want = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
        try {
            const res = await axios.get(this.explorer + '/actions?limit=' + want,
                { timeout: 30_000, validateStatus: () => true });
            if (res.status !== 200 || !res.data || res.data.error) {
                return { rows: [], error: 'http ' + res.status, limit: want };
            }
            const raw = (res.data && res.data.data) || [];
            return { rows: raw.map(normalizeOriginRow), error: null, limit: want };
        } catch (error) {
            return { rows: [], error: String(error && error.message), limit: want };
        }
    }

    async newestRoundAtOrBefore(blockTime, pages, perPage) {
        pages = pages || 5;
        perPage = perPage || 100;
        let scanned = 0;
        for (let page = 1; page <= pages; page++) {
            let rows;
            try {
                const res = await axios.get(
                    this.explorer + '/price_snapshots?limit=' + perPage + '&page=' + page,
                    { timeout: 30_000 });
                rows = (res.data && res.data.data) || [];
            } catch (error) {
                return {
                    round: null,
                    blockTimestamp: null,
                    error: String(error && error.message),
                    rowsScanned: scanned
                };
            }
            if (rows.length === 0) break;
            scanned += rows.length;
            let best = null;
            for (const row of rows) {
                const timestamp = num(row.block_timestamp);
                const round = num(row.round_number);
                if (timestamp === null || round === null || timestamp > blockTime) continue;
                if (!best || round > best.round) best = { round, blockTimestamp: timestamp };
            }
            if (best) return Object.assign(best, { rowsScanned: scanned });
        }
        return {
            round: null,
            blockTimestamp: null,
            rowsScanned: scanned,
            note: 'no eligible row in ' + scanned + ' rows'
        };
    }
}

module.exports = { OriginView, buildOriginActionIndex, alignOnTxHash };
