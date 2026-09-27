'use strict';

function apiUrl(explorerUrl, coin, path) {
    return String(explorerUrl).replace(/\/+$/, '') + '/' + encodeURIComponent(coin) + '/api/' + path;
}

async function readJson(fetchImpl, url) {
    const response = await fetchImpl(url);
    if (!response || response.ok === false) {
        const status = response && response.status != null ? ' (' + response.status + ')' : '';
        throw new Error('Explorer request failed' + status + ': ' + url);
    }
    return response.json();
}

function orderActionIndex(transaction) {
    const actions = transaction && Array.isArray(transaction.actions) ? transaction.actions : [];
    const order = actions.find((action) => String(action.action).toUpperCase() === 'ORDER');
    if (!order || order.action_index == null) {
        throw new Error('Explorer transaction does not contain an ORDER action index');
    }
    return order.action_index;
}

function referencesOrder(row, actionIndex) {
    const sameIndex = (value) => String(value) === String(actionIndex);
    const aSide = String(row.a_chain).toUpperCase() === 'BTC' && sameIndex(row.a_action_index);
    const bSide = String(row.b_chain).toUpperCase() === 'BTC' && sameIndex(row.b_action_index);
    return row.status === 'finalized' && (aSide || bSide);
}

function matchRows(payload) {
    return payload && Array.isArray(payload.data) ? payload.data : [];
}

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitCrossChainMatch({
    explorerUrl, coin, orderTxid, timeoutMs, pollIntervalMs,
    now = Date.now, sleep = defaultSleep, fetchImpl = globalThis.fetch
}) {
    const startedAt = now();
    const transactionUrl = apiUrl(explorerUrl, coin, 'transaction/' + encodeURIComponent(orderTxid) + '/tx_hash');
    const actionIndex = orderActionIndex(await readJson(fetchImpl, transactionUrl));
    const matchesUrl = apiUrl(explorerUrl, coin, 'cross_chain_matches');
    let lastMatchCount = 0;

    while (now() - startedAt <= timeoutMs) {
        const payload = await readJson(fetchImpl, matchesUrl);
        const rows = matchRows(payload);
        const reportedTotal = payload && payload.total != null ? Number(payload.total) : NaN;
        lastMatchCount = Number.isFinite(reportedTotal) ? reportedTotal : rows.length;
        const match = rows.find((row) => referencesOrder(row, actionIndex));
        if (match) return match;
        await sleep(pollIntervalMs);
    }

    throw new Error('Timed out awaiting finalized cross-chain match; last match count: ' + lastMatchCount);
}

module.exports = { awaitCrossChainMatch };
