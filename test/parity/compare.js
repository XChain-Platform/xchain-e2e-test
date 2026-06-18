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
 **********************************************************************
 * P3(b): LIVE multi-chain parity. The PURE comparison over digest.js
 * artifacts. Two tiers:
 *
 *   TIER 1 (the hard proof): the resolved consensus hash chain is
 *   byte-identical across every chain. The hash (getBlockHashes,
 *   xchain-indexer/src/db.js:1019) folds SURROGATE ids + protocol amounts +
 *   block_index + the previous hash (never txids, never block hashes, never
 *   raw address strings). So identical action input in identical order yields
 *   identical hashes on BTC, LTC and DOGE even though every chain's
 *   underlying transactions differ. This is exactly the property ANCHOR /
 *   state-checkpoint recovery relies on being chain-agnostic.
 *
 *   TIER 2 (structural parity): the rest of the indexer DB is byte-identical
 *   across chains AFTER (a) normalising the run's coin literal and (b)
 *   excluding the columns/tables that hold chain-native residue, which differs
 *   BY CONSTRUCTION on a live stack:
 *     - index_transactions: interleaves chain-native txids + block-hash
 *       strings with the consensus hashes, so both its content AND its id-space
 *       differ per chain. Skipped wholesale; its consensus content is verified
 *       by Tier 1.
 *     - blocks.{ledger,actions,contract}_hash_id + transactions.tx_hash_id:
 *       pointers INTO that differing id-space (same as the cross-node oracle's
 *       'content' mode, equivalence.js).
 *     - tx_hash / block_hash / block_time string columns: chain-native or
 *       (block_time) unpinned in this first-cut corpus.
 *   Anything else that differs is a genuine chain-dependence bug and lands in
 *   the diff with table + row detail.
 *
 * NOTE (regtest): the three regtest networks share base58 version bytes
 * (pubKeyHash 0x6f / scriptHash 0xc4 / wif 0xef, per networks.js), so the SAME
 * pubkey encodes to the SAME address on all three and index_addresses does NOT
 * diverge here. On mainnet it would; Tier 1 holds regardless because the hash
 * is id-based, which is the point. The harness reuses one keypair per role
 * across all three chains, so address-string parity is expected, not asserted.
 *********************************************************************/

'use strict';

const assert = require('assert');
const { loadDigest } = require('./digest');

// Wall-clock / chain-native columns excluded everywhere (super-set of the
// indexer oracle's GLOBAL_COLUMN_EXCLUSIONS plus the live-stack residue).
const GLOBAL_COLUMN_EXCLUSIONS = [
    'created_at', 'created', 'updated', 'logged_at', // NOW()/CURRENT_TIMESTAMP
    'time',                                          // events.time
    'tx_hash', 'tx_hash_id',                         // chain-native txid + its pointer
    'block_hash', 'block_time',                      // chain-native / unpinned
    'last_updated',                                  // markets: wall-clock of the match run
];

// Per-coin protocol role addresses (regtest constants from
// xchain-indexer/src/configs/<CODE>.js, case 'regtest'). These are the ONLY
// addresses that legitimately differ across chains for an identical corpus
// (e.g. the xchain-fee-mode issuance fee is credited to the chain's DONATE1, so
// index_addresses grows a per-coin row). Normalised to role tags before
// comparison (calibrated against the first real BTC<>DOGE diff, which showed
// exactly one residual row: DONATE1). FEE_DESTINATION here is each config's
// real default; the placeholder ('X'*34) is identical cross-chain anyway.
const SPECIAL_ADDRESSES = {
    BTC: {
        'mxchainburnaddressXXXXXXXXXXa8EAfp': '<BURN>',
        'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ': '<GAS>',
        'muYHF9MMnK6Nmd5zx7EBtqEYZdaf2Xy8JX': '<DONATE1>',
        'mkQd27aJSqsQ666z1Q4MLFmd3Ybqzy3TNw': '<DONATE2>',
        'mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim': '<FEE_DESTINATION>',
        'mrewardshQqD1ptkEBZGjPDF77L5uKJQmk': '<REWARD>',
    },
    DOGE: {
        'mvs8WdppEhzQLxfcYwrr1eoKA2nUFi55ff': '<BURN>',
        'mgasDTdKu5DsbW97qSRnE8raAuYpKMfmhg': '<GAS>',
        'mzdg8wGxgP3Jk45FuZPspumCL3Ruup37ob': '<DONATE1>',
        'mmXU8RU7q3BUsyT66rtw1H6P7B2ZZd9c5Y': '<DONATE2>',
        'mfees5pa2HwNBonk5vG23aDWkN9fuDJib4': '<FEE_DESTINATION>',
    },
    LTC: {
        'mxchainburnaddressXXXXXXXXXXa8EAfp': '<BURN>',
        'mgas5QYE38Bg34hwEjFKaE7Gs536FARue4': '<GAS>',
        'mgNY2ZXbnNEkRT5ZRF8yGamivrSX2QH97h': '<DONATE1>',
        'n2DLJPppXUi8jC6fLiSkthZi2sc9UKiZHd': '<DONATE2>',
        'mfeesJdVLx23zhtsCveA8EEfmHX7qSV2Ls': '<FEE_DESTINATION>',
    },
};

// Per-table extra exclusions: pointers into the (chain-native) index_transactions
// id-space. Identical to equivalence.js CONTENT_MODE_TABLE_EXCLUSIONS.
const TABLE_COLUMN_EXCLUSIONS = {
    blocks: ['ledger_hash_id', 'actions_hash_id', 'contract_hash_id'],
};

// Tables skipped wholesale.
//   - index_transactions: chain-native txids/block hashes; verified via Tier 1.
//   - schema_migrations: migration bookkeeping (wall-clock applied_at; the
//     applied SET also varies with the DB-create vintage). Infra meta, not
//     consensus state.
const IGNORE_TABLES = new Set(['index_transactions', 'schema_migrations']);

// Canonicalise one JSON-safe row object: drop excluded columns, stable key
// order, JSON string. (digest.js already coerced Buffer/BigInt/Date.)
function canonicalRow(row, excluded) {
    const out = {};
    for (const key of Object.keys(row).sort()) {
        if (excluded.includes(key)) continue;
        out[key] = row[key];
    }
    return JSON.stringify(out);
}

function excludedColumns(table) {
    return GLOBAL_COLUMN_EXCLUSIONS.concat(TABLE_COLUMN_EXCLUSIONS[table] || []);
}

// Normalise per-chain literals out of the canonical row string, so the
// comparison is exhaustive (mirrors scenario 14's normalizeState):
//   - transactions.data : ORDER/DISPENSER give+get fields hold |COIN|.
//   - index_coins        : the deduped coin row holds the bare literal.
//   - ALL tables         : the chain's protocol role addresses (SPECIAL_ADDRESSES)
//                          become role tags. Base58 addresses are 26-35 distinct
//                          chars, so a plain string replace cannot false-match.
// Applied to the CANONICAL row string after column-exclusion.
function normalizeCanon(table, canon, coin) {
    if (!coin) return canon;
    const special = SPECIAL_ADDRESSES[coin] || {};
    for (const addr of Object.keys(special)) {
        canon = canon.split(addr).join(special[addr]);
    }
    if (table === 'transactions') {
        return canon.split('|' + coin + '|').join('|<COIN>|');
    }
    if (table === 'index_coins') {
        return canon.split('"' + coin + '"').join('"<COIN>"');
    }
    return canon;
}

// Build the canonical, normalised, sorted row list for one table of one digest.
function tableCanon(digest, table) {
    const coin = (digest.meta && digest.meta.coin) || null;
    const excluded = excludedColumns(table);
    return (digest.tables[table] || [])
        .map(r => normalizeCanon(table, canonicalRow(r, excluded), coin))
        .sort();
}

/**
 * Compare a resolved hash chain pair. Returns { equal, firstDivergence }.
 */
function diffHashChains(chainA, chainB) {
    const len = Math.min(chainA.length, chainB.length);
    for (let i = 0; i < len; i++) {
        const a = chainA[i], b = chainB[i];
        if (a.block_index !== b.block_index) {
            return { equal: false, firstDivergence: {
                position: i, field: 'block_index', a: a.block_index, b: b.block_index } };
        }
        for (const field of ['ledger', 'actions', 'contracts']) {
            if (a[field] !== b[field]) {
                return { equal: false, firstDivergence: {
                    block_index: a.block_index, field, a: a[field], b: b[field] } };
            }
        }
    }
    if (chainA.length !== chainB.length) {
        return { equal: false, firstDivergence: {
            field: 'length', a: chainA.length, b: chainB.length } };
    }
    return { equal: true, firstDivergence: null };
}

/**
 * Structural diff of two digests' DBs (Tier 2). Returns an array of per-table
 * diff records (empty == identical).
 */
function diffStructural(digA, digB, labelA, labelB, maxDiffRows = 4) {
    const tablesA = Object.keys(digA.tables).sort();
    const tablesB = Object.keys(digB.tables).sort();
    const diffs = [];
    if (JSON.stringify(tablesA) !== JSON.stringify(tablesB)) {
        diffs.push({ table: '<schema>', issue: 'table set differs',
            [labelA]: tablesA, [labelB]: tablesB });
        return diffs;
    }
    for (const table of tablesA) {
        if (IGNORE_TABLES.has(table)) continue;
        const canonA = tableCanon(digA, table);
        const canonB = tableCanon(digB, table);
        if (canonA.length === canonB.length &&
            canonA.every((r, i) => r === canonB[i])) continue;
        const setA = new Set(canonA);
        const setB = new Set(canonB);
        diffs.push({
            table,
            [labelA + ' rows']: canonA.length,
            [labelB + ' rows']: canonB.length,
            ['only in ' + labelA]: canonA.filter(r => !setB.has(r)).slice(0, maxDiffRows),
            ['only in ' + labelB]: canonB.filter(r => !setA.has(r)).slice(0, maxDiffRows),
        });
    }
    return diffs;
}

/**
 * Compare N digests pairwise against the first (the reference chain). Returns
 * a structured report; does not throw. opts.maxDiffRows caps per-table samples.
 *
 * @param {Array<{label:string, digest:object}>} entries
 */
function compareDigests(entries, opts = {}) {
    const maxDiffRows = opts.maxDiffRows || 4;
    const ref = entries[0];
    const report = { reference: ref.label, pairs: [], ok: true };
    for (let i = 1; i < entries.length; i++) {
        const cur = entries[i];
        const hash = diffHashChains(ref.digest.hashChain, cur.digest.hashChain);
        const structural = diffStructural(ref.digest, cur.digest, ref.label, cur.label, maxDiffRows);
        const ok = hash.equal && structural.length === 0;
        report.pairs.push({ a: ref.label, b: cur.label, hash, structural, ok });
        if (!ok) report.ok = false;
    }
    return report;
}

/** Throwing wrapper for use inside a mocha assertion. */
function assertDigestsEqual(entries, opts = {}) {
    const report = compareDigests(entries, opts);
    for (const pair of report.pairs) {
        assert.ok(pair.hash.equal,
            `CONSENSUS FORK: hash chain ${pair.a} vs ${pair.b}: ` +
            JSON.stringify(pair.hash.firstDivergence));
        assert.strictEqual(pair.structural.length, 0,
            `CHAIN-DEPENDENCE: ${pair.a} vs ${pair.b} differ in ` +
            pair.structural.map(d => d.table).join(', ') + ':\n' +
            JSON.stringify(pair.structural, null, 2));
    }
    return report;
}

function formatReport(report) {
    const lines = [`reference chain: ${report.reference}`];
    for (const p of report.pairs) {
        lines.push(`\n${p.a}  vs  ${p.b}:`);
        lines.push(`  TIER 1 hash chain: ${p.hash.equal ? 'IDENTICAL ✓' : 'FORK ✗ ' + JSON.stringify(p.hash.firstDivergence)}`);
        if (p.structural.length === 0) {
            lines.push('  TIER 2 structural: IDENTICAL ✓ (modulo coin literal + chain-native residue)');
        } else {
            lines.push(`  TIER 2 structural: ${p.structural.length} table(s) differ ✗`);
            lines.push(JSON.stringify(p.structural, null, 2));
        }
    }
    lines.push(`\nRESULT: ${report.ok ? 'PARITY HOLDS ✓' : 'PARITY VIOLATED ✗'}`);
    return lines.join('\n');
}

module.exports = {
    GLOBAL_COLUMN_EXCLUSIONS,
    TABLE_COLUMN_EXCLUSIONS,
    SPECIAL_ADDRESSES,
    IGNORE_TABLES,
    canonicalRow,
    tableCanon,
    diffHashChains,
    diffStructural,
    compareDigests,
    assertDigestsEqual,
    formatReport,
};

// CLI: node compare.js <BTC=path> <LTC=path> <DOGE=path>
// First arg is the reference chain. Exits non-zero on any parity violation.
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('usage: node compare.js <LABEL=digest.json> <LABEL=digest.json> [...]');
        process.exit(2);
    }
    const entries = args.map(a => {
        const eq = a.indexOf('=');
        const label = eq > 0 ? a.slice(0, eq) : a;
        const file = eq > 0 ? a.slice(eq + 1) : a;
        return { label, digest: loadDigest(file) };
    });
    const report = compareDigests(entries);
    console.log(formatReport(report));
    process.exit(report.ok ? 0 : 1);
}
