/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 * ANCHOR v0 bundle wire: cross-service producer/parser parity.
 *
 * The checkpoint leg is ONE wire, ANCHOR v0 (the version set restarted,
 * anchor-v0-single-wire.md D2; byte-for-byte the same wire yesterday's ANCHOR
 * v7 was, only the version byte moved): a header (NETWORK, the bundle
 * SNAPSHOT_BLOCK, SECTION_COUNT), SECTION_COUNT positional sections and one
 * publisher-attestation tail. Three services hold their own inline copy of that
 * field order:
 *
 *   producer  xchain-hub      StateAnchorPublisher._buildV7Payload (method name
 *                             unchanged; only the version byte it writes moved)
 *   parser    xchain-indexer  actions/anchor.js _parseBundle (formats[0])
 *   parser    xchain-sdk      light.parseAnchorV0
 *
 * A one-field drift between any two forks consensus silently: the indexer rebuilds
 * a section canonical the validators never signed (zero valid signatures, the whole
 * bundle invalid under D15), or the SDK verifies a shifted section and reports a
 * checkpoint the chain does not carry. Nothing in a single repo's CI can see it,
 * because each side is self-consistent with its own copy.
 *
 * The referee is the FROZEN vector at
 * xchain-documentation/protocol/test-vectors/anchor_canonical.json, which each of
 * the hub and the indexer vendors as a byte-identical fixture. This suite is the
 * only place all three services meet ONE copy of it in one process, so it also
 * catches a vendored fixture that was regenerated on one side to make a local test
 * pass.
 *
 * The vector's signatures are placeholder bytes, so nothing here verifies a
 * signature: what is under test is field order, ordering rules and cardinality.
 *
 * Spec: anchor-bundle-per-network.md 2.1 (wire), 2.3 (parse), D5 (ordering),
 * D6 (header block), D19 (vector location); anchor-v0-single-wire.md 2.1 (the
 * version restart), D10 (the vector's key rename).
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const ROOT = path.resolve(__dirname, '../../../..');

const GOLDEN = require(path.join(ROOT, 'xchain-documentation/protocol/test-vectors/anchor_canonical.json'));
const StateAnchorPublisher = require(path.join(ROOT, 'xchain-hub/src/StateAnchorPublisher.js'));
const Anchor               = require(path.join(ROOT, 'xchain-indexer/src/actions/anchor.js'));
const sdkLight             = require(path.join(ROOT, 'xchain-sdk/src/light.js'));

const BUNDLE = GOLDEN.fixture.bundle;
const WIRE   = GOLDEN.vectors.v0;

// The builder reads validator_signatures as a JSON string off each state_checkpoints
// row, and takes no `this` beyond _parseSigs.
const hubStub = { _parseSigs: StateAnchorPublisher.prototype._parseSigs };
const hubSections = BUNDLE.sections.map(s =>
    Object.assign({}, s, { validator_signatures: JSON.stringify(s.validator_signatures) }));

function hubBuild(sections) {
    return StateAnchorPublisher.prototype._buildV7Payload.call(
        hubStub, sections, BUNDLE.publisher, BUNDLE.attest_sigs);
}

// Drive the indexer's real parser over a wire string and collect the anchor_actions
// rows it would write. The DB stub answers the three reads _parseBundle makes:
//   - getMaxAnchorCheckpointSeq: no watermark, so the stale-seq guard admits the wire;
//   - the oracle_publish set: EMPTY, which makes the verdict 'unverified' and skips
//     both signature verification and the reward, because the frozen vector carries
//     placeholder signatures no key ever produced. The positional walk that writes
//     the rows runs either way, and that walk is what this suite is about.
async function indexerParse(wire) {
    const rows = [];
    const anchor = new Anchor({
        config:    { NETWORK: 'regtest', COIN: 'DOGE' },
        indexerDb: {
            getMaxAnchorCheckpointSeq:   async () => null,
            getStakeWeightsByCapability: async () => [],
            getValidatorsByCapability:   async () => [],
            createAnchorAction:          async (row) => { rows.push(row); return true; }
        },
        mapper:    { createMappings: async () => {} },
        util:      {},
        decoderDb: {},
        actions:   {}
    });
    // The decoder hands parse() the pipe-split action data with the action name
    // stripped, so params[0] is the version byte.
    //
    // BLOCK_INDEX is the anchor's own mined DOGE height, and it is REQUIRED: the
    // activation gate at the top of parse() reads it and fails CLOSED on a
    // non-numeric value, so a fixture that omits it is rejected as
    // 'invalid: ANCHOR before activation' and never reaches the positional walk
    // this suite exists to test. The real decoder always supplies it. regtest
    // activates at 0, so any height at or above 0 exercises the parse path.
    const data = { FORMAT: 0, BLOCK_INDEX: 1000 };
    await anchor.parse(wire.split('|').slice(1), data, null);
    return { data, rows };
}

describe('ANCHOR v0 bundle wire cross-service parity', function () {

    it('the hub producer reproduces the frozen vector byte-for-byte', function () {
        assert.strictEqual(hubBuild(hubSections), WIRE,
            'StateAnchorPublisher._buildV7Payload drifted from the frozen ANCHOR v0 vector');
    });

    it('the hub applies both ordering rules rather than echoing input order', function () {
        // The fixture lists its sections LTC, BTC, DOGE and one signature list out of
        // key order on purpose (D5). Without the outer sort two publishers racing the
        // same bundle emit different section order; without the inner sort they emit
        // different signature order. Either breaks the attestation round's byte-match
        // between peers, so the bytes must be a function of the STATE, not the query.
        assert.deepStrictEqual(BUNDLE.sections.map(s => s.chain), ['LTC', 'BTC', 'DOGE'],
            'the frozen fixture is supposed to be out of order');
        assert.strictEqual(hubBuild(hubSections.slice().reverse()), WIRE,
            'reversing the input sections changed the bundle bytes');
    });

    it('the indexer parser reads the frozen vector back to the hub section fields', async function () {
        const { data, rows } = await indexerParse(WIRE);

        assert.strictEqual(data['NETWORK'], BUNDLE.network, 'header NETWORK');
        assert.strictEqual(Number(data['SNAPSHOT_BLOCK']), Number(BUNDLE.snapshot_block), 'header SNAPSHOT_BLOCK');
        assert.strictEqual(Number(data['SECTION_COUNT']), BUNDLE.sections.length, 'header SECTION_COUNT');
        assert.strictEqual(data['PUBLISHER'], String(BUNDLE.publisher).toLowerCase(), 'publisher tail');
        assert.deepStrictEqual(JSON.parse(data['PUBLISHER_ATTESTATIONS']), BUNDLE.attest_sigs,
            'the attestation tail must survive the walk intact');

        // One row per section, section_index in wire (chain-ascending) order, each row
        // carrying the HEADER network: that denormalization is what keeps
        // idx_anchor_checkpoint and getMaxAnchorCheckpointSeq(chain, network) working
        // per chain with no query change (D1).
        assert.strictEqual(rows.length, BUNDLE.sections.length, 'one anchor_actions row per section');
        assert.deepStrictEqual(rows.map(r => r.SECTION_INDEX), [0, 1, 2], 'section_index runs in wire order');
        assert.deepStrictEqual(rows.map(r => r.CHAIN), ['BTC', 'DOGE', 'LTC'], 'sections read back chain-ascending');

        for (const row of rows) {
            const src = BUNDLE.sections.find(s => s.chain === row.CHAIN);
            assert.ok(src, 'parsed a chain the fixture does not carry: ' + row.CHAIN);
            assert.strictEqual(row.NETWORK, BUNDLE.network, row.CHAIN + ' section takes the header NETWORK');
            assert.strictEqual(Number(row.BLOCK_INDEX_CHECKPOINTED), src.block_index, row.CHAIN + ' BLOCK_INDEX');
            assert.strictEqual(row.BLOCK_HASH,    src.block_hash,    row.CHAIN + ' BLOCK_HASH');
            assert.strictEqual(row.LEDGER_HASH,   src.ledger_hash,   row.CHAIN + ' LEDGER_HASH');
            assert.strictEqual(row.ACTIONS_HASH,  src.actions_hash,  row.CHAIN + ' ACTIONS_HASH');
            assert.strictEqual(row.CONTRACT_HASH, src.contract_hash, row.CHAIN + ' CONTRACT_HASH');
            assert.strictEqual(Number(row.CHECKPOINT_SEQ), src.checkpoint_seq, row.CHAIN + ' CHECKPOINT_SEQ');
            assert.strictEqual(Number(row.SNAPSHOT_BLOCK), src.snapshot_block,
                row.CHAIN + ' section keeps its OWN snapshot block, not the header MAX');
            assert.strictEqual(row.STATE_ROOT,           src.state_root,           row.CHAIN + ' STATE_ROOT');
            assert.strictEqual(Number(row.STATE_ROOT_VERSION), src.state_root_version, row.CHAIN + ' STATE_ROOT_VERSION');
            assert.strictEqual(row.BLOCK_MERKLE_ROOT,    src.block_merkle_root,    row.CHAIN + ' BLOCK_MERKLE_ROOT');
            assert.strictEqual(Number(row.BLOCK_MERKLE_VERSION), src.block_merkle_version, row.CHAIN + ' BLOCK_MERKLE_VERSION');
            assert.deepStrictEqual(JSON.parse(row.VALIDATOR_SIGNATURES),
                src.validator_signatures.slice().sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1)),
                row.CHAIN + ' signature list must round-trip in PUBKEY order');
        }
    });

    it('the SDK parser reads the frozen vector back to the same section fields', function () {
        const parsed = sdkLight.parseAnchorV0(WIRE);

        assert.strictEqual(parsed.version, 0);
        assert.strictEqual(parsed.network, BUNDLE.network, 'header NETWORK');
        assert.strictEqual(parsed.snapshot_block, Number(BUNDLE.snapshot_block), 'header SNAPSHOT_BLOCK');
        assert.strictEqual(parsed.section_count, BUNDLE.sections.length, 'header SECTION_COUNT');
        assert.strictEqual(parsed.publisher, String(BUNDLE.publisher).toLowerCase(), 'publisher tail');
        assert.deepStrictEqual(parsed.publisher_attestations, BUNDLE.attest_sigs, 'attestation tail');
        assert.deepStrictEqual(parsed.sections.map(s => s.chain), ['BTC', 'DOGE', 'LTC'], 'chain-ascending');

        for (const sec of parsed.sections) {
            const src = BUNDLE.sections.find(s => s.chain === sec.chain);
            assert.strictEqual(sec.network, BUNDLE.network, sec.chain + ' section takes the header NETWORK');
            assert.strictEqual(sec.block_index,    src.block_index,    sec.chain + ' block_index');
            assert.strictEqual(sec.block_hash,     src.block_hash,     sec.chain + ' block_hash');
            assert.strictEqual(sec.ledger_hash,    src.ledger_hash,    sec.chain + ' ledger_hash');
            assert.strictEqual(sec.actions_hash,   src.actions_hash,   sec.chain + ' actions_hash');
            assert.strictEqual(sec.contract_hash,  src.contract_hash,  sec.chain + ' contract_hash');
            assert.strictEqual(sec.checkpoint_seq, src.checkpoint_seq, sec.chain + ' checkpoint_seq');
            assert.strictEqual(sec.snapshot_block, src.snapshot_block, sec.chain + ' keeps its own snapshot block');
            assert.strictEqual(sec.state_root,          src.state_root,           sec.chain + ' state_root');
            assert.strictEqual(sec.state_root_version,  src.state_root_version,   sec.chain + ' state_root_version');
            assert.strictEqual(sec.block_merkle_root,   src.block_merkle_root,    sec.chain + ' block_merkle_root');
            assert.strictEqual(sec.block_merkle_version, src.block_merkle_version, sec.chain + ' block_merkle_version');
        }
    });

    it('the indexer and the SDK agree field for field on every section', async function () {
        // The two parsers are read by different consumers (the indexer writes the row an
        // explorer serves; the SDK verifies a bundle a third party decoded itself), so
        // their agreement is the property that makes an SPV proof and a chain record the
        // same claim. Compared through a normalized projection because one side names
        // fields for the DB and the other for the checkpoint shape.
        const { rows } = await indexerParse(WIRE);
        const parsed   = sdkLight.parseAnchorV0(WIRE);
        const fromRow  = (r) => [String(r.CHAIN), Number(r.BLOCK_INDEX_CHECKPOINTED), r.BLOCK_HASH,
                                 r.LEDGER_HASH, r.ACTIONS_HASH, r.CONTRACT_HASH,
                                 Number(r.CHECKPOINT_SEQ), Number(r.SNAPSHOT_BLOCK),
                                 r.STATE_ROOT, Number(r.STATE_ROOT_VERSION),
                                 r.BLOCK_MERKLE_ROOT, Number(r.BLOCK_MERKLE_VERSION)];
        const fromSec  = (s) => [String(s.chain), s.block_index, s.block_hash,
                                 s.ledger_hash, s.actions_hash, s.contract_hash,
                                 s.checkpoint_seq, s.snapshot_block,
                                 s.state_root, s.state_root_version,
                                 s.block_merkle_root, s.block_merkle_version];
        assert.deepStrictEqual(rows.map(fromRow), parsed.sections.map(fromSec),
            'indexer and SDK v0 section parsers disagree on the frozen vector');
    });

    it('the SDK serves one chain out of the bundle, and null for a chain it does not carry', function () {
        // The per-chain reader is unchanged by bundling: fetchAnchoredCheckpoint still
        // asks for one target chain. A bundle that omits a chain is the NORMAL daily case
        // (D4), so the miss must be null rather than a throw.
        const ltc = sdkLight.anchorBundleSection(WIRE, 'LTC');
        assert.ok(ltc, 'the bundle carries an LTC section');
        assert.strictEqual(ltc.chain, 'LTC');
        assert.strictEqual(ltc.checkpoint_seq,
            BUNDLE.sections.find(s => s.chain === 'LTC').checkpoint_seq);
        assert.strictEqual(sdkLight.anchorBundleSection(WIRE, 'XMR'), null,
            'an absent chain must read as null, not an error');
    });

    it('the header SNAPSHOT_BLOCK is the MAX over sections, and a lagging section keeps its own', async function () {
        // D6: a chain whose round threw at the current seq rides at its own older block,
        // and its signatures were produced there. The header block is what the election
        // and the attestation bind to, so the parser REJECTS a header above the maximum
        // rather than trusting it.
        const lagging = hubSections.map(s => (s.chain === 'LTC'
            ? Object.assign({}, s, { snapshot_block: 94 })
            : s));
        const wire = hubBuild(lagging);
        assert.strictEqual(wire.split('|')[3], '100', 'header block is the MAX over sections');

        const { data, rows } = await indexerParse(wire);
        assert.strictEqual(String(data['STATUS']), 'unverified',
            'a well-formed bundle with no mirrored oracle set reads unverified, not invalid');
        assert.strictEqual(Number(rows.find(r => r.CHAIN === 'LTC').SNAPSHOT_BLOCK), 94,
            'the lagging section keeps its own snapshot block');

        const forged = wire.split('|');
        forged[3] = '101';
        const bad = await indexerParse(forged.join('|'));
        assert.strictEqual(bad.data['STATUS'], 'invalid: SNAPSHOT_BLOCK (not the section maximum)',
            'a header block above every section must invalidate the bundle');
    });
});
