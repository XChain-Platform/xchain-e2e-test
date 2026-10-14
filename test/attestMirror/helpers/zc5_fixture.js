'use strict'

// Constants and contract source for zc5_flag_day.test.js. Pure move.

// A testnet request block: above the widening height (150780) and above the mirror
// height (151324), but below the zero-conf height (151800). These values pin one
// request's whole window inside that interval.
const T_REQ_BLOCK = 151400
const T_DEADLINE  = 151500
const TESTNET_ZERO_CONF_HEIGHT = 151800

// The regtest counterparts, where every request is above the zero-conf height because
// the map is armed at genesis. Present so every below-height assertion has an
// above-height twin that gives a DIFFERENT answer: an assertion whose expected value
// is the same on both sides of a flag day is not testing the flag day.
const R_REQ_BLOCK = 100
const R_DEADLINE  = 200

// The ledger roots a rollback must restore. `block_merkle_root` is deliberately NOT
// here: it is a property of the BLOCK, and the reorg replaces the block on purpose
// (see the header). It is still compared between the two nodes, where it must agree.
const LEDGER_ROOT_FIELDS = Object.freeze(['state_root', 'balances_root', 'stakes_root'])

const FIXED_BODY = '{"score":41,"meta":"zc5-flagday"}'

const POLL_MS   = 3000
const FORWARD_S = 3

const DEADLINE_BLOCKS = 80
const COMPETING_OVERSHOOT = 2
const TRACKER_UNDO_BLOCKS = 12

const CONTRACT_CODE = `
module.exports = {
    meta: { name: 'Zero Conf Flag Day Asker', description: 'Requests an attestation across the zero-conf flag day boundary.', version: '1.0.0' },
    ask: function(xchain) {
        var requestId = xchain.attestation.request(
            xchain.getInputParam(0),
            xchain.getInputParam(1),
            'handleResponse',
            ['ctx-zc5'],
            { redundancy: 3, deadlineBlocks: ${DEADLINE_BLOCKS} }
        );
        return requestId;
    },
    handleResponse: function(xchain) {
        xchain.state.set('callback_status',  xchain.getInputParam(2));
        xchain.state.set('callback_payload', xchain.getInputParam(3));
    }
};
`

module.exports = {
    T_REQ_BLOCK, T_DEADLINE, TESTNET_ZERO_CONF_HEIGHT, R_REQ_BLOCK, R_DEADLINE,
    LEDGER_ROOT_FIELDS, FIXED_BODY, POLL_MS, FORWARD_S, DEADLINE_BLOCKS,
    COMPETING_OVERSHOOT, TRACKER_UNDO_BLOCKS, CONTRACT_CODE,
}
