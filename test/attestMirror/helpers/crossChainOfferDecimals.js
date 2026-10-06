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

// Suites whose split parts build their own offers and dispatch rows go through
// this one install: the mock book stamps give_decimals and the dispatch proposal
// defaults push_generation to 0, so the hub's own validation and insert accept them.
function installCrossChainSeeds() {
    const { loadHubModule } = require('../../helpers/multiValidatorHubHelper');
    const { MockCrossChainOfferBook } = require('../../helpers/mockCrossChainOfferBook');
    const Consensus = loadHubModule('src/cross_chain/dex_consensus.js');

    if (!MockCrossChainOfferBook.prototype.setBook.seedsGiveDecimals) {
        const setBook = MockCrossChainOfferBook.prototype.setBook;
        MockCrossChainOfferBook.prototype.setBook = function (name, spec = {}) {
            const seeded = spec.ordersByCoin ? Object.assign({}, spec, { ordersByCoin: withGiveDecimals(spec.ordersByCoin) }) : spec;
            return setBook.call(this, name, seeded);
        };
        MockCrossChainOfferBook.prototype.setBook.seedsGiveDecimals = true;
    }

    if (!Consensus.prototype.propose.seedsPushGeneration) {
        const propose = Consensus.prototype.propose;
        Consensus.prototype.propose = function (roundId, payload, ...rest) {
            const row = payload && payload.row;
            if (row && row.phase === 'dispatch' && row.push_generation === undefined) {
                payload = Object.assign({}, payload, { row: Object.assign({ push_generation: 0 }, row) });
            }
            return propose.call(this, roundId, payload, ...rest);
        };
        Consensus.prototype.propose.seedsPushGeneration = true;
    }
}

module.exports.installCrossChainSeeds = installCrossChainSeeds;
