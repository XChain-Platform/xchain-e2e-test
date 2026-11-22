/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const { S } = require('./support/state');

// The indexers to read the sections back from: this venue's, plus a from-genesis
// one when the operator points XC_ANCHOR_FRESH_INDEXER_URL at it.
function readTargets(){
    const targets = [{ label: 'this venue', conn: indexerConnector }];
    if (process.env.XC_ANCHOR_FRESH_INDEXER_URL) {
        const XChainIndexerConnector = require('../../../src/XChainIndexerConnector');
        const u = new URL(process.env.XC_ANCHOR_FRESH_INDEXER_URL);
        targets.push({ label: 'fresh full-parse indexer',
                       conn: new XChainIndexerConnector(u.hostname, u.port,
                                                        process.env.INDEXER_API_KEY || null) });
    } else {
        console.log('    (no XC_ANCHOR_FRESH_INDEXER_URL; asserting the chain-derived rows on this venue only)');
    }
    return targets;
}

async function assertSectionServed(t, s){
    const r = await t.conn.call('getanchoraction', {
        chain: String(s.chain), network: String(s.network),
        block_index: Number(s.block_index), checkpoint_seq: Number(s.checkpoint_seq)
    });
    const tag = t.label + ' / ' + s.chain;
    assert.ok(r && r.exists, tag + ': getanchoraction finds the section');
    assert.strictEqual(Number(r.version), 0, tag + ': served as a v0 section');
    assert.strictEqual(String(r.status), 'valid', tag + ': section is valid');
    assert.strictEqual(String(r.txid).toLowerCase(), String(S.bundleTxid).toLowerCase(),
        tag + ': every section resolves to the ONE bundle transaction');
    assert.strictEqual(String(r.ledger_hash), String(s.ledger_hash),
        tag + ': the section carries its own per-chain roots and hashes');
    assert.strictEqual(String(r.state_root).toLowerCase(), String(s.state_root).toLowerCase(),
        tag + ': state_root recovered from the chain');
}

async function runAt4(){
    assert.ok(S.bundleSections.length === 3 && S.bundleTxid,
        'AT1 must have run first (it produces the bundle this reads back)');
    for (const t of readTargets()) {
        for (const s of S.bundleSections) await assertSectionServed(t, s);
        console.log('    ' + t.label + ': all three sections served by (chain, network, block_index, seq) at txid ' + S.bundleTxid);
    }
}

// AT4 (recovery). state_checkpoints is hub-mirror-owned and written only by
// StateCheckpointEngine; no code path rebuilds it from anchors. What a node
// recovers by parsing the chain IS the anchor_actions section rows, and
// `getanchoraction` is the RPC that serves them by (chain, network, block_index,
// seq), the same lookup the hub's own findExistingBundle makes per section and
// the SPV bootstrap reads.
//
// The record under test is the CHAIN-DERIVED one: these rows were written by
// the indexer parsing the transaction, with no hub DB involved in the read.
// Running the parse on a FRESHLY WIPED indexer (the full "no hub DB" form) is a
// venue operation, not something a suite may do to a shared regtest stack, so
// point XC_ANCHOR_FRESH_INDEXER_URL at a from-genesis indexer to have this
// assert both views instead of one.
function register(){
    it('AT4: every section of the bundle is served by getanchoraction on (chain, network, block_index, seq)', async function () {
        await runAt4();
    });
}

module.exports = { register };
