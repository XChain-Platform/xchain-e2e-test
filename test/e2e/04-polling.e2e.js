const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')

// MANUAL VERIFICATION REQUIRED:
// E2E-POLL-002 (stuck indexer): Pause the indexer container during a test run,
// verify waitForIssue times out and the test reports failure correctly

describe('E2E: Polling & UTXO Tracker Reliability', () => {
    describe('E2E-POLL-001: Database polling under real pipeline latency', () => {
        it('should observe real pipeline latency when polling for an indexed record', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.POLL.LAT', COIN, NETWORK, null, 'legacy', 0, 1)
            const tick = 'E2EPOLL' + addr.address.substring(addr.address.length - 7)
            const message = 'ISSUE|0|' + tick + '|100|10|0|poll latency test|10||||||||||||||||'

            // Broadcast the transaction
            const txHash = await transactionHelper.createAndSendTransaction(addr, message)
            assert(txHash, 'Transaction should be broadcast successfully')

            // Poll with timing instrumentation
            const pollStart = Date.now()
            const issueRow = await indexerDatabase.waitForIssue({
                txHash: txHash,
                tick: tick,
                status: 'valid'
            }, 60000)
            const pollDuration = Date.now() - pollStart

            assert(issueRow, 'Issue record should eventually appear in the indexer DB')
            assert.strictEqual(issueRow.tx_hash, txHash, 'Issue tx_hash should match broadcast txHash')
            assert.strictEqual(issueRow.status, 'valid', 'Issue status should be valid')
            assert(pollDuration < 60000, 'Polling should complete before timeout')

            console.log('E2E-POLL-001: indexer pipeline latency = ' + pollDuration + ' ms')
        })

        it('should return null from waitForIssue when the record never exists (short timeout)', async () => {
            const fakeTick = 'NVREXST' + Date.now().toString().slice(-7)

            const pollStart = Date.now()
            const result = await indexerDatabase.waitForIssue({
                tick: fakeTick,
                status: 'valid'
            }, 3000)
            const pollDuration = Date.now() - pollStart

            assert.strictEqual(result, null, 'waitForIssue should return null for non-existent tick')
            assert(pollDuration >= 2500, 'Polling should run close to timeMax before returning null')
            assert(pollDuration < 10000, 'Polling should not run significantly over timeMax')
        })
    })

    describe('E2E-POLL-003: UTXO tracker synchronization accuracy', () => {
        it('should return UTXOs whose txid exists on the blockchain node', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.UTXO.SYNC', COIN, NETWORK, null, 'legacy', 0, 1)

            const utxoResult = await utxoTrackerConnector.getUtxosFromAddress(addr.address)
            assert(utxoResult.utxos, 'UTXO result should have utxos array')
            assert(Array.isArray(utxoResult.utxos), 'utxos should be an array')
            assert(utxoResult.utxos.length > 0, 'Should have at least one UTXO for funded address')

            const trackerUtxo = utxoResult.utxos.find(u => u.confirmations > 0)
            assert(trackerUtxo, 'Should have at least one confirmed UTXO')

            // Verify data shape
            assert(typeof trackerUtxo.txid === 'string' && trackerUtxo.txid.length === 64,
                'UTXO txid should be a 64-char hex string')
            assert(typeof trackerUtxo.vout === 'number', 'UTXO vout should be a number')
            assert(trackerUtxo.scriptPubKey && trackerUtxo.scriptPubKey.length > 0,
                'UTXO scriptPubKey should be a non-empty string')
            assert(trackerUtxo.confirmations > 0, 'UTXO confirmations should be > 0')

            // Cross-verify with the blockchain node: the txid should exist on chain
            const rawTxHex = await nodeConnector.getTransactionHex(trackerUtxo.txid)
            assert(rawTxHex, 'The UTXO txid should exist on the blockchain node')
            assert(typeof rawTxHex === 'string' && rawTxHex.length > 0,
                'Node should return non-empty raw transaction hex')
        })

        it('should confirm that waitForUtxos returns true after funding a new address', async () => {
            const addr = await cryptoHelper.getNewAddress('E2E.UTXO.WAIT', COIN, NETWORK, null, 'legacy', 0)

            // Fund the address
            const txId = await regtestMinerConnector.sendFunds(addr.address, 1)
            assert(txId, 'sendFunds should return a transaction ID')

            // Confirm the tx is mined
            const txExists = await nodeConnector.waitForTx(txId, 60000)
            assert(txExists, 'Funded transaction should appear in the blockchain')

            // Poll the UTXO tracker
            const waitStart = Date.now()
            const didAppear = await utxoTrackerConnector.waitForUtxos(addr.address, 60000)
            const waitDuration = Date.now() - waitStart

            assert(didAppear, 'waitForUtxos should return true after funding')
            assert(waitDuration < 60000, 'UTXO should appear before timeout')
            console.log('E2E-POLL-003: UTXO tracker sync latency = ' + waitDuration + ' ms')

            // Verify the funded txid appears in the UTXO set
            const utxoSet = await utxoTrackerConnector.getUtxosFromAddress(addr.address)
            const matchingUtxo = utxoSet.utxos.find(u => u.txid === txId)
            assert(matchingUtxo, 'The miner funding txid should appear in the UTXO tracker data')
        })
    })
})
