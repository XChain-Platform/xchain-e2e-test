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
//   1. control: MINT XCHAIN to B's FULL address -> valid + B credited (also
//      indexes B so it gets an index id N).
//   2. FIX:     MINT XCHAIN to ^N -> valid, and the credit lands on the
//      RESOLVED address B (checkMint/checkCredit join index_addresses by id,
//      so a match on B.address proves ^N resolved to B).
//   3. dangling ^<id> with no row -> invalid: DESTINATION (format) (the fix
//      leaves a non-resolvable ref unchanged so the format check rejects it;
//      no silent drop).
//
// Run: ~/action-run-btc.sh test/actions/compactionFixLive.test.js

const assert            = require('assert')
const cryptoHelper      = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')

const COIN    = global.COIN    || process.env.COIN    || 'bitcoin'
const NETWORK = global.NETWORK || process.env.NETWORK || 'regtest'
const GAS     = 'XCHAIN'

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

describe('[live] indexer ^<id> address resolution fix (resolveAddressRef)', function () {
    this.timeout(0)

    let src, dest, destId

    before(async function () {
        // Funded source (native + seeded gas). Fresh dest address (no funding
        // needed; it gets indexed the moment it receives the control MINT).
        src  = await cryptoHelper.getNewFundedAddress('COMPACTFIX.SRC', COIN, NETWORK, null, 'legacy', 0, 1)
        dest = await cryptoHelper.getNewAddress('COMPACTFIX.DEST', COIN, NETWORK, null, 'legacy', 1)
        console.log('    [live] src=' + src.address + ' dest=' + dest.address)
    })

    it('control: MINT XCHAIN to the FULL destination address is valid and credits it (indexes dest)', async function () {
        const msg = 'MINT|0|' + GAS + '|7|' + dest.address + '|'
        const txHash = await transactionHelper.createAndSendTransaction(src, msg)
        try { await global.regtestMinerConnector.generateBlocks(1) } catch (e) {}

        const mint = await global.indexerDatabase.waitForMint({ txHash, tick: GAS, destination: dest.address, status: 'valid' })
        assert.ok(mint, 'control MINT should be indexed valid with destination=dest')
        const credit = await global.indexerDatabase.waitForCredit({ txHash, tick: GAS, address: dest.address })
        assert.ok(credit, 'control MINT should credit dest')

        destId = await addressId(dest.address)
        console.log('    [live] dest index id N=' + destId)
        assert.ok(destId && /^[0-9]+$/.test(destId), 'dest must now have a numeric index id')
    })

    it('FIX: MINT XCHAIN to ^N is valid and the credit lands on the RESOLVED address (dest)', async function () {
        const ref = '^' + destId
        const msg = 'MINT|0|' + GAS + '|11|' + ref + '|'
        console.log('    [live] minting to compacted ref ' + ref)
        const txHash = await transactionHelper.createAndSendTransaction(src, msg)
        try { await global.regtestMinerConnector.generateBlocks(1) } catch (e) {}

        // destination joins index_addresses by the stored id; a match on dest.address
        // proves ^N resolved to dest (pre-fix this row would be invalid format).
        const mint = await global.indexerDatabase.waitForMint({ txHash, tick: GAS, destination: dest.address, status: 'valid' })
        assert.ok(mint, '^N MINT must be indexed VALID with destination resolved to dest (the fix)')

        const credit = await global.indexerDatabase.waitForCredit({ txHash, tick: GAS, address: dest.address })
        assert.ok(credit, 'the ^N MINT credit must land on the resolved address dest')
        console.log('    [live] ^N resolved + credited dest, amount=' + (credit.amount))
    })

    it('dangling ^<id> (no such row) is rejected as invalid format (no silent drop)', async function () {
        const msg = 'MINT|0|' + GAS + '|3|^999999999|'
        const txHash = await transactionHelper.createAndSendTransaction(src, msg)
        try { await global.regtestMinerConnector.generateBlocks(1) } catch (e) {}

        // Poll the action status directly until the tx is indexed.
        let status = null
        for (let i = 0; i < 60 && status == null; i++) {
            status = await mintStatus(txHash)
            if (status == null) await new Promise(r => setTimeout(r, 1000))
        }
        console.log('    [live] dangling-ref MINT status=' + status)
        assert.ok(status && /^invalid/.test(status), 'dangling ^<id> MINT must be invalid, got: ' + status)
    })
})
