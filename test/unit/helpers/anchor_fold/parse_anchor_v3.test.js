/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { parseAnchorV3 } = require('../../../helpers/anchor_fold/parse_anchor_v3');

const PIPE = String.fromCharCode(124);

function section(chain, blockIndex, sigs){
    return [
        chain, blockIndex, chain + '-block', chain + '-ledger', chain + '-actions',
        chain + '-contract', blockIndex + 1, 72, chain + '-state', 1,
        chain + '-merkle', 2, sigs.length,
        ...sigs.flatMap((pair) => [pair.pubkey, pair.sig])
    ];
}

function v3Payload(withArchive){
    const parts = [
        'ANCHOR', 3, 'regtest', 72, 2,
        ...section('BTC', 100, [{ pubkey: 'btc-key', sig: 'btc-sig' }]),
        ...section('LTC', 200, [
            { pubkey: 'ltc-key-1', sig: 'ltc-sig-1' },
            { pubkey: 'ltc-key-2', sig: 'ltc-sig-2' }
        ]),
        withArchive ? 1 : 0
    ];
    if(withArchive) parts.push(1, 9, 4, 'a1b2c3d4', 3, 'archive-data');
    parts.push('publisher-key', 1, 'attest-key', 'attest-sig');
    return parts.join(PIPE);
}

describe('parseAnchorV3', function () {
    it('reads two sections and the folded archive', function () {
        const parsed = parseAnchorV3(v3Payload(true));
        assert.strictEqual(parsed.network, 'regtest');
        assert.strictEqual(parsed.snapshotBlock, 72);
        assert.strictEqual(parsed.sections.length, 2);
        assert.deepStrictEqual(parsed.sections[0], {
            chain: 'BTC', block_index: 100, block_hash: 'BTC-block',
            ledger_hash: 'BTC-ledger', actions_hash: 'BTC-actions',
            contract_hash: 'BTC-contract', checkpoint_seq: 101,
            section_snapshot_block: 72, state_root: 'BTC-state', state_root_version: 1,
            block_merkle_root: 'BTC-merkle', block_merkle_version: 2,
            sigs: [{ pubkey: 'btc-key', sig: 'btc-sig' }]
        });
        assert.deepStrictEqual(parsed.sections[1].sigs, [
            { pubkey: 'ltc-key-1', sig: 'ltc-sig-1' },
            { pubkey: 'ltc-key-2', sig: 'ltc-sig-2' }
        ]);
        assert.strictEqual(parsed.archiveCount, 1);
        assert.deepStrictEqual(parsed.archive, {
            wrapperSectionIndex: 1, matchBatchSeq: 9, matchCount: 4,
            batchCrc32: 'a1b2c3d4', totalChunks: 3, archiveB64: 'archive-data'
        });
        assert.strictEqual(parsed.publisher, 'publisher-key');
        assert.deepStrictEqual(parsed.attestSigs, [
            { pubkey: 'attest-key', sig: 'attest-sig' }
        ]);
    });

    it('reads the same two-section wire without an archive', function () {
        const parsed = parseAnchorV3(v3Payload(false));
        assert.strictEqual(parsed.sections.length, 2);
        assert.strictEqual(parsed.archiveCount, 0);
        assert.strictEqual(parsed.archive, null);
        assert.strictEqual(parsed.publisher, 'publisher-key');
        assert.deepStrictEqual(parsed.attestSigs, [
            { pubkey: 'attest-key', sig: 'attest-sig' }
        ]);
    });

    it('returns null for an ANCHOR v0 payload', function () {
        assert.strictEqual(parseAnchorV3(v3Payload(false).replace('ANCHOR|3|', 'ANCHOR|0|')), null);
    });

    it('names SIG_COUNT when a section declares pairs the wire cannot carry', function () {
        const fields = v3Payload(false).split(PIPE);
        fields[17] = '100';
        assert.throws(() => parseAnchorV3(fields.join(PIPE)), /SIG_COUNT/);
    });

    it('names malformed archive and attestation fields', function () {
        const archiveFields = v3Payload(true).split(PIPE);
        const archiveB64 = archiveFields.indexOf('archive-data');
        assert.throws(() => parseAnchorV3(archiveFields.slice(0, archiveB64).join(PIPE)),
            /ARCHIVE_B64/);

        const invalidArchiveCount = v3Payload(false).split(PIPE);
        invalidArchiveCount[invalidArchiveCount.indexOf('publisher-key') - 1] = '2';
        assert.throws(() => parseAnchorV3(invalidArchiveCount.join(PIPE)), /ARCHIVE_COUNT/);

        const invalidAttestCount = v3Payload(false).split(PIPE);
        invalidAttestCount[invalidAttestCount.length - 3] = '2';
        assert.throws(() => parseAnchorV3(invalidAttestCount.join(PIPE)), /ATTEST_SIG_COUNT/);
    });
});
