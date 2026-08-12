/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * P3(b): LIVE multi-chain parity: the chain-agnostic action corpus + the
 * fixed role keys reused across every chain.
 *
 * This is the LIVE-stack analogue of the indexer scenario 14 corpus
 * (xchain-indexer/test/integration/scenarios/14-multi-chain-parity.test.js):
 * the SAME action sequence is replayed through the FULL pipeline (encoder →
 * broadcast → coin node → decoder → indexer) on BTC, LTC and DOGE, and the
 * resulting indexer state must agree (compare.js).
 *
 * Determinism contract (why this corpus is parity-safe):
 *   - FIXED ticks (MPTA/MPTB), NOT uniqueTick(): identical tick strings across
 *     chains -> identical index_tickers id assignment -> identical hashes.
 *   - FIXED role keys reused on every chain: the three regtest networks share
 *     base58 version bytes (networks.js), so one key -> one address string ->
 *     identical index_addresses + identical first-touch id order.
 *   - the coin literal in ORDER/DISPENSER is the RUN's own coin, so both legs
 *     stay LOCAL on every chain (a hardcoded foreign coin would make the order
 *     cross-chain on two of three runs). compare.js normalises that one literal.
 *   - PINNED block timestamps: each corpus step carries a FIXED `time` (PIN_T0 +
 *     index * PIN_STEP). The driver sets the node's mock clock to that value
 *     (through the regtest-miner) before mining the step's block, so block_time
 *     is byte-identical across chains. This makes time-based ORDER_EXPIRE fire
 *     at the SAME absolute block on every chain: an unmatchable ORDER carries a
 *     fixed expiration (ORDER_EXPIRE_AT) that lands strictly between two
 *     consecutive pinned block times, so the later block is the first whose
 *     block_time exceeds it (getExpiredItems: expiration < block_time) and the
 *     indexer emits ORDER_EXPIRE there identically on BTC/LTC/DOGE. block_time
 *     itself is excluded from the Tier-2 comparison (compare.js), but the pinned
 *     schedule is what makes the ORDER_EXPIRE action's block_index deterministic.
 *   - exactly ONE action per block (the driver mines explicitly with auto-mine
 *     OFF), so every action lands at the same absolute block_index on each
 *     chain and the consensus hash chain (empty blocks included) matches.
 *********************************************************************/

'use strict';

const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

// Minimal network descriptor for WIF encoding only; all three regtest chains
// share wif 0xef (networks.js), so one WIF imports into every chain's SDK.
const WIF_NET = {
    messagePrefix: '\x18Bitcoin Signed Message:\n',
    bech32: 'bcrt',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef,
};

// Three FIXED private keys (regtest throwaway; deterministic so every run and
// every chain uses the SAME actors, which is REQUIRED for cross-chain parity).
const ROLE_PRIVKEYS = {
    A: '11'.repeat(32),
    B: '22'.repeat(32),
    C: '33'.repeat(32),
};

// Fixed ticks (identical across chains by design; see header).
const TICKS = { A: 'MPTA', B: 'MPTB' };

// A far-future expiration so the MATCHED orders + the DISPENSER never expire
// during the run (only the one deliberately-unmatchable order does; see below).
// Kept UNDER the MySQL TIMESTAMP / Y2038 ceiling (2147483647): the decoder's
// `dispensers` expiration column is a unixtime TIMESTAMP and truncates larger
// values ("Truncated incorrect unixtime value"): a real Y2038 schema limit in
// the decoder (the `orders` column tolerates bigger). 2033 is far above every
// pinned corpus block time, so nothing but the unmatchable order expires.
const FAR_FUTURE = 2000000000; // 2033-05-18 UTC, fixed (not Date.now()).

// Pinned block-timestamp schedule for the corpus phase. Each corpus step i is
// mined at PIN_T0 + i*PIN_STEP (the driver pins the node clock via the miner).
// PIN_T0 must be ABOVE any regtest install's real post-baseline wall-clock (so
// the forward jump off the real-time preamble is monotonic) and PIN_T0 + the
// whole corpus span must stay BELOW FAR_FUTURE (so the matched orders/dispenser
// do not themselves expire). The driver asserts PIN_T0 > the real baseline block
// time and fails loudly (bump these constants) if wall-clock ever catches up.
const PIN_T0   = 1900000000; // 2030-03-17 UTC, fixed base block time.
const PIN_STEP = 300;        // seconds between consecutive pinned corpus blocks.

// Index of the deliberately-unmatchable ORDER inside corpus() (0-based). It is
// placed so a LATER corpus block crosses its expiration; ORDER_EXPIRE_AT is the
// fixed instant strictly between the pinned time of the DISPENSER block and the
// MINT block that follows it, so that MINT block is the first with block_time >
// expiration and the indexer emits ORDER_EXPIRE there on every chain alike. A
// fixed constant (never Date.now()): the value is written verbatim into the
// ORDER string (transactions.data) and the orders.expiration column, both of
// which are compared byte-for-byte across chains.
const UNMATCHABLE_ORDER_INDEX = 8;                       // step 8 (see corpus())
const ORDER_EXPIRE_AT = PIN_T0 + PIN_STEP * 9 + Math.floor(PIN_STEP / 2); // between step 9 and 10

/**
 * Build the three role objects for the given SDK (one per chain). Each:
 *   { name, wif, privateKey, publicKey, publicKeyHex, compressed, address }
 * deriveAddress uses the SDK's active network, so the SAME key yields the
 * chain-correct (here: identical, shared-version-byte) address string.
 */
function buildRoles(sdk) {
    const roles = {};
    for (const [name, hex] of Object.entries(ROLE_PRIVKEYS)) {
        const wif = ECPair.fromPrivateKey(Buffer.from(hex, 'hex'), { network: WIF_NET }).toWIF();
        const key = sdk.importWIF(wif);
        roles[name] = { name, ...key, address: sdk.deriveAddress(key.publicKey, { type: 'p2pkh' }) };
    }
    return roles;
}

/**
 * The ordered corpus. Each step is one action by one role, driven one-per-block.
 * `coin` is the run's coin symbol (BTC/LTC/DOGE) for the ORDER/DISPENSER legs.
 * Returns [{ role: 'A'|'B'|'C', label, action, params, time, version? }] where
 * `time` is the FIXED block timestamp (PIN_T0 + index*PIN_STEP) the driver pins
 * before mining the step (identical across chains).
 *
 * Coverage (mirrors indexer scenario 14, INCLUDING time-based expiry): ISSUE,
 * MINT, SEND, ORDER_MATCH (exact counter-orders), ORDER_EXPIRE (an unmatchable
 * order whose fixed expiration a later pinned block crosses), DISPENSER escrow,
 * DESTROY.
 */
function corpus(coin) {
    const { A: TA, B: TB } = TICKS;
    const steps = [
        // 0-1: ISSUE both tokens.
        { role: 'A', label: 'ISSUE ' + TA, action: 'ISSUE',
          params: { tick: TA, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'parity A', mintSupply: 1000 } },
        { role: 'B', label: 'ISSUE ' + TB, action: 'ISSUE',
          params: { tick: TB, maxSupply: 500000, maxMint: 100000, decimals: 0, description: 'parity B', mintSupply: 500 } },
        // 2-3: MINT more of each.
        { role: 'A', label: 'MINT ' + TA, action: 'MINT', params: { tick: TA, amount: 800, destination: '@A' } },
        { role: 'B', label: 'MINT ' + TB, action: 'MINT', params: { tick: TB, amount: 400, destination: '@B' } },
        // 4-5: Cross-sends.
        { role: 'A', label: 'SEND ' + TA + '->B', action: 'SEND', params: { tick: TA, amount: 150, destination: '@B', memo: 'p' } },
        { role: 'B', label: 'SEND ' + TB + '->A', action: 'SEND', params: { tick: TB, amount: 75, destination: '@A', memo: 'p' } },
        // 6-7: Exact counter-orders -> ORDER_MATCH.
        { role: 'A', label: 'ORDER A give ' + TA + ' get ' + TB, action: 'ORDER',
          params: { giveCoin: coin, giveTick: TA, giveAmount: 10, getCoin: coin, getTick: TB, getAmount: 20, getAddress: '@A', expiration: FAR_FUTURE } },
        { role: 'B', label: 'ORDER B give ' + TB + ' get ' + TA, action: 'ORDER',
          params: { giveCoin: coin, giveTick: TB, giveAmount: 20, getCoin: coin, getTick: TA, getAmount: 10, getAddress: '@B', expiration: FAR_FUTURE } },
        // 8: Deliberately-unmatchable order (wants an absurd amount of TB for a
        // little TA, so no counter-order exists). Its FIXED expiration lands
        // between the DISPENSER block (step 9) and the MINT block (step 10), so
        // step 10 is the first block whose block_time exceeds it -> ORDER_EXPIRE.
        // MUST stay at index UNMATCHABLE_ORDER_INDEX (guarded by the unit test).
        { role: 'A', label: 'ORDER A UNMATCHABLE (expires)', action: 'ORDER',
          params: { giveCoin: coin, giveTick: TA, giveAmount: 5, getCoin: coin, getTick: TB, getAmount: 999, getAddress: '@A', expiration: ORDER_EXPIRE_AT } },
        // 9: Token-for-native dispenser (escrows give-side tokens). Open with a
        // FAR_FUTURE expiration, so it must SURVIVE the step-10 clock crossing:
        // proves the expiry pass expires only the genuinely-past item.
        { role: 'A', label: 'DISPENSER ' + TA, action: 'DISPENSER',
          params: { giveCoin: coin, giveTick: TA, giveAmount: 10, giveEscrow: 50, getCoin: coin, getAmount: 100000, getAddress: '@A', expiration: FAR_FUTURE } },
        // 10: MINT whose pinned block_time crosses ORDER_EXPIRE_AT; the indexer's
        // end-of-block expiry pass emits ORDER_EXPIRE for the step-8 order here
        // (mirrors scenario 14's block-106 expiry riding a MINT block).
        { role: 'A', label: 'MINT ' + TA + ' (crosses expiry)', action: 'MINT', params: { tick: TA, amount: 40, destination: '@A' } },
        // 11: Burn.
        { role: 'A', label: 'DESTROY ' + TA, action: 'DESTROY', params: { tick: TA, amount: 20, memo: 'burn' } },
    ];
    // Attach the fixed pinned block time to each step by position.
    return steps.map((s, i) => ({ ...s, time: PIN_T0 + i * PIN_STEP }));
}

// Resolve '@A'/'@B'/'@C' destination placeholders against the role address map.
function resolveParams(params, roles) {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        out[k] = (typeof v === 'string' && v[0] === '@' && roles[v.slice(1)]) ? roles[v.slice(1)].address : v;
    }
    return out;
}

module.exports = {
    ROLE_PRIVKEYS,
    TICKS,
    FAR_FUTURE,
    PIN_T0,
    PIN_STEP,
    ORDER_EXPIRE_AT,
    UNMATCHABLE_ORDER_INDEX,
    buildRoles,
    corpus,
    resolveParams,
};
