/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

// Live proof of the indexer ^<id> address-resolution fix (resolveAddressRef).
//
// Bypasses the SDK (the deployed SDK has no compaction and its validator would
// reject a ^<id> destination client-side). Builds the raw MINT wire string
// directly and broadcasts through the connector path, so a literal ^<id>
// reaches the live decode->index pipeline exactly as a compaction-enabled SDK
// would emit it.
//
// Proves on a live regtest chain:
//   1. control: MINT to B's FULL address -> valid + B credited (also
//      indexes B so it gets an index id N).
//   2. FIX:     MINT to ^N -> valid, and the credit lands on the
//      RESOLVED address B (checkMint/checkCredit join index_addresses by id,
//      so a match on B.address proves ^N resolved to B).
//   3. dangling ^<id> with no row -> invalid: DESTINATION (format) (the fix
//      leaves a non-resolvable ref unchanged so the format check rejects it;
//      no silent drop).
//
// The minted token is one the source ISSUEs in the before hook with open minting,
// not XCHAIN: off BTC XCHAIN exists only by bridging, so every MINT of it is invalid
// (MINT_START_BLOCK) whatever its destination, and case 3 would pass for the wrong
// reason. Case 3 therefore also pins that the rejection names the DESTINATION.
//
// Run: ~/action-run-btc.sh test/actions/compaction_fix_live.test.js

const assert            = require('assert')
const cryptoHelper      = require('../helpers/core/cryptoHelper')
const transactionHelper = require('../helpers/core/transactionHelper')
const issueHelper       = require('../helpers/issueHelper')

const COIN    = global.COIN    || process.env.COIN    || 'bitcoin'
const NETWORK = global.NETWORK || process.env.NETWORK || 'regtest'

async function addressId(address){
    const conn = await global.indexerDatabase.pool.getConnection()
    try {
        const rows = await conn.query('SELECT id FROM index_addresses WHERE address=? LIMIT 1', [address])
        return rows.length ? String(rows[0].id) : null
    } finally { conn.release() }
}

async function mintStatus(txHash){
    // Read the MINT action status directly, independent of checkMint matching.
    const conn = await global.indexerDatabase.pool.getConnection()
    try {
        const rows = await conn.query(
            `SELECT ist.status AS status
               FROM mints m
               LEFT JOIN actions act ON act.action_index = m.action_index
               LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
               LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
               LEFT JOIN index_statuses ist ON ist.id = m.status_id
              WHERE itx.hash = ? LIMIT 1`, [txHash])
        return rows.length ? rows[0].status : null
    } finally { conn.release() }
}

// Scenario state shared by the steps below (set up in the before hook).
const st = { src: null, dest: null, destId: null, tick: null }

// Funded source (native + seeded gas). Fresh dest address (no funding
// needed; it gets indexed the moment it receives the control MINT).
async function setUpActors() {
    st.src  = await cryptoHelper.getNewFundedAddress('COMPACTFIX.SRC', COIN, NETWORK, null, 'legacy', 0, 1)
    st.dest = await cryptoHelper.getNewAddress('COMPACTFIX.DEST', COIN, NETWORK, null, 'legacy', 1)
    // Open minting, no MINT_SUPPLY: only the MINTs below ever credit it.
    st.tick = 'CFX' + st.src.address.substring(st.src.address.length - 8).toUpperCase().replace(/[^A-Z0-9]/g, 'X')
    await issueHelper.sendIssueV0(st.src, st.tick, 1000000, 1000, 0, 'compaction fix drill token', 0)
    console.log('    [live] src=' + st.src.address + ' dest=' + st.dest.address)
}

// Broadcast a raw MINT wire string from the source and mine it.
async function broadcastMint(msg) {
    // stake-teardown-ok: raw MINT wire string, never a STAKE
    const txHash = await transactionHelper.createAndSendTransaction(st.src, msg)
    try { await global.regtestMinerConnector.generateBlocks(1) } catch (e) { void e }
    return txHash
}

async function controlMintToFullAddress() {
    const txHash = await broadcastMint('MINT|0|' + st.tick + '|7|' + st.dest.address + '|')

    const mint = await global.indexerDatabase.waitForMint({ txHash, tick: st.tick, destination: st.dest.address, status: 'valid' })
    assert.ok(mint, 'control MINT should be indexed valid with destination=dest')
    const credit = await global.indexerDatabase.waitForCredit({ txHash, tick: st.tick, address: st.dest.address })
    assert.ok(credit, 'control MINT should credit dest')

    st.destId = await addressId(st.dest.address)
    console.log('    [live] dest index id N=' + st.destId)
    assert.ok(st.destId && /^[0-9]+$/.test(st.destId), 'dest must now have a numeric index id')
}

async function mintToCompactedRef() {
    const ref = '^' + st.destId
    console.log('    [live] minting to compacted ref ' + ref)
    const txHash = await broadcastMint('MINT|0|' + st.tick + '|11|' + ref + '|')

    // destination joins index_addresses by the stored id; a match on dest.address
    // proves ^N resolved to dest (pre-fix this row would be invalid format).
    const mint = await global.indexerDatabase.waitForMint({ txHash, tick: st.tick, destination: st.dest.address, status: 'valid' })
    assert.ok(mint, '^N MINT must be indexed VALID with destination resolved to dest (the fix)')

    const credit = await global.indexerDatabase.waitForCredit({ txHash, tick: st.tick, address: st.dest.address })
    assert.ok(credit, 'the ^N MINT credit must land on the resolved address dest')
    console.log('    [live] ^N resolved + credited dest, amount=' + (credit.amount))
}

async function danglingRefIsRejected() {
    const txHash = await broadcastMint('MINT|0|' + st.tick + '|3|^999999999|')

    // Poll the action status directly until the tx is indexed.
    let status = null
    for (let i = 0; i < 60 && status == null; i++) {
        status = await mintStatus(txHash)
        if (status == null) await new Promise(r => setTimeout(r, 1000))
    }
    console.log('    [live] dangling-ref MINT status=' + status)
    assert.ok(status && /^invalid/.test(status), 'dangling ^<id> MINT must be invalid, got: ' + status)
    assert.ok(/DESTINATION/.test(status), 'the dangling ^<id> MINT must be rejected for its DESTINATION, got: ' + status)
}

describe('[live] indexer ^<id> address resolution fix (resolveAddressRef)', function () {
    this.timeout(0)

    before(setUpActors)

    it('control: MINT to the FULL destination address is valid and credits it (indexes dest)', controlMintToFullAddress)

    it('FIX: MINT to ^N is valid and the credit lands on the RESOLVED address (dest)', mintToCompactedRef)

    it('dangling ^<id> (no such row) is rejected as invalid format (no silent drop)', danglingRefIsRejected)
})
