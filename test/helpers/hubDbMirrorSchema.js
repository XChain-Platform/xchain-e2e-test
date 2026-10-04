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

const fs = require('fs')
const path = require('path')

const MIRROR_SQL = Object.freeze({
    price_snapshots: '../../../xchain-hub/src/sql/price_snapshots.sql',
    oracle_prices: '../../../xchain-hub/src/sql/oracle_prices.sql',
    cross_chain_calls: '../../../xchain-indexer/src/sql/cross_chain_calls.sql',
    cross_chain_matches: '../../../xchain-indexer/src/sql/cross_chain_matches.sql',
    capability_snapshots: '../../../xchain-indexer/src/sql/capability_snapshots.sql',
    bridge_transfers: '../../../xchain-indexer/src/sql/bridge_transfers.sql',
    policy_snapshots: '../../../xchain-indexer/src/sql/policy_snapshots.sql',
    list_snapshots: '../../../xchain-indexer/src/sql/list_snapshots.sql',
    state_checkpoints: '../../../xchain-indexer/src/sql/state_checkpoints.sql',
    anchor_reward_attestations: '../../../xchain-indexer/src/sql/anchor_reward_attestations.sql',
    attestation_responses: '../../../xchain-indexer/src/sql/attestation_responses.sql'
})

function readDDL(rel){
    let sql = fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
    sql = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '')
    return sql.trim().replace(/;\s*$/, '')
}

module.exports = { MIRROR_SQL, readDDL }
