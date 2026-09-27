/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const PIPE = String.fromCharCode(124);
const SECTION_FIELDS = [
    'CHAIN', 'BLOCK_INDEX', 'BLOCK_HASH', 'LEDGER_HASH', 'ACTIONS_HASH',
    'CONTRACT_HASH', 'CHECKPOINT_SEQ', 'SECTION_SNAPSHOT_BLOCK', 'STATE_ROOT',
    'STATE_ROOT_VERSION', 'BLOCK_MERKLE_ROOT', 'BLOCK_MERKLE_VERSION', 'SIG_COUNT'
];
const SECTION_FIXED_FIELDS = SECTION_FIELDS.length;

function token(fields, index, name){
    // Require every structural field to exist and contain data.
    if(fields[index] === undefined || fields[index] === '')
        throw new Error('ANCHOR v3 missing ' + name);
    return fields[index];
}

function integer(fields, index, name){
    const value = token(fields, index, name);
    // Accept only canonical non-negative integers within the safe range.
    if(!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error('ANCHOR v3 invalid ' + name);
    return Number(value);
}

function signaturePairs(fields, start, count, name){
    // Keep the declared pair count inside the available wire fields.
    if(start + (count * 2) > fields.length)
        throw new Error('ANCHOR v3 ' + name + ' exceeds the wire');
    const pairs = [];
    for(let i = 0; i < count; i++){
        pairs.push({
            pubkey: token(fields, start + (i * 2), name + ' PUBKEY'),
            sig: token(fields, start + (i * 2) + 1, name + ' SIG')
        });
    }
    return pairs;
}

function sectionValues(fields, start, sectionIndex){
    return SECTION_FIELDS.map((name, offset) =>
        token(fields, start + offset, 'section ' + sectionIndex + ' ' + name));
}

function readSection(fields, start, sectionIndex, sectionsLeft){
    const value = sectionValues(fields, start, sectionIndex);
    const sigCount = integer(fields, start + 12, 'section ' + sectionIndex + ' SIG_COUNT');
    const sigStart = start + SECTION_FIXED_FIELDS;
    const minimumFieldsLeft = (sectionsLeft * SECTION_FIXED_FIELDS) + 3;
    // Reserve the minimum fields needed by later sections and the tail.
    if(sigStart + (sigCount * 2) + minimumFieldsLeft > fields.length)
        throw new Error('ANCHOR v3 section ' + sectionIndex + ' SIG_COUNT exceeds the wire');
    return {
        section: {
            chain: value[0], block_index: integer(fields, start + 1, 'section ' + sectionIndex + ' BLOCK_INDEX'),
            block_hash: value[2], ledger_hash: value[3], actions_hash: value[4], contract_hash: value[5],
            checkpoint_seq: integer(fields, start + 6, 'section ' + sectionIndex + ' CHECKPOINT_SEQ'),
            section_snapshot_block: integer(fields, start + 7, 'section ' + sectionIndex + ' SECTION_SNAPSHOT_BLOCK'),
            state_root: value[8], state_root_version: integer(fields, start + 9, 'section ' + sectionIndex + ' STATE_ROOT_VERSION'),
            block_merkle_root: value[10], block_merkle_version: integer(fields, start + 11, 'section ' + sectionIndex + ' BLOCK_MERKLE_VERSION'),
            sigs: signaturePairs(fields, sigStart, sigCount, 'section ' + sectionIndex + ' SIG_COUNT')
        },
        next: sigStart + (sigCount * 2)
    };
}

function readArchive(fields, start, sectionCount){
    const archiveCount = integer(fields, start, 'ARCHIVE_COUNT');
    // Limit folded wires to the zero-or-one archive grammar.
    if(archiveCount > 1) throw new Error('ANCHOR v3 invalid ARCHIVE_COUNT');
    if(archiveCount === 0) return { archiveCount, archive: null, next: start + 1 };

    const wrapperSectionIndex = integer(fields, start + 1, 'WRAPPER_SECTION_INDEX');
    // Bind an archive only to a section carried by this wire.
    if(wrapperSectionIndex >= sectionCount)
        throw new Error('ANCHOR v3 invalid WRAPPER_SECTION_INDEX');
    return {
        archiveCount,
        archive: {
            wrapperSectionIndex,
            matchBatchSeq: integer(fields, start + 2, 'MATCH_BATCH_SEQ'),
            matchCount: integer(fields, start + 3, 'MATCH_COUNT'),
            batchCrc32: token(fields, start + 4, 'BATCH_CRC32'),
            totalChunks: integer(fields, start + 5, 'TOTAL_CHUNKS'),
            archiveB64: token(fields, start + 6, 'ARCHIVE_B64')
        },
        next: start + 7
    };
}

function readTail(fields, start){
    const publisher = token(fields, start, 'PUBLISHER');
    const attestSigCount = integer(fields, start + 1, 'ATTEST_SIG_COUNT');
    const pairStart = start + 2;
    const attestSigs = signaturePairs(fields, pairStart, attestSigCount, 'ATTEST_SIG_COUNT');
    // Match the declared attestation count to the exact remaining wire.
    if(pairStart + (attestSigCount * 2) !== fields.length)
        throw new Error('ANCHOR v3 ATTEST_SIG_COUNT is inconsistent with the wire');
    return { publisher, attestSigs };
}

function parseAnchorV3(payload){
    // Ignore values that cannot carry an action wire.
    if(typeof payload !== 'string') return null;
    const fields = payload.split(PIPE);
    // Select only the exact action and version this reader owns.
    if(fields[0] !== 'ANCHOR' || fields[1] !== '3') return null;

    const network = token(fields, 2, 'NETWORK');
    const snapshotBlock = integer(fields, 3, 'SNAPSHOT_BLOCK');
    const sectionCount = integer(fields, 4, 'SECTION_COUNT');
    const sections = [];
    let next = 5;
    for(let i = 0; i < sectionCount; i++){
        const parsed = readSection(fields, next, i, sectionCount - i - 1);
        sections.push(parsed.section);
        next = parsed.next;
    }
    const archivePart = readArchive(fields, next, sectionCount);
    const tail = readTail(fields, archivePart.next);
    return {
        network, snapshotBlock, sections,
        archiveCount: archivePart.archiveCount, archive: archivePart.archive,
        publisher: tail.publisher, attestSigs: tail.attestSigs
    };
}

module.exports = { parseAnchorV3 };
