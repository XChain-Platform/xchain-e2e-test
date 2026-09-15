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
 * XChain Platform E2E - sdk.decoder against the live chain
 *
 * The SDK decoder module (sdk.decoder.parse / describe, and the PSBT
 * extraction the MuSig2 co-signer signs against) is pinned by unit
 * suites in xchain-sdk against locally composed action strings. Those
 * prove the SDK agrees with ITSELF. This suite proves it agrees with
 * the CHAIN, on two lanes:
 *
 *   1. Corpus replay (read-only). Every recent action the indexer
 *      recorded is re-parsed from the exact wire bytes the
 *      authoritative decoder recovered from the OP_RETURN (`tx_data`).
 *      parse() must agree with the indexer on the action, the version
 *      and the field values, and must be a canonicalization fixpoint
 *      on real wire bytes. A parse that quietly disagrees here is a
 *      co-signer that signs something other than what indexes.
 *
 *   2. Live round-trip (writes to chain). compose -> live encoder ->
 *      real PSBT over real UTXOs -> extract the action string back out
 *      of the PSBT -> parse -> broadcast -> compare against what the
 *      indexer decoded off the confirmed transaction. The extraction
 *      runs inside a custom `signer`, i.e. at the exact point a
 *      hardware/co-signer wallet reads the payload it is about to
 *      sign.
 *
 * Read-only lane 1 is safe to run against a shared venue at any time.
 * Lane 2 broadcasts a handful of small actions on regtest.
 *
 * Run (NFS tree, Node 22):
 *
 *     npm run test:sdk:decoder
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { makeSdk, loadSDK } = require('./sdkHelper');
const checks = require('./decoderRoundtrip.sdk.test/helpers/corpus_checks');

const { decoder } = loadSDK();

// How far back through the action index the corpus lane walks. Every row is
// one explorer round trip, so this trades runtime for coverage.
const CORPUS_SIZE = Number(process.env.DECODER_CORPUS_SIZE || 250);

const corpusCache = new Map();

async function loadCorpus (label, network) {
    if (corpusCache.has(label)) return corpusCache.get(label);
    // Address compaction off, matching the other SDK suites: a `^<id>`
    // DESTINATION is rejected on a chain that has not seen the address.
    const sdk = makeSdk({ compactAddresses: false });
    const FORMATS = {};
    for (const action of sdk.getActions()) FORMATS[action] = sdk.getActionFormats(action) || {};
    const chainSdk = network ? makeSdk({ network, compactAddresses: false }) : sdk;
    const rows = [];
    let list;
    try {
        const latest = await chainSdk.explorer.getActions({ limit: 1 });
        list = (latest && latest.data) || latest || [];
    } catch (e) { list = []; }
    if (!list.length) {
        console.log('    [sdk] corpus [' + label + ']: no actions served, skipping');
        const state = { rows, FORMATS };
        corpusCache.set(label, state);
        return state;
    }

    let index = Number(list[0].action_index);
    while (index > 0 && rows.length < CORPUS_SIZE) {
        let row = null;
        try { row = await chainSdk.explorer.getAction(index); } catch (e) { row = null; }
// tx_data is empty for actions the VM/indexer synthesized on a
// transaction that carried no OP_RETURN at all (a DISPENSE
// triggered by a plain coin send); there is no wire string to
// re-parse. A synthesized action on a transaction that DID carry
// one (a DISPENSE triggered by a token SEND) is served the parent
// transaction's string instead, and stays in the corpus: those
// bytes are real, they just belong to the parent row. See
// DERIVED_ROW_ACTIONS.
        if (row && typeof row.tx_data === 'string' && row.tx_data !== '') rows.push(row);
        index--;
    }
    console.log('    [sdk] corpus [' + label + ']: ' + rows.length +
                ' on-chain actions with wire data, newest index ' + list[0].action_index);
    expect(rows.length, 'corpus is non-empty').to.be.greaterThan(0);
    const state = { rows, FORMATS };
    corpusCache.set(label, state);
    return state;
}

function registerCorpusTest (label, network, title, check) {
    describe('[sdk] decoder.parse vs the live chain', function () {
        this.timeout(0);
        describe('corpus replay [' + label + ']: re-parse what the chain already carries', function () {
            let state;
            before(async function () {
                state = await loadCorpus(label, network);
                if (!state.rows.length) this.skip();
            });
            it(title, function () { check(state.rows, state.FORMATS, decoder, label); });
        });
    });
}

    // =====================================================================
    // Lane 1: corpus replay (read-only)
    //
    // Declared per chain. The venue's explorer serves all three regtest
    // chains, and the decoder is chain-agnostic, so the same replay runs
    // against each: the action mixes differ (LTC/DOGE carry the native-fee
    // and cross-chain traffic BTC does not), which is free coverage. A chain
    // the venue does not serve skips rather than fails.
    // =====================================================================
function corpusLane (label, network) {
    registerCorpusTest(label, network, 'every valid on-chain action string parses', checks.validStringsParse);
    registerCorpusTest(label, network, 'parse never disagrees with the indexer about the action or version', checks.actionAndVersionMatch);
    registerCorpusTest(label, network, 'parse is a canonicalization fixpoint on real wire bytes', checks.canonicalizationIsStable);
    registerCorpusTest(label, network, 'parsed field values agree with the values the indexer recorded', checks.fieldValuesMatch);
    registerCorpusTest(label, network, 'derived rows agree with the parent row the wire bytes belong to', checks.derivedRowsMatchParents);
    registerCorpusTest(label, network, 'describe() renders every on-chain action', checks.descriptionsRender);
}

    // The chain this run is pointed at, then the venue's other two.
    corpusLane('run network', null);
    corpusLane('litecoin-regtest', 'litecoin-regtest');
    corpusLane('dogecoin-regtest', 'dogecoin-regtest');

require('./decoderRoundtrip.sdk.test/01_live_round_trip_compose_encoder_psbt_parse_chain.test');
