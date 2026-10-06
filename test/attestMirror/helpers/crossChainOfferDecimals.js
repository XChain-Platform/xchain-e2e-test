'use strict';

// The hub declines a cross-chain match whose taker offer carries no give_decimals,
// because the value is its home indexer's own answer and the hub never infers it.
// The mock offer book stands in for that indexer, so it stamps the field here.
const DEFAULT_GIVE_DECIMALS = 8;

function withGiveDecimals(ordersByCoin, decimals = DEFAULT_GIVE_DECIMALS) {
    const out = {};
    for (const coin of Object.keys(ordersByCoin)) {
        out[coin] = ordersByCoin[coin].map((offer) => Object.assign({ give_decimals: decimals }, offer));
    }
    return out;
}

module.exports = { withGiveDecimals, DEFAULT_GIVE_DECIMALS };
