const assert = require('assert')
const protocol = require('../../../../../xchain-documentation/protocol/constants.js')

// Vendored protocol-constants identity guard. Services project the constants they
// consume through their local activation registries, so their source files are
// intentionally not byte-identical. Each service pins the exact export names its
// vendored module carries; the guard requires the vendored export names to equal
// that pin, every pinned name to still be a canonical export, and every vendored
// value to equal its canonical value.
const VENDORED_CONSTANTS_SERVICES = [
    'xchain-vm', 'xchain-indexer', 'xchain-sdk', 'xchain-decoder', 'xchain-explorer',
]

const VENDORED_CONSTANT_NAMES = {
    'xchain-vm': [
        'ANCHOR_REWARD_ACTIVATION', 'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_REWARD_ACTIVATION', 'ARCHIVE_REWARD_AMOUNT', 'ATTEST_MAX_EXPIRIES_PER_BLOCK',
        'CHECKPOINT_COMMITMENT_ACTIVATION', 'CROSS_CHAIN_ROYALTY_ACTIVATION', 'EQUIV_HEADER_ACTIVATION', 'GAS_TICK', 'MAX_ACTION_DATA_LENGTH',
        'MAX_CODE_SIZE', 'MAX_DEPLOYCHUNK_PART_BYTES', 'MAX_DEPLOY_CHUNKS', 'OP_RETURN_PUSH_OVERHEAD', 'ORACLE_DEVIATION_THRESHOLD',
        'PRICE_MAX', 'STAKE_WEIGHTED_QUORUM_ACTIVATION', 'STATE_COMMITMENT_ACTIVATION', 'THRESHOLD_SCALE', 'VALID_FIAT_CODES',
        'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS', 'XCALL_MAX_CALLS_PER_BLOCK', 'XCALL_MAX_DEADLINE_BLOCKS', 'XCALL_MAX_GAS',
        'XCALL_MAX_HOPS', 'XCALL_MAX_RETURN_BYTES', 'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MIN_GAS',
    ],
    'xchain-indexer': [
        'ANCHOR_REWARD_ACTIVATION', 'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_REWARD_ACTIVATION', 'ARCHIVE_REWARD_AMOUNT', 'ATTEST_MAX_EXPIRIES_PER_BLOCK',
        'CHECKPOINT_COMMITMENT_ACTIVATION', 'CROSS_CHAIN_ROYALTY_ACTIVATION', 'CROSS_SETTLE_MAX_PER_BLOCK', 'EQUIV_HEADER_ACTIVATION', 'GAS_TICK',
        'LIST_META_DESCRIPTION_MAX_BYTES', 'LIST_META_NAME_MAX_BYTES', 'LIST_SHARE_MAX_MEMBERS', 'LIST_UNION_MAX_MEMBERS', 'MAX_ACTION_DATA_LENGTH',
        'MAX_CODE_SIZE', 'MAX_DEPLOYCHUNK_PART_BYTES', 'MAX_DEPLOY_CHUNKS', 'OP_RETURN_PUSH_OVERHEAD', 'ORACLE_DEVIATION_THRESHOLD',
        'ORACLE_VM_MAX_ROWS', 'ORACLE_VM_ROUND_WINDOW', 'PRICE_MAX', 'STAKE_WEIGHTED_QUORUM_ACTIVATION', 'STATE_COMMITMENT_ACTIVATION',
        'THRESHOLD_SCALE', 'VALID_FIAT_CODES', 'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS', 'XBRIDGE_MAX_PER_BLOCK',
        'XCALL_MAX_CALLS_PER_BLOCK', 'XCALL_MAX_DEADLINE_BLOCKS', 'XCALL_MAX_GAS', 'XCALL_MAX_HOPS', 'XCALL_MAX_RETURN_BYTES',
        'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MIN_GAS', 'XCALL_RESULT_ORPHAN_GRACE_SECONDS', 'XPOLICY_MAX_MEMBERS', 'XPOLICY_MAX_PER_BLOCK',
    ],
    'xchain-sdk': [
        'ANCHOR_ACTIVATION', 'ANCHOR_REWARD_ACTIVATION', 'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_MATCH_COUNT_ACTIVATION', 'ARCHIVE_REWARD_ACTIVATION',
        'ARCHIVE_REWARD_AMOUNT', 'ATTEST_MAX_EXPIRIES_PER_BLOCK', 'CHECKPOINT_COMMITMENT_ACTIVATION', 'COMPRESSION_CODE_DEFLATE_RAW', 'COMPRESSION_MAX_INPUT_BYTES',
        'COMPRESSION_MAX_RATIO', 'CROSS_CHAIN_ROYALTY_ACTIVATION', 'ENVELOPE_MAX_PAYLOAD', 'EQUIV_HEADER_ACTIVATION', 'GAS_TICK',
        'MAX_ACTION_DATA_LENGTH', 'MAX_CODE_SIZE', 'MAX_DEPLOYCHUNK_PART_BYTES', 'MAX_DEPLOY_CHUNKS', 'OP_RETURN_PUSH_OVERHEAD',
        'ORACLE_DEVIATION_THRESHOLD', 'PRICE_MAX', 'STAKE_WEIGHTED_QUORUM_ACTIVATION', 'STATE_COMMITMENT_ACTIVATION', 'THRESHOLD_SCALE',
        'VALID_FIAT_CODES', 'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS', 'XCALL_MAX_CALLS_PER_BLOCK', 'XCALL_MAX_DEADLINE_BLOCKS',
        'XCALL_MAX_GAS', 'XCALL_MAX_HOPS', 'XCALL_MAX_RETURN_BYTES', 'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MIN_GAS',
    ],
    'xchain-decoder': [
        'ANCHOR_REWARD_ACTIVATION', 'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_REWARD_ACTIVATION', 'ARCHIVE_REWARD_AMOUNT', 'ATTEST_MAX_EXPIRIES_PER_BLOCK',
        'BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION', 'CHECKPOINT_COMMITMENT_ACTIVATION', 'CROSS_CHAIN_ROYALTY_ACTIVATION', 'DISPENSER_CANCEL_GRACE_ACTIVATION', 'DISPENSER_EXPIRY_REALIGN_ACTIVATION',
        'ENVELOPE_CARRIER_RECOGNITION_ACTIVATION', 'ENVELOPE_MAX_PAYLOAD', 'ENVELOPE_RECOGNITION_ACTIVATION', 'EQUIV_HEADER_ACTIVATION', 'GAS_TICK',
        'MAX_ACTION_DATA_LENGTH', 'MAX_CODE_SIZE', 'MAX_DEPLOYCHUNK_PART_BYTES', 'MAX_DEPLOY_CHUNKS', 'OP_RETURN_PUSH_OVERHEAD',
        'ORACLE_DEVIATION_THRESHOLD', 'ORACLE_FEE_OUTPUT_ACTIVATION', 'ORACLE_FEE_SET_CAPTURE_ACTIVATION', 'PRICE_MAX', 'STAKE_WEIGHTED_QUORUM_ACTIVATION',
        'STATE_COMMITMENT_ACTIVATION', 'THRESHOLD_SCALE', 'VALID_FIAT_CODES', 'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS',
        'XCALL_MAX_CALLS_PER_BLOCK', 'XCALL_MAX_DEADLINE_BLOCKS', 'XCALL_MAX_GAS', 'XCALL_MAX_HOPS', 'XCALL_MAX_RETURN_BYTES',
        'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MIN_GAS',
    ],
    'xchain-explorer': [
        'ANCHOR_ACTIVATION', 'ANCHOR_REWARD_ACTIVATION', 'ANCHOR_REWARD_AMOUNT', 'ARCHIVE_REWARD_ACTIVATION', 'ARCHIVE_REWARD_AMOUNT',
        'ATTEST_MAX_EXPIRIES_PER_BLOCK', 'CHECKPOINT_COMMITMENT_ACTIVATION', 'CROSS_CHAIN_ROYALTY_ACTIVATION', 'EQUIV_HEADER_ACTIVATION', 'GAS_TICK',
        'MAX_ACTION_DATA_LENGTH', 'MAX_CODE_SIZE', 'MAX_DEPLOYCHUNK_PART_BYTES', 'MAX_DEPLOY_CHUNKS', 'OP_RETURN_PUSH_OVERHEAD',
        'ORACLE_DEVIATION_THRESHOLD', 'PRICE_MAX', 'STAKE_WEIGHTED_QUORUM_ACTIVATION', 'STATE_COMMITMENT_ACTIVATION', 'THRESHOLD_SCALE',
        'VALID_FIAT_CODES', 'VM_MAX_CALL_DEPTH', 'VM_MIN_CALL_GAS', 'XCALL_MAX_CALLS_PER_BLOCK', 'XCALL_MAX_DEADLINE_BLOCKS',
        'XCALL_MAX_GAS', 'XCALL_MAX_HOPS', 'XCALL_MAX_RETURN_BYTES', 'XCALL_MIN_DEADLINE_BLOCKS', 'XCALL_MIN_GAS',
    ],
}

// The oracle VM retention bounds are indexer-only protocol constants. Their
// canonical declarations live in the indexer activation registry rather than the
// documentation module, so include those authoritative exports for that service.
const indexerGateRegistry = require('../../../../../xchain-indexer/src/consensus/gate_registry.js')
const CANONICAL_SERVICE_EXTENSIONS = {
    'xchain-indexer': {
        ORACLE_VM_ROUND_WINDOW: indexerGateRegistry.copy('protocol/constants.ORACLE_VM_ROUND_WINDOW'),
        ORACLE_VM_MAX_ROWS: indexerGateRegistry.copy('protocol/constants.ORACLE_VM_MAX_ROWS'),
    },
}

function canonicalExportsForService(service) {
    return Object.assign({}, protocol, CANONICAL_SERVICE_EXTENSIONS[service])
}

function assertFullVendoredExportIdentity(vendored, canonical, service, pinnedNames) {
    pinnedNames.forEach((name) => {
        assert.ok(Object.prototype.hasOwnProperty.call(canonical, name),
            service + ' pins ' + name + ', which the canonical constants no longer export')
    })
    assert.deepStrictEqual(Object.keys(vendored).sort(), pinnedNames.slice().sort(),
        service + ' vendored constant export names drifted from the pinned set')
    const expected = Object.fromEntries(pinnedNames.map((name) => [name, canonical[name]]))
    assert.deepStrictEqual(vendored, expected,
        service + ' vendored constant values drifted from canonical')
}

module.exports = {
    VENDORED_CONSTANTS_SERVICES, VENDORED_CONSTANT_NAMES, canonicalExportsForService, assertFullVendoredExportIdentity,
}
