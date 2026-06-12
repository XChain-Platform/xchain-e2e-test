/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * P3(b) — LIVE multi-chain parity: the chain-agnostic action corpus + the
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
 *   - NO time-based ORDER_EXPIRE in this first cut: expiry triggers off block
 *     time, which is not pinned here. ORDER_EXPIRE parity is a documented
 *     follow-up requiring mocktime-pinned block timestamps. Everything in this
 *     corpus is height/state-deterministic.
 *   - exactly ONE action per block (the driver mines explicitly with auto-mine
 *     OFF), so every action lands at the same absolute block_index on each
 *     chain and the consensus hash chain — empty blocks included — matches.
 *********************************************************************/

'use strict';

const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const ECPair = ECPairFactory(ecc);

// Minimal network descriptor for WIF encoding only — all three regtest chains
// share wif 0xef (networks.js), so one WIF imports into every chain's SDK.
const WIF_NET = {
    messagePrefix: '\x18Bitcoin Signed Message:\n',
    bech32: 'bcrt',
    bip32: { public: 0x043587cf, private: 0x04358394 },
    pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef,
};

// Three FIXED private keys (regtest throwaway — deterministic so every run and
// every chain uses the SAME actors, which is REQUIRED for cross-chain parity).
const ROLE_PRIVKEYS = {
    A: '11'.repeat(32),
    B: '22'.repeat(32),
    C: '33'.repeat(32),
};

// Fixed ticks — identical across chains by design (see header).
const TICKS = { A: 'MPTA', B: 'MPTB' };

// A far-future expiration so the corpus orders/dispensers NEVER expire during
// the run (keeps the corpus free of time-based ORDER_EXPIRE — see header).
// Kept UNDER the MySQL TIMESTAMP / Y2038 ceiling (2147483647): the decoder's
// `dispensers` expiration column is a unixtime TIMESTAMP and truncates larger
// values ("Truncated incorrect unixtime value") — a real Y2038 schema limit in
// the decoder (the `orders` column tolerates bigger). 2033 is far above any
// regtest wall-clock block time, so nothing expires during the run.
const FAR_FUTURE = 2000000000; // 2033-05-18 UTC, fixed (not Date.now()).

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
 * Returns [{ role: 'A'|'B'|'C', label, action, params, version? }].
 *
 * Coverage (mirrors scenario 14 minus time-based expiry): ISSUE, MINT, SEND,
 * ORDER_MATCH (exact counter-orders), DISPENSER escrow, DESTROY.
 */
function corpus(coin) {
    const { A: TA, B: TB } = TICKS;
    return [
        // ISSUE both tokens.
        { role: 'A', label: 'ISSUE ' + TA, action: 'ISSUE',
          params: { tick: TA, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'parity A', mintSupply: 1000 } },
        { role: 'B', label: 'ISSUE ' + TB, action: 'ISSUE',
          params: { tick: TB, maxSupply: 500000, maxMint: 100000, decimals: 0, description: 'parity B', mintSupply: 500 } },
        // MINT more of each.
        { role: 'A', label: 'MINT ' + TA, action: 'MINT', params: { tick: TA, amount: 800, destination: '@A' } },
        { role: 'B', label: 'MINT ' + TB, action: 'MINT', params: { tick: TB, amount: 400, destination: '@B' } },
        // Cross-sends.
        { role: 'A', label: 'SEND ' + TA + '->B', action: 'SEND', params: { tick: TA, amount: 150, destination: '@B', memo: 'p' } },
        { role: 'B', label: 'SEND ' + TB + '->A', action: 'SEND', params: { tick: TB, amount: 75, destination: '@A', memo: 'p' } },
        // Exact counter-orders -> ORDER_MATCH.
        { role: 'A', label: 'ORDER A give ' + TA + ' get ' + TB, action: 'ORDER',
          params: { giveCoin: coin, giveTick: TA, giveAmount: 10, getCoin: coin, getTick: TB, getAmount: 20, getAddress: '@A', expiration: FAR_FUTURE } },
        { role: 'B', label: 'ORDER B give ' + TB + ' get ' + TA, action: 'ORDER',
          params: { giveCoin: coin, giveTick: TB, giveAmount: 20, getCoin: coin, getTick: TA, getAmount: 10, getAddress: '@B', expiration: FAR_FUTURE } },
        // Token-for-native dispenser (escrows give-side tokens).
        { role: 'A', label: 'DISPENSER ' + TA, action: 'DISPENSER',
          params: { giveCoin: coin, giveTick: TA, giveAmount: 10, giveEscrow: 50, getCoin: coin, getAmount: 100000, getAddress: '@A', expiration: FAR_FUTURE } },
        // Burn.
        { role: 'A', label: 'DESTROY ' + TA, action: 'DESTROY', params: { tick: TA, amount: 20, memo: 'burn' } },
    ];
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
    buildRoles,
    corpus,
    resolveParams,
};
