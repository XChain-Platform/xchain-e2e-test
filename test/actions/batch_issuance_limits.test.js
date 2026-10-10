// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//

// BATCH_ISSUANCE_LIMITS acceptance suite (spec acceptance tests A1-A6).
//
// Chain evidence for a consensus change, so every case here asserts the STATUS STRING
// the indexer wrote for a real transaction, not a shape or a count alone. The unit
// suites already pin the strings against synthetic input; the job of this file is to
// prove the same verdicts come out of a live indexer reading a real block.
//
// Which case runs where, and why. The lane question is NOT "does this stack have
// native fees" - a BTC regtest stack can have a FEE_DESTINATION configured and still
// accept an XCHAIN-balance deduction, because detectFeePaymentMode's gas fallback is
// keyed on the COIN, not on whether fees are enabled. So:
//   A6           needs GAS metering, which means sending the batch with NO output to
//                FEE_DESTINATION. That fallback exists on BTC (or on a stack with no
//                fee destination at all) and nowhere else, so it skips on LTC/DOGE.
//   A1           runs on both: in gas mode it reads the per-command schedule straight
//                off the ledger, and in native mode the same 51 commands draw on ONE
//                fee pool, which is the scale check on R5.
//   A2/A3        never reach a fee check (the batch dies in the limit scan, or the
//                ISSUE dies on its TICK), so they run on every lane.
//   A4/A5(fee)   need a resolvable FEE_DESTINATION so an exact-size fee output can be
//                attached. Runs wherever one exists.
//   A5(COINPAY)  runs everywhere; its batch suppresses the fee output so the only
//                transaction-level value in play is the payment itself.
//
// Fee sizing: the whole point of A4/A5 is an output carrying EXACTLY one command's
// worth of fee, and one child ISSUE's worth at the suite's standard fixture prices is
// 1000 satoshis - fine against BTC's 546 dust threshold, under LTC's 5460 and far
// under DOGE's 100000. So prepareFeeFixture() leaves the shared pair alone where it
// already sizes above dust and re-prices {COIN}/USD downward only where it does not,
// which scales every expected fee up by the same factor. XCHAIN/USD is never a free
// parameter (the seed guard pins it), and the shared fixture is restored afterwards.

const nativeFeeHelper = require('../helpers/nativeFeeHelper')
const { state } = require('./batch_issuance_limits/shared')
const registerIssuanceCases = require('./batch_issuance_limits/issuance')
const registerCommandCapCases = require('./batch_issuance_limits/command_caps')
const registerGasChildrenCases = require('./batch_issuance_limits/gas_children')
const registerCaretTickCases = require('./batch_issuance_limits/caret_ticks')
const registerNativeFeeCases = require('./batch_issuance_limits/native_fees')
const registerCoinpayCases = require('./batch_issuance_limits/coinpay')
const registerDispenserSinglePaymentCases = require('./batch_issuance_limits/dispenser_single_payment')
const registerDispenserBatchCreateCases = require('./batch_issuance_limits/dispenser_batch_creates')

async function discoverFeeMode() {
    const mode = await nativeFeeHelper.discoverFeeMode()
    state.FEE_DEST = mode.destination || null
    // detectFeePaymentMode (xchain-indexer/src/utility.js): a transaction carrying
    // NO output to FEE_DESTINATION falls back to an XCHAIN-balance deduction only
    // on BTC, or on a stack with no fee destination configured at all. Everywhere
    // else that transaction is rejected outright. So this, not "does the stack
    // have native fees", is what decides whether the gas-metered cases can run:
    // a regtest BTC stack can have BOTH modes wired at once, and this suite's
    // first run assumed it could not.
    state.GAS_MODE = (COIN_CODE === 'BTC') || !state.FEE_DEST
    console.log('lane: COIN=' + COIN_CODE + ' gasModeAvailable=' + state.GAS_MODE +
        ' feeDestination=' + (state.FEE_DEST ? 'resolved' : 'none'))
}

    // ─── A5 (DISPENSE half: spec frontier rows 18, 19, 20, 23 and 35) ──────────
    //
    // Two claims, both money-bearing, that unit tests alone do not prove on a chain.
    //
    //   ROW 23 - one payment funds ONE fill, with no batch anywhere in sight.
    //     findMatchingDispensers returns EVERY open dispenser sitting behind the paid
    //     address and the handler loops over all of them. Nothing decremented the
    //     payment between iterations, so each dispenser priced itself against the same
    //     untouched COIN_AMOUNT and bought a full multiplier off it. Anyone can open a
    //     second dispenser at an address they control, so that was a live double-spend
    //     on an ORDINARY transaction, and A5's "one payment settles one obligation,
    //     not N" had no chain evidence for the no-batch case. Closed on both trigger
    //     paths: a native-coin payment, and a token SEND routed through
    //     util.processDispenserSends.
    //
    //   ROW 35 - a dispenser created INSIDE a batch actually dispenses.
    //     The decoder's open-dispenser registry gated on the TOP-LEVEL action string,
    //     so `BATCH|0|DISPENSER|0|...` never entered the open set: payments to that
    //     address were never captured as dispenses and no DISPENSE could fire, while
    //     the indexer had registered the dispenser perfectly well. A decoder/indexer
    //     divergence, so this only means anything against a live pair of them.
    //
    // EVERY case below is a PAIR, for the same reason the COINPAY cases above are: a
    // single "exactly one fill happened" assertion cannot tell "the ledger stopped the
    // second draw" from "the second draw never happens at all", and this spec has
    // already been bitten by exactly that. So each fixture is paid twice, and the
    // second payment must reach the dispenser the first payment did NOT fund.
    //
    // FIXTURE SHAPE. Each dispenser escrows EXACTLY one fill (GIVE_ESCROW ==
    // GIVE_AMOUNT), which clamps its multiplier to 1 however large the payment is.
    // That is what makes attribution observable: a dispenser cannot absorb the whole
    // payment by dispensing more units, so the only thing that can stop a sibling
    // dispenser behind the same address is the value tally.
    //
    // LANE: every case runs everywhere. None attaches a hand-sized fee output and none
    // needs a FEE_DESTINATION, because a DISPENSER create carrying no EXPIRATION sits
    // inside the free window and is charged nothing, so the only transaction-level
    // value in play is the payment itself.
    //
    // BELOW THE FLAG is deliberately absent here. BATCH_ISSUANCE_LIMITS is
    // GENESIS-ACTIVE on regtest, so there is no below-flag block on this chain to send
    // a transaction into. The replay half - one payment still fills all N below the
    // flag, byte for byte - is pinned in
    // xchain-indexer/test/unit/db/markets/dispenser_value_accounting.test.js, which drives the
    // handler with the gate forced off. That is the honest boundary: these are
    // at-flag witnesses only.
function registerDispenserCases() {
    describe('A5: one payment fills ONE dispenser (rows 19/20/23) and a batched create dispenses (row 35)', function registerA5DispenserCases() {
        registerDispenserSinglePaymentCases()
        registerDispenserBatchCreateCases()
    })
}

function registerBatchIssuanceLimits() {
    before(discoverFeeMode)
    registerIssuanceCases()
    registerCommandCapCases()
    registerCaretTickCases()
    registerGasChildrenCases()
    registerNativeFeeCases()
    registerCoinpayCases()
    registerDispenserCases()
}

describe('BATCH issuance limits (BATCH_ISSUANCE_LIMITS)', registerBatchIssuanceLimits)
