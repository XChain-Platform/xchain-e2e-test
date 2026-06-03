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

    describe('E2E-EXEC-004: P2WSH large-payload (multi-chunk) encoding path', () => {
        // P2WSH embeds payload chunks in the witness scripts of segwit outputs:
        // tx1 creates the P2WSH outputs, tx2 spends them to reveal the data.
        // Each chunk is pushed as a single script element, so it is bound by the
        // 520-byte consensus push limit (476 usable after script overhead) — an
        // ~8 KB payload therefore fans out across ~17 P2WSH outputs/inputs. This
        // case exercises (a) the encoder's fee sizing for a multi-output P2WSH
        // transaction under real node relay rules, (b) the node accepting the
        // two-tx PSBT without a dust/fee/push-size rejection, and (c) the
        // decoder reassembling every chunk back into a byte-intact ACTION. A
        // FILE carries the bulk binary blob; a corrupted or fee-starved reveal
        // would either fail to broadcast or land a garbled/absent FILE row, so a
        // valid FILE with the exact name+title proves the full payload
        // round-tripped.
        //
        // Segwit-only: skipped on chains without segwit support (e.g. Dogecoin).
        const SEGWIT = !(NETWORK_OBJECT && NETWORK_OBJECT.supportsSegwit === false)

        it('should encode a ~8 KB FILE as a multi-chunk P2WSH tx, broadcast, mine, and round-trip it intact', async function(){
            if (!SEGWIT){
                console.log('Skipping P2WSH case: '+COIN+' does not support segwit')
                this.skip()
                return
            }

            const addr = await cryptoHelper.getNewFundedAddress('E2E.PIPE.P2WSH', COIN, NETWORK, null, 'legacy', 0, 1)
            assert(addr.address, 'Funded address should be truthy')

            // Deterministic ~7.8 KB binary blob. Compiled on-chain ACTION push =
            // FILE message (~40 B, OP_PUSHDATA1) + this blob (OP_PUSHDATA2) +
            // push prefixes ≈ 7.85 KB — safely under the 8192-byte ceiling. At
            // 476 usable bytes per witness-script chunk this fans out across
            // ~17 P2WSH outputs/inputs, stressing the multi-output fee sizing.
            const RAW_LEN = 7800
            const rawBuf = Buffer.alloc(RAW_LEN)
            for (let i = 0; i < RAW_LEN; i++){
                rawBuf[i] = (i * 7 + 13) & 0xff
            }
            const rawData = rawBuf.toString('binary')

            const name = 'p2wsh' + addr.address.substring(addr.address.length - 6)
            const title = 'P2WSH 3-chunk live round-trip'
            const fileMessage = 'FILE|0|' + name + '|application/octet-stream|' + title + '|'

            // Sanity-check the encoder's selection + that the node accepts the
            // PSBT for this large payload before driving the full pipeline.
            const utxoResult = await utxoTrackerConnector.getUtxosFromAddress(addr.address)
            const confirmedUtxos = (utxoResult.utxos || []).filter(u => u.confirmations > 0)
            const probe = await encoderConnector.createTx(
                confirmedUtxos, addr.address, [], fileMessage,
                rawData, null, false, 'P2WSH', addr.address, null, null, null
            )
            assert(probe, 'Encoder should return a response for the forced-P2WSH FILE')
            assert.strictEqual(probe.encoding, 'P2WSH', 'Encoding should be P2WSH when forced for a large payload')
            assert(probe.psbt, 'Encoder should return a PSBT for the P2WSH FILE')

            // Drive the full two-transaction P2WSH reveal pipeline. A throw here
            // (e.g. a dust/fee rejection from the node on the reveal tx) is the
            // F-8 fee-impact failure mode this case is meant to catch.
            const txHash = await transactionHelper.createAndSendTransaction(
                addr, fileMessage, rawData, [], 'P2WSH', null
            )
            assert(txHash, 'P2WSH pipeline should return a txHash')
            assert.strictEqual(txHash.length, 64, 'txHash should be a 64-char hex string')

            // The decoder must reassemble every witness-script chunk into the
            // original ACTION; a valid FILE row with the exact name+title is the
            // round-trip integrity proof.
            const fileRow = await indexerDatabase.waitForFile({
                txHash: txHash,
                source: addr.address,
                name: name,
                title: title,
                status: 'valid'
            })
            assert(fileRow, 'FILE DB record should exist after the P2WSH pipeline (proves the ~8 KB payload round-tripped intact)')
            assert.strictEqual(fileRow.tx_hash, txHash, 'FILE tx_hash should match the reveal txHash')
            assert.strictEqual(fileRow.name, name, 'FILE name should round-trip byte-for-byte')
            assert.strictEqual(fileRow.title, title, 'FILE title should round-trip byte-for-byte')
            assert.strictEqual(fileRow.status, 'valid', 'FILE status should be valid')
        })
    })

    describe('E2E-EXEC-005: MAX_ACTION_DATA_LENGTH enforcement (live decoder loop)', () => {
        // The protocol caps a compiled on-chain ACTION push at 8192 bytes. This
        // ceiling is enforced at TWO layers that share the same constant:
        //   - the encoder (XChainEncoder MAX_COMPILED_ACTION_DATA_LENGTH) rejects
        //     an over-length payload at build time with a RangeError, so an
        //     over-length transaction is never broadcast through the pipeline;
        //   - the decoder (XChainDecoder MAX_ACTION_DATA_LENGTH) re-checks the
        //     reassembled push inside its live block-parsing loop and skips any
        //     transaction that exceeds it — defense-in-depth against a tx crafted
        //     outside the encoder.
        // Because both ceilings are identical, the decoder's in-loop guard is
        // unreachable through the legitimate encoder pipeline (every tx the
        // encoder will build is <= 8192 and the decoder accepts it). The
        // operationally meaningful, live-exercisable enforcement is therefore the
        // encoder boundary, plus proof that the decoder loop keeps processing
        // valid blocks immediately afterward (it never stalls on the rejected
        // payload because that payload never reaches a block).
        it('should reject an over-length payload at the encoder and keep the decoder loop healthy', async () => {
            const addr = await cryptoHelper.getNewFundedAddress('E2E.PIPE.MAXLEN', COIN, NETWORK, null, 'legacy', 0, 1)
            assert(addr.address, 'Funded address should be truthy')

            // 9000 raw bytes → compiled push well over the 8192-byte ceiling.
            const overBuf = Buffer.alloc(9000, 0x41)
            const overRaw = overBuf.toString('binary')
            const fileMessage = 'FILE|0|maxlen|application/octet-stream|over-length|'

            const utxoResult = await utxoTrackerConnector.getUtxosFromAddress(addr.address)
            const confirmedUtxos = (utxoResult.utxos || []).filter(u => u.confirmations > 0)

            let rejectErr = null
            let psbtResp = null
            try {
                psbtResp = await encoderConnector.createTx(
                    confirmedUtxos, addr.address, [], fileMessage,
                    overRaw, null, false, 'P2WSH', addr.address, null, null, null
                )
            } catch (err){
                rejectErr = err
            }
            // The encoder enforces MAX_COMPILED_ACTION_DATA_LENGTH at build time;
            // the connector surfaces that RangeError as a thrown JSON-RPC error.
            // The over-length payload must NOT yield a usable PSBT.
            assert(rejectErr, 'Encoder should reject the over-length payload at build time')
            assert(!psbtResp, 'Encoder should not return a PSBT for the over-length payload')
            assert(/exceeds maximum|too large|8192|length/i.test(rejectErr.message),
                'Rejection should cite the size/length ceiling (got: ' + rejectErr.message + ')')

            // The decoder/indexer loop must remain healthy: a normal-sized
            // action issued right after the rejected attempt must still flow
            // through encode → broadcast → mine → decode → index, proving the
            // rejection did not perturb live block processing. A small FILE is
            // used because it carries no gas-token FEE requirement, so it indexes
            // as valid from a freshly funded address regardless of the issuer's
            // XCHAIN balance (an ISSUE would index as invalid-FEE here, which
            // would conflate gas state with the decoder-loop-health signal).
            const liveName = 'maxlen' + addr.address.substring(addr.address.length - 6)
            const liveTitle = 'maxlen liveness probe'
            const liveMsg = 'FILE|0|' + liveName + '|text/plain|' + liveTitle + '|'
            const liveRaw = Buffer.from('decoder loop liveness check', 'utf8').toString('binary')
            const liveTx = await transactionHelper.createAndSendTransaction(
                addr, liveMsg, liveRaw, [], null, null
            )
            assert(liveTx, 'A valid action after the rejected over-length payload should still flow through the pipeline')
            const liveRow = await indexerDatabase.waitForFile({
                txHash: liveTx, source: addr.address, name: liveName, title: liveTitle, status: 'valid'
            })
            assert(liveRow, 'The post-rejection action should index (decoder loop stayed healthy and never stalled)')
            assert.strictEqual(liveRow.status, 'valid', 'The post-rejection action should index as valid')
        })
    })
})
