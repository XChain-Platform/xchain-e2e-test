'use strict';

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
 **********************************************************************
 * Part of test/unit/oracle_batch_barrier_testnet_alignment.test.js
 ********************************************************************/

const drill = require('../../drills/lib/oracle_batch_barrier_testnet.js');

// ---------------------------------------------------------------------------
// Run 5's own 20 actions, node side and origin side
// ---------------------------------------------------------------------------

// node: rows of the AT5 node's `actions` table joined to index_actions and
//       index_transactions, as blockActions() now reads them.
// origin: the row https://explorer.xchain.io/TDOGE/api/actions?limit=200 returns
//       for that transaction, fields verbatim, numbers still strings.
const REAL_PAIRS = [
    { node: { height: 67881904, actionIndex: 245, action: "PRICE", txIndex: 246, txVout: 0, txHash: "09f65851dc9678b9504f2b458a1f10731b7907d677956a88833898927210b19a" },
      origin: { action: "PRICE", action_format: 0, action_index: "650", block_index: "67881904", tx_hash: "09f65851dc9678b9504f2b458a1f10731b7907d677956a88833898927210b19a", tx_index: "649" } },
    { node: { height: 67881915, actionIndex: 246, action: "PRICE", txIndex: 248, txVout: 0, txHash: "2c2780c5044bb78d1544212eec67b382ce015b6a2678b3f0f1a19f7bbc566baa" },
      origin: { action: "PRICE", action_format: 0, action_index: "651", block_index: "67881915", tx_hash: "2c2780c5044bb78d1544212eec67b382ce015b6a2678b3f0f1a19f7bbc566baa", tx_index: "651" } },
    { node: { height: 67881937, actionIndex: 247, action: "PRICE", txIndex: 250, txVout: 0, txHash: "69c2cb00983c944e0575e6305db5e3d9466e3b1554e69d42d01561e29851bc77" },
      origin: { action: "PRICE", action_format: 0, action_index: "652", block_index: "67881937", tx_hash: "69c2cb00983c944e0575e6305db5e3d9466e3b1554e69d42d01561e29851bc77", tx_index: "653" } },
    { node: { height: 67881944, actionIndex: 248, action: "PRICE", txIndex: 251, txVout: 0, txHash: "8f475e3b577d984a5f7b9c40389e41b559f3e0a21428082d8683a7ccf820bd0b" },
      origin: { action: "PRICE", action_format: 0, action_index: "653", block_index: "67881944", tx_hash: "8f475e3b577d984a5f7b9c40389e41b559f3e0a21428082d8683a7ccf820bd0b", tx_index: "654" } },
    { node: { height: 67881946, actionIndex: 249, action: "ATTEST", txIndex: 252, txVout: 0, txHash: "489f2b7a08a5b3bb7ad6f2a4918b18df9af06553f3913d767c712b00cf39d135" },
      origin: { action: "ATTEST", action_format: 5, action_index: "654", block_index: "67881946", tx_hash: "489f2b7a08a5b3bb7ad6f2a4918b18df9af06553f3913d767c712b00cf39d135", tx_index: "655" } },
    { node: { height: 67881946, actionIndex: 250, action: "ATTEST", txIndex: 253, txVout: 0, txHash: "aaeadf60d89854252a3d2bb7536b7c53e9aa3bda89484b71ede95c141e75bd6c" },
      origin: { action: "ATTEST", action_format: 5, action_index: "655", block_index: "67881946", tx_hash: "aaeadf60d89854252a3d2bb7536b7c53e9aa3bda89484b71ede95c141e75bd6c", tx_index: "656" } },
    { node: { height: 67881946, actionIndex: 251, action: "ATTEST", txIndex: 254, txVout: 0, txHash: "81c55eae91486760b27973eeafba36e64bcb517dd4f8778c33d6a9d3d9ab2a7a" },
      origin: { action: "ATTEST", action_format: 5, action_index: "656", block_index: "67881946", tx_hash: "81c55eae91486760b27973eeafba36e64bcb517dd4f8778c33d6a9d3d9ab2a7a", tx_index: "657" } },
    { node: { height: 67881985, actionIndex: 252, action: "PRICE", txIndex: 255, txVout: 0, txHash: "ec9f7cf7497d7365cdc815e4d8c8012cbeefe35936b3f2e4c80c898931cb173f" },
      origin: { action: "PRICE", action_format: 0, action_index: "657", block_index: "67881985", tx_hash: "ec9f7cf7497d7365cdc815e4d8c8012cbeefe35936b3f2e4c80c898931cb173f", tx_index: "658" } },
    { node: { height: 67881996, actionIndex: 253, action: "PRICE", txIndex: 256, txVout: 0, txHash: "f93ca56a0ebd55f6ee4ca5481c65166cf29f3e2ee1968d29a7b0934b47716478" },
      origin: { action: "PRICE", action_format: 0, action_index: "658", block_index: "67881996", tx_hash: "f93ca56a0ebd55f6ee4ca5481c65166cf29f3e2ee1968d29a7b0934b47716478", tx_index: "659" } },
    { node: { height: 67882002, actionIndex: 254, action: "ANCHOR", txIndex: 257, txVout: 0, txHash: "1bf4382f68df9fd4b916302bea0e3c4f19edfa6b546a475ae7ad981012290832" },
      origin: { action: "ANCHOR", action_format: 0, action_index: "659", block_index: "67882002", tx_hash: "1bf4382f68df9fd4b916302bea0e3c4f19edfa6b546a475ae7ad981012290832", tx_index: "660" } },
    { node: { height: 67882023, actionIndex: 255, action: "PRICE", txIndex: 258, txVout: 0, txHash: "8487594f261198d840da2b44f67338978b495b86e343ee852cfd91630db5ceed" },
      origin: { action: "PRICE", action_format: 0, action_index: "660", block_index: "67882023", tx_hash: "8487594f261198d840da2b44f67338978b495b86e343ee852cfd91630db5ceed", tx_index: "661" } },
    { node: { height: 67882040, actionIndex: 256, action: "PRICE", txIndex: 259, txVout: 0, txHash: "33c23730935918d65c5a60f6e2eb0ac05ba9be915df45e420457f4000c45df9d" },
      origin: { action: "PRICE", action_format: 0, action_index: "661", block_index: "67882040", tx_hash: "33c23730935918d65c5a60f6e2eb0ac05ba9be915df45e420457f4000c45df9d", tx_index: "662" } },
    { node: { height: 67882080, actionIndex: 257, action: "ATTEST", txIndex: 260, txVout: 0, txHash: "8cbf12505aec107968a5beec4338542bdd45c547bd61c8d3ac4a6b815a7b0efe" },
      origin: { action: "ATTEST", action_format: 5, action_index: "662", block_index: "67882080", tx_hash: "8cbf12505aec107968a5beec4338542bdd45c547bd61c8d3ac4a6b815a7b0efe", tx_index: "663" } },
    { node: { height: 67882080, actionIndex: 258, action: "ATTEST", txIndex: 261, txVout: 0, txHash: "8fa785d75cb4e2b40170b8e9a1b45406346f74eb327b11b200c2fdb9c7cfd9ea" },
      origin: { action: "ATTEST", action_format: 5, action_index: "663", block_index: "67882080", tx_hash: "8fa785d75cb4e2b40170b8e9a1b45406346f74eb327b11b200c2fdb9c7cfd9ea", tx_index: "664" } },
    { node: { height: 67882084, actionIndex: 259, action: "ORDER", txIndex: 262, txVout: 0, txHash: "5af21b8cab026cf7dc23c4d3443881dd0498935b52346b32efbd05f494801b9a" },
      origin: { action: "ORDER", action_format: 0, action_index: "664", block_index: "67882084", tx_hash: "5af21b8cab026cf7dc23c4d3443881dd0498935b52346b32efbd05f494801b9a", tx_index: "665" } },
    { node: { height: 67882087, actionIndex: 260, action: "ORDER", txIndex: 263, txVout: 0, txHash: "018c4a5285d6292c179b58865287abcd93aaf3ae91ef0aeda53d9b7cff6b6d2c" },
      origin: { action: "ORDER", action_format: 0, action_index: "665", block_index: "67882087", tx_hash: "018c4a5285d6292c179b58865287abcd93aaf3ae91ef0aeda53d9b7cff6b6d2c", tx_index: "666" } },
    { node: { height: 67882120, actionIndex: 261, action: "PRICE", txIndex: 265, txVout: 0, txHash: "d1af6018c6b918d7da4f967f2f25541432b71ba4c4564e37d96914129efd10be" },
      origin: { action: "PRICE", action_format: 0, action_index: "668", block_index: "67882120", tx_hash: "d1af6018c6b918d7da4f967f2f25541432b71ba4c4564e37d96914129efd10be", tx_index: "668" } },
    { node: { height: 67882121, actionIndex: 262, action: "PRICE", txIndex: 266, txVout: 0, txHash: "cbada86af5c0164061bca9a23a824774a9e7dc1de4b3bd8dc83f3981a882e139" },
      origin: { action: "PRICE", action_format: 0, action_index: "669", block_index: "67882121", tx_hash: "cbada86af5c0164061bca9a23a824774a9e7dc1de4b3bd8dc83f3981a882e139", tx_index: "669" } },
    { node: { height: 67882158, actionIndex: 263, action: "PRICE", txIndex: 267, txVout: 0, txHash: "359034fcbab39e63ee4eb47760da699489a7acfc7b070813764f35182d0c7dd4" },
      origin: { action: "PRICE", action_format: 0, action_index: "671", block_index: "67882158", tx_hash: "359034fcbab39e63ee4eb47760da699489a7acfc7b070813764f35182d0c7dd4", tx_index: "670" } },
    { node: { height: 67882168, actionIndex: 264, action: "PRICE", txIndex: 268, txVout: 0, txHash: "9fcd7f102b0a49bb13aa0924da7c0d409a1c7a08b70bb3846f9395d743d6e4ce" },
      origin: { action: "PRICE", action_format: 0, action_index: "672", block_index: "67882168", tx_hash: "9fcd7f102b0a49bb13aa0924da7c0d409a1c7a08b70bb3846f9395d743d6e4ce", tx_index: "671" } }
];

// Two DERIVED actions from the same live window. A derived action is filed by
// origin with no transaction at all: `tx_hash` null AND `tx_index` null. They
// are here because a null must never behave as a wildcard.
const DERIVED_ROWS = [
    { action: "ORDER_MATCH",    action_format: null, action_index: "666", block_index: "67882087", tx_hash: null, tx_index: null },
    { action: "COINPAY_EXPIRE", action_format: null, action_index: "670", block_index: "67882126", tx_hash: null, tx_index: null }
];

// The window all 20 pairs are matched against here. A live one is origin's
// newest actions in one page (the endpoint caps that at 100, which spanned 1,416
// blocks when this was measured); this one carries just the rows those 20
// transactions need, plus the two derived rows, so the file needs no network.
const WINDOW = REAL_PAIRS.map((p) => p.origin).concat(DERIVED_ROWS);

const ORDER_666 = REAL_PAIRS.find((p) => p.origin.tx_index === "666");

function indexOf(rows) { return drill.buildOriginActionIndex(rows); }

module.exports = { drill, REAL_PAIRS, DERIVED_ROWS, WINDOW, ORDER_666, indexOf };
