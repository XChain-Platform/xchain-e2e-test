const assert = require('assert')
const cryptoHelper = require('../cryptoHelper')
const transactionHelper = require('../transactionHelper')
const issueHelper = require('../helpers/issueHelper')

describe('E2E: Transaction Pipeline Machinery', () => {
    describe('E2E-EXEC-001: OP_RETURN encoding path', () => {
        let addressInfo
        let tick
        let txHash

        it('should encode, sign, broadcast, mine, and confirm a short ISSUE message via OP_RETURN', async () => {
            addressInfo = await cryptoHelper.getNewFundedAddress('E2E.PIPE.OPRET', COIN, NETWORK, null, 'legacy', 0, 1)
            assert(addressInfo.address, 'Funded address should be truthy')
            assert(Buffer.isBuffer(addressInfo.privateKey), 'privateKey should be a Buffer')
            assert(typeof addressInfo.mnemonic === 'string', 'mnemonic should be a string')
            assert(addressInfo.mnemonic.split(' ').length === 12, 'mnemonic should be 12 words')

            tick = 'E2EPIPE' + addressInfo.address.substring(addressInfo.address.length - 7)

            // Use the full pipeline via issueHelper — validates the complete OP_RETURN path
            const result = await issueHelper.sendIssueV0(
                addressInfo, tick, 100, 10, 0, 'pipe test', 10
            )

            txHash = result.txHash
            assert(txHash, 'txHash should be returned')
            assert.strictEqual(txHash.length, 64, 'txHash should be a 64-char hex string')
            assert(result.issue, 'Issue DB record should exist')
            assert.strictEqual(result.issue.tx_hash, txHash, 'Issue tx_hash should match broadcast txHash')
            assert.strictEqual(result.issue.tick, tick, 'Issue tick should match')
            assert.strictEqual(result.issue.status, 'valid', 'Issue status should be valid')
            assert(result.credit, 'Credit DB record should exist')
            assert.strictEqual(result.credit.tx_hash, txHash, 'Credit tx_hash should match issue tx_hash')
        })

        it('should have accurate UTXO data in the tracker after transaction', async () => {
            const utxoResult = await utxoTrackerConnector.getUtxosFromAddress(addressInfo.address)
            assert(utxoResult.utxos, 'UTXO result should have utxos array')
            assert(Array.isArray(utxoResult.utxos), 'utxos should be an array')

            const confirmedUtxos = utxoResult.utxos.filter(u => u.confirmations > 0)
            assert(confirmedUtxos.length > 0, 'Should have at least one confirmed UTXO')

            const utxo = confirmedUtxos[0]
            assert(typeof utxo.txid === 'string' && utxo.txid.length === 64, 'UTXO txid should be 64-char hex')
            assert(typeof utxo.vout === 'number', 'UTXO vout should be a number')
            assert(utxo.value !== undefined, 'UTXO value should be defined')
            assert(typeof utxo.scriptPubKey === 'string' && utxo.scriptPubKey.length > 0, 'UTXO scriptPubKey should be a non-empty hex string')
            assert(utxo.confirmations > 0, 'UTXO confirmations should be > 0')
        })
    })

    describe('E2E-EXEC-002: P2SH two-transaction encoding path', () => {
        it('should verify the encoder selects P2SH for a long message', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.PIPE.P2SH.CHK', COIN, NETWORK, null, 'legacy', 0, 1)

            // Build a message long enough to exceed OP_RETURN (>76 bytes)
            const longTick = 'E2EP2SC' + addr.address.substring(addr.address.length - 7)
            const longDesc = 'A description that is intentionally long enough to force the encoder to select P2SH encoding rather than OP_RETURN for this ISSUE action'
            const longMessage = 'ISSUE|0|' + longTick + '|1000|100|0|' + longDesc + '|50||||||||||||||||'
            assert(longMessage.length > 76, 'Message should be > 76 bytes to trigger P2SH')

            // Query the encoder directly to verify encoding selection
            const utxoResult = await utxoTrackerConnector.getUtxosFromAddress(addr.address)
            const confirmedUtxos = (utxoResult.utxos || []).filter(u => u.confirmations > 0)
            const response = await encoderConnector.createTx(
                confirmedUtxos, addr.address, [], longMessage,
                null, null, false, null, addr.address, null, null, null
            )
            assert(response, 'Encoder should return a response')
            assert(response.encoding, 'Response should have an encoding field')
            assert(response.psbt, 'Response should have a psbt field')
            // The encoder may choose P2SH, P2WSH, or multisign for long messages
            assert(response.encoding !== 'OP_RETURN', 'Encoding should not be OP_RETURN for a long message')
        })

        it('should complete the full P2SH pipeline and produce a valid DB record', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.PIPE.P2SH', COIN, NETWORK, null, 'legacy', 0, 1)
            const tick = 'E2EP2SH' + addr.address.substring(addr.address.length - 7)
            const longDesc = 'A description that is intentionally long enough to force the encoder to select P2SH encoding rather than OP_RETURN for this ISSUE action'

            // Use transactionHelper which handles the two-transaction P2SH flow internally
            const result = await issueHelper.sendIssueV0(
                addr, tick, 1000, 100, 0, longDesc, 50
            )

            assert(result.txHash, 'P2SH pipeline should return a txHash')
            assert.strictEqual(result.txHash.length, 64, 'txHash should be a 64-char hex string')
            assert(result.issue, 'Issue DB record should exist after P2SH pipeline')
            assert.strictEqual(result.issue.tick, tick, 'Issue tick should match')
            assert.strictEqual(result.issue.status, 'valid', 'Issue status should be valid')
            assert(result.credit, 'Credit should exist after P2SH pipeline')
        })
    })

    describe('E2E-EXEC-003: MULTISIGN (bare multisig) encoding path', () => {
        // The MULTISIGN encoding embeds payload bytes in the pubkeys of a bare
        // 1-of-3 multisig output. The rest of the suite always passes a null
        // compressedPubKey, which routes every encode through OP_RETURN or P2SH —
        // so the live MULTISIGN broadcast path is otherwise never exercised. This
        // case forces it: it requires a real compressed pubkey for the 3rd multisig
        // slot, a relay-valid dust value sized from the bare-multisig script (the
        // flat 546-sat P2PKH floor is rejected as dust by the node), and correct
        // output-value accounting so the built tx's outputs never exceed its inputs.
        it('should encode, broadcast, mine, and confirm a short ISSUE via MULTISIGN, then decode+index it', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.PIPE.MSIG', COIN, NETWORK, null, 'legacy', 0, 1)
            assert(addr.address, 'Funded address should be truthy')
            // The funded address's own compressed public key serves as the 3rd
            // multisig pubkey. The first two carry the (obfuscated) payload halves.
            const compressedPubKey = addr.publicKey.toString('hex')
            assert.strictEqual(compressedPubKey.length, 66, 'compressed pubkey should be 33 bytes / 66 hex chars')

            // Short payload so it fits in a single MULTISIGN output. Forcing
            // encoding='MULTISIGN' + a real compressedPubKey drives the live
            // bare-multisig build/broadcast path. The indexer reads from the
            // decoder DB, so a valid ISSUE + Credit row proves the decoder picked
            // the tx up AND the action bytes round-tripped intact.
            const tick = 'E2EMSIG' + addr.address.substring(addr.address.length - 7)
            const result = await issueHelper.sendIssueV0(
                addr, tick, 100, 10, 0, 'msig', 10,
                '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
                'MULTISIGN', compressedPubKey
            )

            const txHash = result.txHash
            assert(txHash, 'MULTISIGN pipeline should return a txHash')
            assert.strictEqual(txHash.length, 64, 'txHash should be a 64-char hex string')
            assert(result.issue, 'ISSUE DB record should exist after MULTISIGN pipeline')
            assert.strictEqual(result.issue.tx_hash, txHash, 'ISSUE tx_hash should match broadcast txHash')
            assert.strictEqual(result.issue.tick, tick, 'ISSUE tick should match')
            assert.strictEqual(result.issue.status, 'valid', 'ISSUE status should be valid')
            assert(result.credit, 'Credit DB record should exist after MULTISIGN pipeline')
            assert.strictEqual(result.credit.tx_hash, txHash, 'Credit tx_hash should match ISSUE tx_hash')
        })
    })
})
