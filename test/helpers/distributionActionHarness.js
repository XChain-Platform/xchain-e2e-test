'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * E2E test helper: an in-memory action-handler harness for the distribution rail drill
 * (base spec row 11, AT7).
 *
 * WHY THIS EXISTS SEPARATELY FROM bridgeSettleContext.js. That helper drives the indexer's
 * SETTLE PASS (the injected XBRIDGE v2 credit that lands a mirrored transfer). AT7 needs one
 * step further down the chain: what the operator does WITH the credited balance, which is an
 * ordinary user-broadcast AIRDROP on the destination chain, and a proof that a broadcast
 * ISSUE of XCHAIN off BTC still refuses. Both are REAL indexer action classes
 * (src/actions/airdrop.js, src/actions/issue.js), not bridge-specific code, so this harness
 * drives them the same way bridgeSettleContext drives bridge_settle.js: a real IndexerUtility
 * instance over a REAL per-coin config (xchain-indexer/src/config.js, called directly rather
 * than through the environment, so a DOGE and a BTC config can coexist in one process), with
 * every OTHER dependency held in memory.
 *
 * WHAT IS REAL AND WHAT IS A STAND-IN, same discipline as bridgeSettleContext's header. The
 * config, the Airdrop/Issue classes, IndexerUtility (hasBalance, debitBalances, fee
 * computation, native-fee tolerance-band math, ledger consolidation) are all real production
 * code. The oracle price feed and the address/list/balance reads are DB facts a live rail
 * would answer; here they are seeded by the caller and read back verbatim, never decided.
 * A permissive fallback answers any indexer call this drill does not need with a benign
 * default (false/null) rather than throwing, so an unmodeled call cannot silently pass the
 * drill; every fallback hit is recorded on `harness.unstubbedCalls` for a reviewer to check.
 ********************************************************************/

const SETTLE = require('./bridgeSettleContext');
const { CrossChainBridgeEngine } = require('./bridgeHubRecord');

const configModule    = SETTLE.loadIndexerModule('src/config.js');
const IndexerUtility   = SETTLE.loadIndexerModule('src/utility.js');
const Airdrop          = SETTLE.loadIndexerModule('src/actions/airdrop.js');
const Issue            = SETTLE.loadIndexerModule('src/actions/issue.js');

// A real per-coin config, built directly (config.getConfig accepts explicit overrides and
// never touches process.env), so a DOGE and a BTC config can be built side by side in one
// process without one clobbering the other's cached environment.
function realConfig(coin, network){
    return configModule.getConfig(coin, network || 'regtest');
}

function defaultForMethod(name){
    if(/^(is|has)[A-Z]/.test(name)) return false;
    return null;
}

// Every indexerDb/decoderDb call this drill does not seed resolves to a benign default
// instead of throwing, and is logged so a reviewer can see exactly what fell through.
function makePermissiveDb(overrides, unstubbedCalls){
    const target = Object.assign({}, overrides || {});
    return new Proxy(target, {
        get(t, prop){
            if(prop in t) return t[prop];
            if(typeof prop !== 'string') return t[prop];
            return async (...args) => {
                unstubbedCalls.push({ method: prop, args: args });
                return defaultForMethod(prop);
            };
        }
    });
}

/**
 * A harness for driving one real indexer Action class (Airdrop, Issue, ...) with no live
 * chain: a real config, a real IndexerUtility instance, and an in-memory db/mapper.
 *
 * @param opts.coin        the acting chain's coin ('DOGE' for the AT7 destination leg)
 * @param opts.network     network name, 'regtest' unless a drill needs a mismatch
 * @param opts.indexerDb   explicit indexerDb method overrides; anything else falls through
 *                         to the permissive default above
 * @param opts.protocolChanges  override for actionsCtx.protocolChanges (default: every flag
 *                         reads false, which is the pre-milestone-2 state this drill targets)
 */
function makeHarness(opts){
    const o = opts || {};
    const config = realConfig(o.coin || 'DOGE', o.network || 'regtest');
    const util   = new IndexerUtility(config);
    const unstubbedCalls = [];
    const indexerDb = makePermissiveDb(o.indexerDb, unstubbedCalls);
    const decoderDb = makePermissiveDb(o.decoderDb, unstubbedCalls);
    const mapper    = { createMappings: async () => {} };
    const protocolChanges = Object.assign({
        isDefined: () => true,
        isEnabled: async () => false
    }, o.protocolChanges || {});
    const actionsCtx = { config, util, decoderDb, indexerDb, mapper, protocolChanges };
    return { config, util, indexerDb, decoderDb, mapper, actionsCtx, unstubbedCalls };
}

/**
 * Drive a real AIRDROP (format 0, single tick, address list) over a seeded ledger.
 *
 * The fee is paid in NATIVE coin (the milestone-1 rule off BTC: detectFeePaymentMode
 * returns 'rejected' with no native fee output and there is no XCHAIN fee mode off BTC
 * yet), so `feeOutput` and the two oracle prices are real inputs to the real tolerance-band
 * math in IndexerUtility.validateNativeCoinFee, not a bypass of it.
 *
 * @param opts.source        the address the credited bridge balance sits at
 * @param opts.tick          the tick to airdrop ('XCHAIN' for AT7)
 * @param opts.tickId        the ticker id both the token row and the balances map key on
 * @param opts.decimals      token decimals
 * @param opts.sourceBalance the SOURCE's balance of `tick` before the airdrop (decimal string)
 * @param opts.amountEach    amount credited to each recipient (decimal string)
 * @param opts.recipients    the address list (address-list type, so recipients are exactly
 *                           these addresses)
 * @param opts.xchainUsdPrice / coinUsdPrice   fixed oracle prices for the native-fee band
 * @param opts.feePaid        the native-coin amount attached to the fee output; the real
 *                            IndexerUtility computes the accepted band from the prices above
 *                            and this either falls inside it (valid) or does not
 */
async function runAirdrop(opts){
    const o = opts || {};
    const tick     = o.tick || 'XCHAIN';
    const tickId   = o.tickId === undefined ? 1 : o.tickId;
    const decimals = o.decimals === undefined ? 8 : o.decimals;
    const listIndex = 900;

    const state = { credits: [], debits: [], escrows: [], airdrops: [], feeRecords: [] };
    const balances = {};
    balances[tickId] = String(o.sourceBalance);

    const tokenInfo = {
        TICK: tick, TICK_ID: tickId, DECIMALS: decimals,
        SUPPLY: String(o.sourceBalance), ALLOW_LIST: null, BLOCK_LIST: null
    };

    const harness = makeHarness({
        coin: 'DOGE', network: o.network || 'regtest',
        indexerDb: {
            getTokenInfo:  async () => tokenInfo,
            getAddressBalances: async () => Object.assign({}, balances),
            getAddressPreferences: async () => ({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 }),
            isActionAllowed: async () => true,
            getListType: async () => 2,             // address list
            getList:     async () => (o.recipients || []).slice(),
            getTickerId: async () => tickId,
            getEffectiveTokenControllerForGuard: async () => null,   // no controller bound
            createAirdrop: async (rec) => { state.airdrops.push(rec); },
            createFeeRecord: async (fee) => { state.feeRecords.push(fee); },
            createDebit:  async (ai, t, amount, address) => { state.debits.push([t, String(amount), address]); },
            createCredit: async (ai, t, amount, address) => { state.credits.push([t, String(amount), address]); },
            createEscrow: async (ai, t, amount, address) => { state.escrows.push([t, String(amount), address]); },
            updateBalances: async () => {},
            updateTokens:   async () => {},
            getLatestPrice: async (pair) => {
                if(pair === (o.coin || 'DOGE') + '/USD') return { price: String(o.coinUsdPrice), roundNumber: 1 };
                if(pair === 'XCHAIN/USD')                return { price: String(o.xchainUsdPrice), roundNumber: 1 };
                return null;
            }
        }
    });

    const feeDestination = harness.config.ADDRESS.FEE_DESTINATION;
    const data = {
        ACTION: 'AIRDROP', FORMAT: 0,
        BLOCK_INDEX: o.blockIndex === undefined ? 900 : o.blockIndex,
        BLOCK_TIME:  o.blockTime  === undefined ? 2000 : o.blockTime,
        SOURCE: o.source, COIN: 'DOGE',
        TX_HASH: o.txHash || 'd'.repeat(64), TX_VOUT: 0, TX_INDEX: 1,
        ACTION_INDEX: o.actionIndex === undefined ? 5100 : o.actionIndex,
        TX_OUTPUTS: (o.feePaid === undefined) ? [] : [{ address: feeDestination, value: String(o.feePaid) }]
    };
    const params = ['0', tick, String(o.amountEach), String(listIndex), null];

    const handler = new Airdrop(harness.actionsCtx);
    await handler.parse(params, data, null);

    return { data: data, state: state, harness: harness, config: harness.config };
}

/**
 * Drive a real ISSUE broadcast of the GAS tick and report the verdict.
 *
 * Off BTC this is refused unconditionally by issue.js's bridge-owned guard
 * (`invalid: TICK (BTC-only)`), on every network including regtest, from every source
 * including the GAS address (base spec section 4 / D62). On BTC (and only on BTC) the
 * same broadcast validates against everything this harness seeds as an ordinary issuance.
 *
 * @param opts.coin    the acting chain; 'DOGE' is the refusal case AT7 asserts,
 *                     'BTC' is the falsification contrast (same call, no refusal)
 */
async function runIssueBroadcast(opts){
    const o = opts || {};
    // Resolved before the harness so getTokenInfo's stand-in row can name the real GAS
    // address as OWNER; source defaults to it, matching a GAS-key broadcast.
    const gasAddress = o.source || realConfig(o.coin || 'DOGE', o.network || 'regtest').ADDRESS.GAS;
    const harness = makeHarness({
        coin: o.coin || 'DOGE', network: o.network || 'regtest',
        indexerDb: {
            resolveAddressRefChecked: async (v) => ({ value: v, rejected: false }),
            getAddressBalances: async () => ({}),
            getAddressPreferences: async () => ({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 }),
            getTickerId: async () => 1,
            createIssue: async () => {},
            // Only reached when the BTC-only guard does NOT fire (the falsification
            // contrast on BTC): an existing token row, byte-for-byte the base spec's
            // section 9 XCHAIN row, owned by the GAS address the drill issues from, so
            // this is the ordinary "existing tick" path rather than a fresh creation.
            getTokenInfo: async (tick) => (String(tick).toUpperCase() === 'XCHAIN') ? {
                TICK: 'XCHAIN', TICK_ID: 1, MAX_SUPPLY: '100000000', MAX_MINT: null,
                DECIMALS: 8, MINT_SUPPLY: '0', SUPPLY: '0', OWNER: gasAddress,
                TRANSFER: null, TRANSFER_SUPPLY: null, LOCK_MAX_SUPPLY: '', LOCK_MAX_MINT: 0,
                LOCK_DESCRIPTION: 0, LOCK_SLEEP: 0, LOCK_CALLBACK: 0, LOCK_MINT: 0,
                LOCK_MINT_SUPPLY: 0, CALLBACK_BLOCK: null, CALLBACK_TICK: null,
                CALLBACK_AMOUNT: null, ALLOW_LIST: null, BLOCK_LIST: null,
                MINT_ADDRESS_MAX: null, MINT_START_BLOCK: 999999999, MINT_STOP_BLOCK: null
            } : null,
            isActionAllowed: async () => true,
            isOwnershipEscrowed: async () => false,
            isDistributed: async () => true
        }
    });

    const data = {
        ACTION: 'ISSUE', FORMAT: 0,
        BLOCK_INDEX: o.blockIndex === undefined ? 900 : o.blockIndex,
        BLOCK_TIME:  o.blockTime  === undefined ? 2000 : o.blockTime,
        SOURCE: gasAddress, COIN: harness.config.COIN,
        TX_HASH: o.txHash || 'e'.repeat(64), TX_VOUT: 0, TX_INDEX: 1,
        ACTION_INDEX: o.actionIndex === undefined ? 5200 : o.actionIndex,
        IS_GENESIS: false
    };
    // Format 0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|... every field past
    // TICK stays null (setActionParams null-fills an absent index), which is fine: the
    // BTC-only guard fires (or, on BTC, does not) before any of the "new tick" fields matter.
    const params = ['0', 'XCHAIN'];

    const handler = new Issue(harness.actionsCtx);
    await handler.parse(params, data, null);

    return { data: data, harness: harness, config: harness.config };
}

// A bare CrossChainBridgeEngine instance for getBridgeInvariant, the same "pure methods on a
// bare prototype" technique bridgeHubRecord.js uses for the hub's canonical/derivation
// methods. getBridgeInvariant reads no instance state beyond what is set here.
//
// @param opts.tickOrigin        Map of 'network|tick' -> origin chain (default: XCHAIN/BTC)
// @param opts.chainStateReader  async (coin, network, ticks) -> { tick: { supply, escrow } },
//                                the real method's own documented injection point
// @param opts.pending            entries for the hub's OWN in-flight tracking (Map of
//                                'tick|chain' -> [amount, ...]); default empty (in_flight 0)
function makeInvariantEngine(opts){
    const o = opts || {};
    const eng = Object.create(CrossChainBridgeEngine.prototype);
    eng.network = o.network || 'regtest';
    eng.db = Object.assign({
        getBridgeTransferChainPairs: async () => [],
        getInFlightBridgeTransfers:  async () => [],
        getLatestPolicySeq:          async () => 0
    }, o.db || {});
    eng._pendingInFlight = o.pending || new Map();
    eng._tickOrigin = o.tickOrigin || new Map([[(o.network || 'regtest') + '|XCHAIN', 'BTC']]);
    eng._chainStateLogged = {};
    eng.chainStateReader = o.chainStateReader;
    return eng;
}

module.exports = {
    realConfig,
    makeHarness,
    runAirdrop,
    runIssueBroadcast,
    makeInvariantEngine,
    Airdrop,
    Issue,
    CrossChainBridgeEngine
};
