'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Protocol size-limit drift guard
//
// Several services independently declare the same protocol-level size caps.
// They have drifted before: most notably the ACTION data cap, where the
// encoder accepted compiled payloads the decoder silently dropped (an 8190–8192
// byte payload compiles to an 8193–8195 byte on-chain push, which the encoder
// once permitted but the decoder always dropped). These tests assert every
// service's local copy matches the canonical protocol constant, so the limits
// can never silently diverge again.

describe('Protocol size-limit drift guard', () => {

    require('./protocol-size-limits.regression/action_data_cap.test')
    require('./protocol-size-limits.regression/contract_code_size_cap.test')
    require('./protocol-size-limits.regression/fiat_code_and_gas_tick.test')
    require('./protocol-size-limits.regression/oracle_federation_bounds.test')
    require('./protocol-size-limits.regression/xcall_indexer_and_hub_bounds.test')
    require('./protocol-size-limits.regression/xcall_return_bytes_and_vm_bounds.test')
    require('./protocol-size-limits.regression/vm_call_depth_bounds.test')
    require('./protocol-size-limits.regression/chunked_deploy_caps.test')
    require('./protocol-size-limits.regression/family_b_attest_threshold_ticker.test')
    require('./protocol-size-limits.regression/family_b_envelope_orphan_grace.test')
    require('./protocol-size-limits.regression/family_b_compression_price_max.test')
    require('./protocol-size-limits.regression/family_b_reorg_buffer.test')
    require('./protocol-size-limits.regression/family_b_anchor_maturity_batch_limit.test')
    require('./protocol-size-limits.regression/family_b_batch_weight_budget.test')
    require('./protocol-size-limits.regression/family_b_settle_xpolicy_rollcall.test')
    require('./protocol-size-limits.regression/family_b_rollcall_gates.test')
    require('./protocol-size-limits.regression/vendored_byte_identity.test')
})
