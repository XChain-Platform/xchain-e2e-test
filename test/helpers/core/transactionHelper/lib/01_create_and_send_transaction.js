// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { isNoUtxosRefusal } = require('../../no_utxos_refusal')

// Verified confirmed UTXOs from the last tx wait loop, keyed by address.
// Passed directly to the encoder on the next call to bypass the tracker fetch,
// preventing stale mempool-db outputs from being picked up.
const transactionState = {
    verifiedUtxos: null,
    verifiedUtxosAddress: null
}

function internalIsStaleUtxoError(err){
    const msg = (err && err.message) || ''
    // NO_UTXOS (the encoder's -32010 reason, carried as rpcReason): the tracker had
    //   not yet indexed the change output from the source's previous tx. Keyed on the
    //   reason, not the wording or the generic -32603 "Internal encoder error", which
    //   every unrelated encoder fault also returns and which must fail the test.
    // `missingorspent`/`bad-txns-inputs`: node rejected because inputs were already spent.
    // `Missing inputs`: bitcoin/dogecoin's bare RPC error -25 message for the same condition
    //   (kept as a distinct pattern because the JSON-RPC layer can deliver either form).
    return isNoUtxosRefusal(err) || /missingorspent|missing\s*or\s*spent|missing\s+inputs|bad-txns-inputs/i.test(msg)
}

module.exports = {
    transactionState,

    // Wrap the build+sign+broadcast in a small retry loop. The encoder may pull
    // UTXOs from the utxo-tracker during an indexing-lag window, build a tx that
    // references inputs the bitcoind has already spent, and broadcast would die
    // with `bad-txns-inputs-missingorspent`. Drop the cache and wait briefly so
    // the tracker can catch up, then rebuild from scratch.
    // `opts` (all optional):
    //   compress  tri-state passed straight through to the encoder (null = its default)
    //   capture   an object this helper fills in with the encoder's build metadata
    //             (encoding, compression report, envelope recovery record, commit and
    //             reveal txids). Tests that assert on HOW the action was carried need
    //             it, because the return value is only ever the action's txid.
    async createAndSendTransaction(addressInfo, data, rawData = null, customOutputs = [], outputType = null, compressedPubKey = null, skipNativeFeeInjection = false, opts = {}){
        // Native-coin fee injection for LTC/DOGE (no-op on BTC). The general
        // action builder is gas-mode, but LTC/DOGE reject a fee-bearing action
        // that carries no native fee output. Inject the fee output ONCE here,
        // outside the retry loop (fee sizing doesn't change across stale-UTXO
        // rebuilds). Skip when the caller opts out (a test deliberately omitting
        // the fee) or already supplied a FEE_DESTINATION output of its own
        // (nativeFeeLive/nativeFeeDispenser pass theirs).
        let outputs = Array.isArray(customOutputs) ? customOutputs : []
        if (!skipNativeFeeInjection) {
            // getNativeFeeOutput() discovers the stack's real fee mode (env or
            // the indexer feeschedule): returns null on gas-mode chains (BTC),
            // an output on native-fee chains (LTC/DOGE), or THROWS on a fee chain
            // it can't resolve. Let that throw propagate; a silent skip here is
            // exactly what hung the LTC/DOGE suite. Dedup against the discovered
            // destination so callers that supply their own fee output (e.g.
            // nativeFeeLive/nativeFeeDispenser) aren't double-charged.
            // The action string and its sender let the helper size the output from the
            // indexer's quote for this action rather than a fixed amount.
            const nativeFeeHelper = require('../../../nativeFeeHelper')
            const feeOutput = await nativeFeeHelper.getNativeFeeOutput(
                typeof data === 'string' ? data : null, addressInfo && addressInfo["address"])
            if (feeOutput) {
                const alreadyHasFee = outputs.some(o => o && o.address === feeOutput.address)
                if (!alreadyHasFee) {
                    outputs = [feeOutput, ...outputs]
                    console.log('nativeFeeHelper: injected native fee output ' + feeOutput.value + ' sats -> ' + feeOutput.address)
                }
            }
        }

        // 15 attempts gives generous budget under full-suite load. Session 4
        // settled on 8; one stubborn ORDER partial-fill failure burned all 8
        // with identical rebuilds, suggesting the tracker had a phantom UTXO
        // that didn't clear within an 80s window. Per-retry wait is handled by
        // quiesce() (active wait for ready=true) at 20s timeout per attempt.
        const MAX_ATTEMPTS = 15
        let lastErr
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return await this['_doCreateAndSendTransaction'](addressInfo, data, rawData, outputs, outputType, compressedPubKey, opts)
            } catch (err) {
                if (attempt < MAX_ATTEMPTS && internalIsStaleUtxoError(err)) {
                    // TRAP LOG: capture tracker's view of this address at the
                    // moment of failure. The encoder picks utxos[0] (sorted by
                    // value desc), so the first entry is what got rejected.
                    // Cross-check against bitcoind's gettxout to identify
                    // phantoms next time the bug surfaces under load.
                    try {
                        const addr = addressInfo && addressInfo["address"]
                        if (addr) {
                            const snap = await utxoTrackerConnector.getUtxosFromAddress(addr)
                            const utxos = (snap && snap["utxos"]) || []
                            const sorted = utxos.slice().sort((a,b) => Number(b.value) - Number(a.value))
                            console.log("STALE-UTXO TRAP [" + addr + "] tracker reports " + utxos.length + " UTXO(s):")
                            for (let i = 0; i < sorted.length; i++) {
                                const u = sorted[i]
                                console.log("  [" + i + "] " + u.txid + ":" + u.vout + " value=" + u.value + " conf=" + u.confirmations + (i === 0 ? "  <- encoder picked this" : ""))
                            }
                        }
                    } catch (e) { /* trap log is best-effort */ }
                    transactionState.verifiedUtxos = null
                    transactionState.verifiedUtxosAddress = null
                    console.log("Broadcast failed (attempt " + attempt + "/" + MAX_ATTEMPTS + ") with stale UTXO; quiescing stack before retry...")
                    // Active wait for the regtest stack to fully settle (mempool
                    // empty, tracker committed-height == node height) instead of
                    // a blind sleep. quiesce() itself mines a block when mempool
                    // is non-empty, so straggling broadcasts get confirmed before
                    // we re-ask the encoder for UTXOs.
                    try {
                        await utxoTrackerConnector.quiesce({ timeoutMs: 20000, pollMs: 250, regtestMiner: regtestMinerConnector })
                    } catch (e) { /* swallow; next retry surfaces any persistent issue */ }
                    lastErr = err
                    continue
                }
                throw err
            }
        }
        throw lastErr
    }
}
