#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Seed a live chain with real contract state ahead of its armed
 * `contract_state_root` height (, spec claude/specs/spv-state-subtree-extension.md).
 *
 * WHY THIS EXISTS. The spec names this prerequisite and puts it on no checklist:
 *
 *   "if a testnet arming is meant to exercise the DERIVATION rather than the
 *    deploy train, the chain needs contract state first."
 *
 * A chain with an empty `contract_state` table commits EMPTY_SMT_ROOT into the
 * armed slot, which §2 makes byte-identical to an absent slot. So `state_root`
 * does not move, and the boundary proves the version flip (1 -> 2 through
 * getblockhashes into the SIGNED checkpoint canonical) and the deploy train, and
 * nothing about the derivation, the explorer proof endpoint or the SDK verifier.
 * Those three are the whole point of Stage A and they are currently proven on
 * regtest only. This tool is how a public chain gets something real to commit.
 *
 * WHAT IT DOES, as a resumable plan rather than a script. Every step reads the
 * chain first and skips itself if the chain already satisfies it, because the
 * steps are separated by real confirmations (roughly twenty minutes apiece on
 * BTC testnet) and a run WILL be interrupted:
 *
 *   1. PREFLIGHT   tip, armed height, blocks of runway, gas token, balances,
 *                  funding UTXOs, whether the contract is already deployed.
 *   2. ISSUE       the gas token, if the chain has none. Off regtest this is
 *                  restricted to the configured GAS address (issue.js), so it
 *                  needs that key and only ever runs once per chain.
 *   3. MINT        gas to the working address, if short. Open to any address.
 *   4. DEPLOY      bin/contracts/spvSeed.js.
 *   5. FILL        batched EXECUTEs until the live key count reaches --keys.
 *   6. TOMBSTONE   one EXECUTE deleting a key, so the SQL-NULL `state_value`
 *                  case frozen in spec §3 exists on a real chain and not only
 *                  in the golden vectors.
 *   7. VERIFY      read the state back and project the arming-block cost.
 *
 * IT DOES NOT BROADCAST BY DEFAULT. Without --broadcast it prints the plan it
 * would run and exits. That is not politeness: every step here is an irreversible
 * public transaction, and the useful output of the first run is the preflight.
 *
 * THE ARMING-BLOCK BUDGET IS ENFORCED, NOT PRINTED. Spec §7 step 4 measured the
 * full build at 42-53 ms and exactly 256 `state_tree_nodes` rows per live key,
 * invariant across key-set shapes. The arming block pays that inside its block
 * transaction, on the indexer and every follower at once. So seeding a chain is
 * choosing what its arming block will cost, and this tool refuses a --keys that
 * would spend more than --budget-fraction of a block interval unless --force.
 * Seeding too much is not a slow block; it is a chain that cannot cross its own
 * armed height.
 *
 * KEYS COME FROM THE ENVIRONMENT, NEVER FROM ARGV.
 *   XC_SEED_WIF      working address: pays miner fees, holds gas, owns the contract
 *   XC_SEED_GAS_WIF  the configured GAS address; needed ONLY for step 2
 * Neither is ever printed, logged or written to the state file. A WIF on the
 * command line lands in the shell history and in every `ps` on the host.
 *
 * USAGE
 *   # what would happen, and what is missing (reads only)
 *   XC_SEED_WIF=... node bin/seed-contract-state.js --chain BTC --network testnet
 *
 *   # do it
 *   XC_SEED_WIF=... node bin/seed-contract-state.js --chain BTC --network testnet \
 *       --keys 250 --broadcast
 *
 * BTC ONLY, deliberately. LTC and DOGE pay the protocol fee in the native coin
 * and this tool attaches no FEE_DESTINATION output, so its actions would be
 * mined and THEN rejected. It refuses those chains up front rather than
 * discovering it a block later; see the guard in main for the full reasoning.
 *
 * OPTIONS
 *   --chain <COIN>            default BTC (the only supported value, see above)
 *   --network <net>           default testnet
 *   --keys <n>                target LIVE key count, default 250
 *   --batch <n>               keys per EXECUTE, default 100
 *   --budget-fraction <f>     max share of a block interval the arming build may
 *                             cost, default 0.10
 *   --block-seconds <n>       block interval used for the budget; default is the
 *                             chain's own target (BTC 600, LTC 150, DOGE 60)
 *   --encoder-url / --encoder-port / --explorer-url / --explorer-port
 *   --state <path>            resume file, default ./.seed-<COIN>-<net>.json
 *   --broadcast               actually send
 *   --force                   proceed past the arming-block budget refusal
 *   --confirm-gas-issue       allow step 2, which CREATES the gas token on this
 *                             chain with the caps and mint window below
 *   --gas-decimals <n>        default 8            (mainnet genesis value)
 *   --gas-max-supply <n>      default 100000000    (mainnet genesis value)
 *   --gas-max-mint <n>        default 100000       (per-tx cap; genesis sets none)
 *   --gas-mint-start <n>      default: derived from the chain tip at ISSUE time
 *                             (tip + 2). NOT 1: issue.js rejects a
 *                             MINT_START_BLOCK below the block the ISSUE lands in.
 *
 * EXIT: 0 done or plan printed, 1 a step failed, 2 cannot run (missing key,
 * missing funds, chain already past its armed height).
 *
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Measured constants from spec §7 step 4. These are figures somebody paid for
// on a real venue, not estimates: quoting them here is what lets the budget
// check below be a refusal rather than a suggestion.
// ---------------------------------------------------------------------------
const ARMING_MS_PER_KEY   = 53;    // upper end of the measured 42-53 ms band
const ARMING_ROWS_PER_KEY = 256;   // exact, and shape-invariant

// Chain block-interval targets, used only to size the arming budget.
const BLOCK_SECONDS = { BTC: 600, LTC: 150, DOGE: 60 };

// The protocol gas token. Consensus-pinned in xchain-documentation/protocol/
// constants.js as GAS_TICK and copied into each indexer config as config['GAS'];
// the SDK carries no copy, so it is named once here rather than threaded from a
// service that might be on older code.
const GAS_TICK = 'XCHAIN';

// Blocks of headroom between the tip we read and the MINT_START_BLOCK we ask for.
// issue.js rejects MINT_START_BLOCK < BLOCK_INDEX, so the value must still be at or
// above the height the ISSUE actually lands in, and a block can arrive between the
// read and the broadcast. Two is enough on a 10-minute chain and costs only that
// long before the mint opens.
const MINT_START_LEAD = 2;

// Keys spvSeed.js initialize() writes before any fill: owner, seed/version,
// seed/purpose, seed/count, seed/doomed, and the two seed/prefix/... keys.
// Subtracting these from the live key count is how a resume works out where the
// bulk fill got to WITHOUT trusting local bookkeeping (see step 6). Pinned by
// test/unit/seedFillResumesFromChain.test.js, which counts the state.set calls
// in the contract source, so adding a base key without updating this constant
// fails there rather than silently rewriting a hundred paid-for keys.
const SEED_BASE_KEYS = 7;

// Where the explorer nests the payload of a document. Used by explorerField
// (see its header, below the helpers banner) for every field this tool reads
// out of an explorer response.
const EXPLORER_ENVELOPES = ['info', 'data', 'result', 'attributes'];

function loadSDK() {
    const candidates = ['xchain-sdk', '../../xchain-sdk', '../../../xchain-sdk'];
    let lastErr = null;
    for (const c of candidates) {
        try { return require(c); } catch (e) { lastErr = e; }
    }
    throw new Error('cannot resolve xchain-sdk: ' + (lastErr && lastErr.message));
}

// chunkHelper via the SAME candidate paths loadSDK uses. require.resolve is not
// equivalent here: this tool is run from staged copies that carry no node_modules
// link for xchain-sdk, and there the resolve throws and the budget check silently
// degrades to "unchecked" on exactly the runs that matter.
function loadChunkHelper() {
    for (const c of ['xchain-sdk/src/chunkHelper.js',
                     '../../xchain-sdk/src/chunkHelper.js',
                     '../../../xchain-sdk/src/chunkHelper.js']) {
        try {
            return c.startsWith('.') ? require(path.resolve(__dirname, c)) : require(c);
        } catch (e) { /* next */ }
    }
    return null;
}

function parseArgs() {
    const a = process.argv.slice(2);
    const o = {
        chain: 'BTC', network: 'testnet', keys: 250, batch: 100,
        budgetFraction: 0.10, broadcast: false, force: false,
        confirmGasIssue: false,
        // gasMintStart null = derive it from the chain tip at ISSUE time. It is NOT
        // 1: issue.js rejects MINT_START_BLOCK < BLOCK_INDEX outright, so a literal
        // 1 is invalid on every chain past height 1 and the ISSUE is dropped with
        // "invalid: MINT_START_BLOCK < BLOCK_INDEX". That happened on BTC:testnet
        // 2026-08-03 at height 146915: the transaction confirmed, the action
        // indexed, and no token was created. "Open the mint immediately" means
        // "at the block this ISSUE lands in", not "at block 1".
        gasDecimals: 8, gasMaxSupply: 100000000, gasMaxMint: 100000, gasMintStart: null,
    };
    for (let i = 0; i < a.length; i++) {
        switch (a[i]) {
            case '--chain':            o.chain = String(a[++i]).toUpperCase(); break;
            case '--network':          o.network = a[++i]; break;
            case '--keys':             o.keys = parseInt(a[++i], 10); break;
            case '--batch':            o.batch = parseInt(a[++i], 10); break;
            case '--budget-fraction':  o.budgetFraction = parseFloat(a[++i]); break;
            case '--block-seconds':    o.blockSeconds = parseInt(a[++i], 10); break;
            case '--encoder-url':      o.encoderUrl = a[++i]; break;
            case '--encoder-port':     o.encoderPort = parseInt(a[++i], 10); break;
            case '--explorer-url':     o.explorerUrl = a[++i]; break;
            case '--explorer-port':    o.explorerPort = parseInt(a[++i], 10); break;
            case '--state':            o.state = a[++i]; break;
            case '--broadcast':        o.broadcast = true; break;
            case '--force':            o.force = true; break;
            // Escape hatch for a recorded transaction the chain never took (a
            // mempool eviction, a replaced fee). Without it a dropped broadcast
            // wedges every later run forever, since the guard cannot tell
            // "still pending" from "gone" by reading the chain alone.
            case '--clear-pending':    o.clearPending = true; break;
            case '--fee-per-kb':       o.feePerKb = parseInt(a[++i], 10); break;
            case '--confirm-gas-issue': o.confirmGasIssue = true; break;
            case '--gas-decimals':     o.gasDecimals = parseInt(a[++i], 10); break;
            case '--gas-max-supply':   o.gasMaxSupply = parseInt(a[++i], 10); break;
            case '--gas-max-mint':     o.gasMaxMint = parseInt(a[++i], 10); break;
            case '--gas-mint-start':   o.gasMintStart = parseInt(a[++i], 10); break;
            case '--help': case '-h':
                process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0] + '\n');
                process.exit(0);
                break;
            default:
                process.stderr.write('unknown arg: ' + a[i] + '\n');
                process.exit(64);
        }
    }
    if (!Number.isInteger(o.keys) || o.keys < 1)   fail64('--keys must be a positive integer');
    if (!Number.isInteger(o.batch) || o.batch < 1) fail64('--batch must be a positive integer');
    if (o.batch > 1000) fail64('--batch above 1000 exceeds the contract\'s own cap');
    if (!(o.budgetFraction > 0 && o.budgetFraction <= 1)) fail64('--budget-fraction must be in (0,1]');
    if (!o.state) o.state = path.join(process.cwd(), '.seed-' + o.chain + '-' + o.network + '.json');
    return o;
}

function fail64(msg) { process.stderr.write(msg + '\n'); process.exit(64); }

// Report the fee rate this run will build at, and flag an estimator that has
// clearly come loose. SANITY_CEILING is not a claim about what a fee SHOULD be;
// it is the line past which a testnet estimate is more likely broken than real,
// and crossing it is reported rather than enforced, because a genuinely
// congested chain is allowed to be expensive.
// PIN THE FEE RATE; DO NOT MERELY REPORT IT.
//
// create_tx, left to itself on a non-regtest chain, uses the node's
// estimatesmartfee VERBATIM with no sanity ceiling (xchain-encoder
// BlockchainConnector.getFeePerKilobyte - the regtest branch has such a guard,
// testnet and mainnet do not). On BTC:testnet 2026-08-11 that read 0.00361714
// BTC/kB, ~362 sat/vB, against a network actually at 6.
//
// A data-bearing action pays that rate TWICE: once in the fee, and again in
// every carrier output, because dust is derived from the fee rate. The same
// DEPLOY of the same 3928-byte contract that cost "outputs 30639 + fee 2360" on
// 2026-08-04 was refused at "outputs 2940202 + fee 293610". Driving the encoder
// across rates confirmed it is exactly linear: 47,285 at 6 sat/vB, 157,608 at
// 20, and scaling 47,285 by the node's estimate predicts 2,850,608 against the
// 2,850,665 it actually refused on.
//
// AND THE ENCODER DISAGREES WITH ITSELF, which is why this pins rather than
// warns. getFeeTiers answered ~10 sat/vB for this chain in the same minute
// create_tx was charging ~362, because the tiers endpoint and create_tx do not
// resolve the rate the same way. A check that read the tiers and shouted only
// when THEY looked wrong would have stayed silent through the whole incident.
// So the tiers value is not used as a warning threshold; it is used as the rate,
// passed explicitly, so the pathological path is never taken silently.
const FEE_FALLBACK_SAT_VB = 6;
async function resolveFeeRate(sdk, opts, log) {
    if (opts.feePerKb) {
        log('  fee rate:          ' + (opts.feePerKb / 1000).toFixed(2) +
            ' sat/vB  (explicit, --fee-per-kb ' + opts.feePerKb + ')');
        return;
    }
    let tiers = null;
    try { tiers = await sdk.getFeeTiers(); } catch (e) { tiers = null; }
    const pick = tiers && [tiers.medium, tiers.med, tiers.high, tiers.low]
        .map(Number).find(n => Number.isFinite(n) && n > 0);
    if (pick) {
        opts.feePerKb = Math.ceil(pick * 1000);
        log('  fee rate:          ' + pick.toFixed(2) + ' sat/vB, PINNED from the encoder fee tiers');
        log('                     (left unpinned, create_tx uses the node estimatesmartfee unchecked,');
        log('                     which measured ~362 sat/vB on this chain on 2026-08-11)');
        return;
    }
    opts.feePerKb = FEE_FALLBACK_SAT_VB * 1000;
    log('  fee rate:          the encoder would not quote tiers; PINNED to ' +
        FEE_FALLBACK_SAT_VB + ' sat/vB rather than');
    log('                     letting create_tx fall through to the node estimate, which is');
    log('                     unguarded off regtest. Override with --fee-per-kb.');
}


function log(msg)  { process.stdout.write(msg + '\n'); }
function step(n, msg) { log(''); log('== ' + n + '. ' + msg); }

// Resume file. Holds ONLY public facts (the contract's action index, the txids
// broadcast, the address). No key material ever reaches it: a resume file is
// exactly the sort of thing that gets committed or copied to a colleague.
function readState(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}
function writeState(p, s) {
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}

// The armed height for this chain, read out of the indexer's own gate rather
// than passed in, so this tool cannot be pointed at a height nobody armed.
function armedHeight(chain, network) {
    const candidates = [
        '../../xchain-indexer/src/state_subtree_activation.js',
        '../../../xchain-indexer/src/state_subtree_activation.js',
    ];
    for (const c of candidates) {
        try {
            const SUB = require(path.resolve(__dirname, c));
            const h = SUB.STATE_SUBTREE_ACTIVATION.contract_state_root[chain + ':' + network];
            return h === undefined ? null : Number(h);
        } catch (e) { /* try the next layout */ }
    }
    return undefined;   // gate not resolvable, distinct from "not armed"
}

// Only run when invoked as a CLI. Required as a module (by the unit test) this
// is a library of pure helpers, and the parsing helpers are exactly where this
// tool has had its defects, so they need to be reachable from a test.
async function main() {
    const opts  = parseArgs();
    const state = readState(opts.state);
    const { XChainSDK } = loadSDK();

    const wif    = process.env.XC_SEED_WIF || null;
    const gasWif = process.env.XC_SEED_GAS_WIF || null;
    if (!wif) {
        process.stderr.write('XC_SEED_WIF is required (the working address key). ' +
                             'Set it in the environment; never pass a WIF on the command line.\n');
        process.exit(2);
    }

    const chainName = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' }[opts.chain];
    if (!chainName) fail64('unsupported --chain ' + opts.chain);

    // GAS-MODE CHAINS ONLY, and this is a refusal rather than a caveat. On LTC
    // and DOGE the protocol fee is paid in the native coin: `detectFeePaymentMode`
    // returns 'rejected' for a top-level fee-paying action carrying no output to
    // FEE_DESTINATION, so every MINT / DEPLOY / EXECUTE this tool builds would be
    // BROADCAST, MINED, and then indexed `invalid: insufficient fee (native coin
    // output required)`. That is the worst possible failure shape for a seeding
    // run: it costs real coin, it looks like it worked until the indexer verdict
    // comes back, and on a chain with twenty-minute blocks the operator finds out
    // an hour later. Attaching the output needs the native-fee oracle path
    // (getNativeFeeOutput, live prices, a non-frozen chain clock), which is a
    // different piece of work from seeding; until it exists, say so up front.
    if (opts.chain !== 'BTC') {
        process.stderr.write(
            opts.chain + ' pays its protocol fee in the native coin, and this tool does not attach a\n' +
            'FEE_DESTINATION output, so every action it builds would index as\n' +
            '"invalid: insufficient fee (native coin output required)" AFTER being paid for and mined.\n' +
            'Only BTC (gas-mode, fees in ' + GAS_TICK + ') is supported. Refusing rather than wasting coin.\n');
        process.exit(2);
    }

    const sdk = new XChainSDK({
        network:      chainName + '-' + opts.network,
        encoderUrl:   opts.encoderUrl  || process.env.ENCODER_URL  || undefined,
        encoderPort:  opts.encoderPort || (process.env.ENCODER_API_PORT
                        ? parseInt(process.env.ENCODER_API_PORT, 10) : undefined),
        explorerUrl:  opts.explorerUrl  || process.env.EXPLORER_URL || undefined,
        explorerPort: opts.explorerPort || (process.env.EXPLORER_PORT
                        ? parseInt(process.env.EXPLORER_PORT, 10) : undefined),
        timeout:      60000,
        retry:        { maxRetries: 2 },
    });

    // p2pkh throughout: the GAS address this chain is configured with is p2pkh
    // (a vanity address in the coin bundle), so a working address of the same
    // type keeps the two halves of a run comparable and keeps the encoder off
    // the two-phase P2SH/P2WSH reveal path, which is more moving parts than a
    // seed run needs.
    const address    = addressOf(sdk, wif);
    const gasTick    = GAS_TICK;
    // RECORD THE TXID AT BROADCAST, NOT AT SUCCESS. Every step below skips
    // itself by asking the CHAIN, which is what makes this tool resumable, but
    // a transaction sitting in the mempool is not chain state yet: inside that
    // window a re-run sees "not done" and broadcasts a SECOND one. That is not
    // hypothetical, it is how a duplicate ISSUE went out on BTC:testnet on
    // 2026-08-04 after the first run was killed mid-wait.
    //
    // The SDK fires progress('waiting', {txid}) immediately after the broadcast
    // and before the index wait, which is the only moment the txid exists and
    // the outcome does not. Persist it there, keyed by step label, and clear it
    // once the chain has settled the question. The state file is the tool's
    // memory of what it has already put on the wire; the chain is still the
    // authority on what happened to it.
    const rememberPending = (label, txid) => {
        if (!txid) return;
        state.pending = state.pending || {};
        state.pending[label] = txid;
        writeState(opts.state, state);
    };
    const forgetPending = (label) => {
        if (!state.pending || !state.pending[label]) return;
        delete state.pending[label];
        if (!Object.keys(state.pending).length) delete state.pending;
        writeState(opts.state, state);
    };

    const submitOpts = { wif, waitForIndexer: true, timeout: 1800000, pollInterval: 15000 };

    // THE FEE RATE IS AN INPUT, NOT A FACT, AND ON TESTNET IT IS ROUTINELY WRONG.
    // Every action below is built by the encoder, which on a non-regtest chain
    // takes the node's estimatesmartfee VERBATIM with no sanity ceiling
    // (xchain-encoder BlockchainConnector.getFeePerKilobyte; the regtest branch
    // has such a guard and testnet/mainnet do not). That matters far more than a
    // fee line usually would, because the carrier outputs of a data-bearing
    // transaction must each clear the DUST threshold and dust is DERIVED from the
    // fee rate: the cost of the outputs scales linearly with it.
    //
    // Measured on BTC:testnet 2026-08-11 rather than reasoned about. The node
    // answered estimatesmartfee(1) = 0.00361714 BTC/kB (~362 sat/vB) while the
    // network was actually at 6 sat/vB, a 60x overestimate, and the same DEPLOY
    // of the same 3928-byte contract that cost "outputs 30639 + fee 2360" on
    // 2026-08-04 was refused at "outputs 2940202 + fee 293610". Nothing about the
    // contract, the encoding or the protocol had changed; only the estimator had
    // moved. Driving the encoder across fee rates confirmed the mechanism exactly:
    // outputs came back 47,285 at 6 sat/vB and 157,608 at 20 sat/vB, linear, and
    // scaling 47,285 by the measured estimate predicts 2,850,608 against the
    // 2,850,665 it actually refused on.
    //
    // So the rate is passed EXPLICITLY here. It goes in the encoderOpts argument
    // (submitAction's SECOND parameter), not in submitOpts, which is where the
    // SDK threads it down to create_tx.
    const txIo = (addr) => {
        const io = { pubkey: addr, change: addr };
        if (opts.feePerKb) io.feePerKb = opts.feePerKb;
        return io;
    };

    const submitChecked = makeSubmitChecked(sdk, log, { rememberPending, forgetPending });

    log('# seed contract state on ' + opts.chain + '/' + opts.network);
    log('# mode: ' + (opts.broadcast ? 'BROADCAST' : 'PLAN ONLY (no transaction is sent)'));

    // -----------------------------------------------------------------------
    // 1. PREFLIGHT
    // -----------------------------------------------------------------------
    step(1, 'preflight');

    // SETTLE ANYTHING LEFT IN FLIGHT BEFORE PLANNING ANYTHING NEW.
    //
    // Every step below decides whether to run by asking the chain. That is the
    // right instinct and it is what makes this tool resumable, but it has one
    // blind spot: a transaction that has been broadcast and not yet mined is
    // invisible to a chain read, so the step reads as "not done" and a re-run
    // broadcasts a duplicate. The state file closes that gap by remembering
    // what went on the wire; this block is where the chain is asked to settle
    // each one, ONCE, before any decision depends on it.
    //
    // The three outcomes are deliberately different:
    //   indexed and valid   -> it happened; forget it and let the chain reads below see it
    //   indexed and invalid -> it failed on chain; forget it so the step retries
    //   not found at all    -> UNKNOWN, and unknown is the dangerous one, so stop
    // Refusing on "not found" is the whole point. Guessing "gone, re-broadcast"
    // is what put a duplicate ISSUE on BTC:testnet.
    if (state.pending && Object.keys(state.pending).length) {
        const pending = Object.entries(state.pending);
        log('  in flight:         ' + pending.length + ' transaction(s) recorded as broadcast by an earlier run');
        if (opts.clearPending) {
            for (const [label, txid] of pending) {
                log('    ' + label + ' ' + txid + ' -> DISCARDED (--clear-pending)');
                forgetPending(label);
            }
        } else {
            let unresolved = 0;
            for (const [label, txid] of pending) {
                let tx = null;
                try { tx = await sdk.explorer.getTransaction(txid, 'tx_hash'); } catch (e) { tx = null; }
                const hash = explorerField(tx, 'tx_hash');
                if (!hash.found) {
                    log('    ' + label + ' ' + txid + ' -> NOT ON CHAIN YET');
                    unresolved++;
                    continue;
                }
                const acts = Array.isArray(explorerField(tx, 'actions').value)
                    ? explorerField(tx, 'actions').value : [];
                const bad = acts.filter(a => !/^valid\b/i.test(String((explorerField(a, 'status').value) || '')));
                if (!acts.length || bad.length) {
                    log('    ' + label + ' ' + txid + ' -> indexed but NOT valid (' +
                        (acts.length ? acts.map(a => explorerField(a, 'status').value).join(', ') : 'no actions') +
                        '); the step will be retried');
                } else {
                    log('    ' + label + ' ' + txid + ' -> settled valid at block ' +
                        explorerField(tx, 'block_index').value);
                }
                forgetPending(label);
            }
            if (unresolved) {
                log('');
                log('  REFUSING to plan while ' + unresolved + ' broadcast transaction(s) are still unconfirmed.');
                log('  Re-running now would broadcast a DUPLICATE of work already paid for, because');
                log('  every step here decides by reading the chain and the mempool is not the chain.');
                log('  Wait for them to confirm and re-run; this is idempotent once they land.');
                log('  If one was genuinely dropped (mempool eviction, fee replacement), discard it');
                log('  deliberately with --clear-pending.');
                process.exit(3);
            }
        }
    }

    const H = armedHeight(opts.chain, opts.network);
    if (H === undefined)
        log('  armed height:      UNKNOWN (could not resolve the indexer activation gate)');
    else if (H === null)
        log('  armed height:      none for ' + opts.chain + ':' + opts.network + ' (seeding is still valid, ' +
            'but nothing will consume it until a height is armed)');
    else
        log('  armed height:      ' + H);

    // The explorer serves ONE status document for the whole fleet, keyed by coin
    // prefix (TBTC, RLTC, ...), not a per-chain scalar: `last_block` is a map.
    // Reading it as a scalar silently yields null and the runway line, which is
    // the number this preflight exists to produce, just vanishes. Both reads go
    // through explorerField (see its header) so a shape change is reported
    // rather than absorbed as "no tip".
    let tip = null;
    try {
        const st     = await sdk.explorer.getStatus();
        const prefix = coinPrefix(opts.chain, opts.network);
        let read = explorerField(st, 'last_block', { key: prefix });
        if (!read.found) {
            const alt = explorerField(st, 'decoder_tip', { key: prefix });
            if (alt.found || alt.surprise) read = alt;
        }
        tip = read.found && Number.isFinite(Number(read.value)) ? Number(read.value) : null;
        if (tip === null) {
            log('  ! explorer status carried no tip for ' + prefix +
                (read.surprise ? ' (' + read.surprise + ')' : ''));
            if (read.document && !read.surprise)
                log('    the status document has keys: ' + Object.keys(st).join(', '));
        }
    } catch (e) {
        log('  ! explorer status unavailable: ' + e.message);
    }
    if (tip) log('  chain tip:         ' + tip);
    if (tip && Number.isInteger(H)) {
        const runway = H - tip;
        log('  blocks of runway:  ' + runway + (runway <= 0 ? '  (ALREADY PAST THE ARMED HEIGHT)' : ''));
        if (runway <= 0) {
            log('');
            log('  The chain has already crossed its armed height. Seeding now still puts');
            log('  contract state on the chain, and every block AFTER the seed commits a real');
            log('  contract_state_root, but the ARMING BLOCK itself committed EMPTY_SMT_ROOT and');
            log('  that cannot be redone. Nothing here is unsafe; the boundary evidence is what');
            log('  is lost. Continuing.');
        }
    }

    // The arming-block budget. Sized on the target key count, because that is
    // what buildFull pays for.
    const blockSeconds = opts.blockSeconds || BLOCK_SECONDS[opts.chain] || 600;
    const armingMs     = opts.keys * ARMING_MS_PER_KEY;
    const armingRows   = opts.keys * ARMING_ROWS_PER_KEY;
    const budgetMs     = blockSeconds * 1000 * opts.budgetFraction;
    log('  arming projection: ' + opts.keys + ' live keys -> ~' + (armingMs / 1000).toFixed(1) + ' s and ' +
        armingRows.toLocaleString('en-US') + ' state_tree_nodes rows in the arming block');
    log('                     budget ' + (budgetMs / 1000).toFixed(1) + ' s (' +
        (opts.budgetFraction * 100).toFixed(0) + '% of a ' + blockSeconds + ' s block)');
    if (armingMs > budgetMs) {
        log('');
        log('  REFUSING: the projected arming build exceeds the budget. The build runs INSIDE');
        log('  the block transaction on the indexer and on every follower at once, so an');
        log('  over-budget seed does not make one block slow, it can stop the chain crossing');
        log('  its own armed height. Lower --keys, raise --budget-fraction deliberately, or');
        log('  pass --force if you have decided this venue can afford it.');
        if (!opts.force) process.exit(2);
        log('  --force given: continuing anyway.');
    }

    // Gas token existence. Off regtest, only the configured GAS address can
    // create it, so this is the step most likely to block a real run.
    //
    // READ THE TICK OUT OF `info`, NOT THE TOP LEVEL. The explorer's token
    // document nests identity under `info` ({ info: { coin, tick, owner, ... },
    // supply: {...}, mints: {...} }) and carries NO top-level `tick`. A check of
    // `gasToken.tick` is therefore false for every token that exists, on every
    // chain, so the preflight reports DOES NOT EXIST against a live token and
    // step 3 re-ISSUEs one that is already there. Observed on BTC:testnet
    // 2026-08-04, where the 2026-08-03 ISSUE had confirmed (tokens=1,
    // action_index 3 at block 146956) and the tool broadcast a second one.
    // Same failure class as the `last_block` map read above, which is why both
    // now go through explorerField instead of guessing a path each.
    let gasToken = null;
    try { gasToken = await sdk.explorer.getToken(gasTick); } catch (e) { gasToken = null; }
    const gasTickRead = explorerField(gasToken, 'tick');
    const gasExists = gasTickRead.found &&
        String(gasTickRead.value).toUpperCase() === String(gasTick).toUpperCase();
    // A document that answers, and answers with something other than this tick,
    // is NOT an absence. Deciding "does not exist" from it is what broadcasts a
    // duplicate ISSUE, so it becomes a blocker below rather than a plan step.
    let gasShapeProblem = null;
    if (!gasExists && gasToken && !isExplorerError(gasToken)) {
        if (gasTickRead.document && !gasTickRead.found) gasShapeProblem =
            'the explorer answered getToken(' + gasTick + ') with a document that carries no `tick` ' +
            'at the top level or under ' + EXPLORER_ENVELOPES.join('/') + ' (its keys: ' +
            Object.keys(gasToken).join(', ') + '). That is a SHAPE CHANGE, not an absent token, and ' +
            'reading it as absent is what broadcast a second ISSUE on BTC:testnet 2026-08-04. ' +
            'Refusing to guess: fix the read, then re-run.';
        else if (gasTickRead.found) gasShapeProblem =
            'the explorer answered getToken(' + gasTick + ') with a document for tick ' +
            gasTickRead.value + ' (read at `' + gasTickRead.at + '`). One of the two is wrong, and ' +
            'neither answer justifies issuing ' + gasTick + ' again.';
    }
    log('  gas token ' + gasTick + ':   ' + (gasExists
        ? 'exists (read at `' + gasTickRead.at + '`)'
        : 'DOES NOT EXIST on this chain'));

    // Working address: native funds and gas balance.
    log('  working address:   ' + (address || '(could not derive from XC_SEED_WIF)'));
    let utxoTotal = 0, gasBalance = '0';
    try {
        const u = await sdk.encoder.getUTXOs(address);
        const list = (u && (u.utxos || u.data || u)) || [];
        if (Array.isArray(list)) for (const x of list) utxoTotal += Number(x.value || x.amount || 0);
        log('  funding utxos:     ' + (Array.isArray(list) ? list.length : 0) + ' totalling ' + utxoTotal + ' sats');
    } catch (e) {
        log('  ! utxo lookup failed: ' + e.message);
    }
    try {
        const bals = await sdk.explorer.getBalances(address);
        const rows = (bals && (bals.data || bals)) || [];
        if (Array.isArray(rows)) {
            // Same read, same helper: a balance row that nests its tick would
            // otherwise report a zero balance and the run would MINT again.
            const g = rows.find(r => {
                const t = explorerField(r, 'tick');
                return t.found && String(t.value).toUpperCase() === gasTick;
            });
            if (g) {
                const amt = ['amount', 'quantity', 'balance']
                    .map(n => explorerField(g, n)).find(x => x.found);
                gasBalance = amt ? String(amt.value) : '0';
            }
        }
        log('  gas balance:       ' + gasBalance + ' ' + gasTick);
    } catch (e) {
        log('  ! balance lookup failed: ' + e.message);
    }

    // The GAS address needs its OWN native funds, and this is not the same
    // question as the working address having them.
    //
    // WHY THIS CHECK EXISTS. The ISSUE step must be SIGNED BY the configured
    // GAS address, because off regtest issue.js admits no other source. So that
    // address pays that transaction's miner fee out of its own UTXOs. The
    // preflight used to check only the working address, which meant a run with
    // a funded working address and an empty GAS address reported NO BLOCKERS,
    // broadcast, and died on the very first step with the encoder's
    // "no utxos were provided and no utxos found on the blockchain" - a message
    // that names neither the address nor the reason. That happened on
    // BTC:testnet 2026-08-03 and cost a confirmation cycle to diagnose. A
    // preflight whose job is to answer "will this run" must ask about every
    // address the run spends from.
    let gasUtxoTotal = null;   // null = not applicable / not looked up
    if (!gasExists && gasWif) {
        try {
            const ga = addressOf(sdk, gasWif);
            const gu = await sdk.encoder.getUTXOs(ga);
            const glist = (gu && (gu.utxos || gu.data || gu)) || [];
            gasUtxoTotal = 0;
            if (Array.isArray(glist)) for (const x of glist) gasUtxoTotal += Number(x.value || x.amount || 0);
            log('  GAS address:       ' + ga);
            log('  GAS utxos:         ' + (Array.isArray(glist) ? glist.length : 0) +
                ' totalling ' + gasUtxoTotal + ' sats   [pays for the ISSUE]');
        } catch (e) {
            log('  ! GAS utxo lookup failed: ' + e.message);
        }
    }

    // WHAT THE ENCODER WOULD CHARGE, surfaced BEFORE anything is broadcast.
    // A preflight that reports funds without reporting the rate those funds are
    // measured against answers the wrong question: on 2026-08-11 the working
    // address held 230,903 sats, which reads as "funded" and was in fact 7% of
    // what the node's fee estimate implied a single DEPLOY would cost.
    await resolveFeeRate(sdk, opts, log);

    // THE CONTRACT MUST FIT ONE INLINE DEPLOY, checked here rather than
    // discovered at the DEPLOY step. The source is base64'd into a single action
    // capped at MAX_ACTION_DATA_LENGTH (8192), which is about 6132 source bytes;
    // past that the SDK's chunked path (N carrier DEPLOY v4 actions plus an
    // assembling v2/v3) is required, and this tool does not implement it. The
    // first draft of spvSeed.js was 6549 bytes and would have failed here, after
    // the gas ISSUE and MINT had already been broadcast and paid for. Comments in
    // that file are on-chain bytes, so it is one careless paragraph from
    // regressing; the check is cheap and belongs in the preflight.
    const seedCodePath = path.join(__dirname, 'contracts', 'spvSeed.js');
    const seedCode     = fs.readFileSync(seedCodePath, 'utf8');
    let fitsInline = null;
    const ch = loadChunkHelper();
    if (ch) {
        fitsInline = ch.fitsSingleDeploy(seedCode);
        log('  contract source:   ' + Buffer.byteLength(seedCode) + ' bytes, single inline DEPLOY: ' +
            (fitsInline ? 'yes' : 'NO'));
    } else {
        log('  ! could not resolve the SDK chunkHelper; inline DEPLOY budget UNCHECKED');
    }

    // Contract, if a previous run deployed one. The state file is a CACHE and
    // never the authority, in either direction: it can be missing a contract the
    // chain carries (the 2026-08-04 run died inside its DEPLOY index-wait, and
    // the resume the next day printed "not deployed yet" at a contract sitting
    // valid at action_index 6 and broadcast a duplicate), and it can carry one
    // the chain does not (the 2026-08-10 testnet re-genesis). resolveContractIndex
    // asks the chain unconditionally and explains whichever disagreement it finds.
    let contractIndex;
    try {
        contractIndex = await resolveContractIndex(sdk, seedCode, address, state, log, opts.state);
    } catch (e) {
        log('  ! ' + e.message);
        log('    Treating that as "not deployed" would risk a duplicate DEPLOY, so this run');
        log('    refuses to plan. Re-run once the explorer answers.');
        process.exit(4);
    }
    const priorIndex = state.contractIndex || null;
    if (contractIndex !== priorIndex) {
        state.contractIndex = contractIndex;
        writeState(opts.state, state);
    }
    let liveKeys = 0;
    if (contractIndex) {
        liveKeys = await countLiveKeys(sdk, contractIndex);
        log('  live state keys:   ' + liveKeys);
    }

    // -----------------------------------------------------------------------
    // The plan. Printed either way, so a PLAN run is the checklist and a
    // BROADCAST run is the same list with results appended.
    // -----------------------------------------------------------------------
    const plan = [];
    if (!gasExists)                 plan.push('ISSUE ' + gasTick + ' (needs XC_SEED_GAS_WIF: the configured GAS address)');
    if (Number(gasBalance) < 100)   plan.push('MINT ' + gasTick + ' to the working address');
    if (!contractIndex)             plan.push('DEPLOY bin/contracts/spvSeed.js (writes 7 base keys)');
    const need = Math.max(0, opts.keys - Math.max(liveKeys, 0));
    if (need > 0)                   plan.push('EXECUTE fill x' + Math.ceil(need / opts.batch) +
                                              ' (' + need + ' more keys, ' + opts.batch + ' per transaction)');
    if (!state.tombstoned)          plan.push('EXECUTE remove seed/doomed (the SQL-NULL tombstone case)');

    step(2, 'plan');
    if (!plan.length) log('  nothing to do: this chain already carries the target seed.');
    else plan.forEach((p, i) => log('  ' + (i + 1) + '. ' + p));

    const blockers = [];
    if (gasShapeProblem) blockers.push(gasShapeProblem);
    if (!gasExists && !gasWif) blockers.push(
        'the gas token does not exist on this chain and XC_SEED_GAS_WIF is not set. Off regtest ' +
        'only the configured GAS address may issue it (xchain-indexer/src/actions/issue.js), so ' +
        'this step cannot be done with the working key.');
    if (utxoTotal === 0) blockers.push(
        'the working address holds no confirmed funding utxos. Fund ' + address + ' before broadcasting.');
    if (gasUtxoTotal === 0) blockers.push(
        'the GAS address holds no confirmed funding utxos, and it pays for the ISSUE itself ' +
        '(that step must be signed by it, not by the working key). Fund ' + addressOf(sdk, gasWif) +
        ' before broadcasting, or the run dies on step 1 with the encoder reporting ' +
        '"no utxos were provided and no utxos found on the blockchain".');
    if (fitsInline === false && !contractIndex) blockers.push(
        'bin/contracts/spvSeed.js is ' + Buffer.byteLength(seedCode) + ' bytes and does NOT fit a single ' +
        'inline DEPLOY (~6132 source bytes). Trim it, or implement the SDK chunked deploy path; ' +
        'this tool does not. Comments in that file are on-chain bytes.');
    if (blockers.length) {
        log('');
        log('  BLOCKED:');
        blockers.forEach(b => log('   - ' + b));
    }

    if (!opts.broadcast) {
        log('');
        log('# plan only. Re-run with --broadcast to send. Nothing was transmitted.');
        process.exit(blockers.length ? 2 : 0);
    }
    if (blockers.length) {
        log('');
        log('# refusing to broadcast with the blockers above unresolved.');
        process.exit(2);
    }

    // -----------------------------------------------------------------------
    // 3. ISSUE the gas token (once per chain, GAS address only off regtest)
    // -----------------------------------------------------------------------
    if (!gasExists) {
        step(3, 'ISSUE ' + gasTick);
        // This action CREATES the gas token on this chain, with the caps and the
        // mint window it will carry from here on. Decimals lock at the first mint
        // (issue.js locks them only once SUPPLY > 0), so most of this is editable
        // for exactly as long as nobody has minted, and not one block longer.
        // Defaults mirror the mainnet genesis injection (xchain-indexer/src/genesis.js:
        // 8 decimals, 100,000,000 MAX_SUPPLY, zero pre-mint, GAS-owned) with ONE
        // deliberate difference: genesis pins MINT_START_BLOCK to a far-future
        // sentinel so the token exists un-mintable until the operator opens the
        // launch mint, and a seed chain needs it open now.
        //
        // Those are the operator's parameters to choose, not this tool's, so the
        // step refuses to run unless it is confirmed explicitly.
        // Resolve the mint-start height against the CURRENT tip. The ISSUE will be
        // mined a block or two from now, so aim a small distance ahead: the rule is
        // MINT_START_BLOCK >= the block the ISSUE lands in, and being early is fatal
        // while being slightly late only delays the mint by minutes.
        if (opts.gasMintStart == null) {
            const tipNow = Number(tip);
            if (!Number.isFinite(tipNow)) {
                log('  ! no chain tip available to derive mintStartBlock; pass --gas-mint-start');
                process.exit(2);
            }
            opts.gasMintStart = tipNow + MINT_START_LEAD;
            log('  mintStartBlock derived: tip ' + tipNow + ' + ' + MINT_START_LEAD +
                ' = ' + opts.gasMintStart + '   (must be >= the block this ISSUE lands in)');
        }
        if (!opts.confirmGasIssue) {
            log('  REFUSING without --confirm-gas-issue.');
            log('  This would create ' + gasTick + ' on ' + opts.chain + ':' + opts.network + ' with:');
            log('    decimals ' + opts.gasDecimals + ', maxSupply ' + opts.gasMaxSupply +
                ', maxMint ' + opts.gasMaxMint + ', mintStartBlock ' + opts.gasMintStart);
            log('  Review those, override with --gas-decimals / --gas-max-supply / --gas-max-mint /');
            log('  --gas-mint-start, then re-run with --confirm-gas-issue.');
            process.exit(2);
        }
        const gasAddress = addressOf(sdk, gasWif);
        log('  from GAS address ' + gasAddress);
        const res = await submitChecked(
            // No AMOUNT: ISSUE has no such field (format 0 is
            // VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|...),
            // and the pre-mint is MINT_SUPPLY, which is deliberately omitted so the
            // token is created with SUPPLY 0 exactly as the mainnet genesis injection
            // does. An earlier draft passed `amount: 0` and the SDK's own validator
            // rejected it ("AMOUNT must be a positive number") before any broadcast.
            { action: 'ISSUE', params: {
                tick: gasTick,
                decimals:       opts.gasDecimals,
                maxSupply:      opts.gasMaxSupply,
                maxMint:        opts.gasMaxMint,
                mintStartBlock: opts.gasMintStart,
                description:    'XChain gas token'
            } },
            txIo(gasAddress),
            Object.assign({}, submitOpts, { wif: gasWif }),
            'ISSUE ' + gasTick
        );
        requireValid(res, 'ISSUE ' + gasTick);
        state.issueTxid = res.txid;
        writeState(opts.state, state);
        log('  ok, txid ' + res.txid);
    }

    // -----------------------------------------------------------------------
    // 4. MINT gas
    // -----------------------------------------------------------------------
    if (Number(gasBalance) < 100) {
        step(4, 'MINT ' + gasTick);
        const res = await submitChecked(
            { action: 'MINT', params: { tick: gasTick, amount: 100000, destination: address } },
            txIo(address),
            submitOpts,
            'MINT ' + gasTick
        );
        requireValid(res, 'MINT ' + gasTick);
        state.mintTxids = (state.mintTxids || []).concat(res.txid);
        writeState(opts.state, state);
        log('  ok, txid ' + res.txid);
    }

    // -----------------------------------------------------------------------
    // 5. DEPLOY
    // -----------------------------------------------------------------------
    if (!contractIndex) {
        step(5, 'DEPLOY spvSeed');
        const code = fs.readFileSync(path.join(__dirname, 'contracts', 'spvSeed.js'), 'utf8');
        const res = await submitChecked(
            { action: 'DEPLOY', params: { code, gasLimit: 500000 } },
            txIo(address),
            submitOpts,
            'DEPLOY'
        );
        requireValid(res, 'DEPLOY');
        contractIndex = contractIndexOf(res.indexed);
        if (!contractIndex) {
            log('  ! DEPLOY indexed valid but no contract action_index could be read from the result.');
            log('    The contract IS deployed and paid for; this is a parse failure, not a chain failure.');
            log('    Find its action_index (explorer /{COIN}/api/contracts) and put it in ' + opts.state +
                ' as {"contractIndex": N} to resume without redeploying.');
            process.exit(1);
        }
        // VERIFY the index rather than trust the parse. Three settle shapes reach
        // contractIndexOf, and adopting a wrong one would point every later
        // EXECUTE at somebody else's contract. One read makes it a checked fact.
        try {
            const c = await sdk.explorer.getContract(contractIndex);
            const row = (c && (c.data || c)) || {};
            const kind = Array.isArray(row) ? (row[0] || {}) : row;
            if (kind && kind.action && kind.action !== 'DEPLOY')
                throw new Error('action_index ' + contractIndex + ' is a ' + kind.action + ', not a DEPLOY');
            log('  verified: action_index ' + contractIndex + ' reads back as a contract');
            // The resume path above finds this contract again by matching the
            // explorer's code_hash to the local file's sha256. If that ever
            // stops holding, the failure is silent and expensive (another
            // duplicate DEPLOY), so say so at the one moment both values are
            // in hand rather than discovering it on the next resume.
            const wantHash = codeHashOf(code);
            if (kind && kind.code_hash && String(kind.code_hash) !== wantHash)
                log('  ! WARNING: explorer code_hash ' + kind.code_hash + ' != sha256(source) ' + wantHash +
                    '; the chain-side resume lookup will NOT find this contract.');
        } catch (e) {
            log('  ! could not verify action_index ' + contractIndex + ' as a contract: ' + e.message);
            log('    Refusing to record it; re-run once the explorer has caught up.');
            process.exit(1);
        }
        state.contractIndex = contractIndex;
        state.deployTxid    = res.txid;
        writeState(opts.state, state);
        log('  ok, contract action_index ' + contractIndex + ', txid ' + res.txid);
        liveKeys = await countLiveKeys(sdk, contractIndex);
    }

    // -----------------------------------------------------------------------
    // 6. FILL to the target key count
    // -----------------------------------------------------------------------
    // WHERE THE FILL RESUMES FROM. `state.fillNext` is a CACHE and cannot be the
    // authority, for exactly the reason the DEPLOY step could not trust the state
    // file either: it is written AFTER the submit returns, so a run that
    // broadcasts a fill and then dies in the index wait - the NORMAL outcome on
    // testnet4, not an edge case - never records it, and the next run restarts at
    // 0 and rewrites the same keys with the same values.
    //
    // Measured on BTC:testnet 2026-08-06 rather than reasoned about: contract 6
    // carried 209 rows for 107 DISTINCT keys, with seed/bulk/0..99 written twice
    // and `seed/count` written three times, because two consecutive resumes both
    // started at 0. The live key count never moved, so the fill could never
    // finish; it would have run to the no-progress brake, paying for every round.
    //
    // The chain knows the answer, but not readably: the contract maintains
    // `seed/count` (= start + count, exactly the next start), and that key cannot
    // be fetched back - the explorer's state listing is paginated at 100 (total
    // 107, returned 100, `seed/count` not in the page) and a slash in a key
    // breaks the per-key route. What IS reliable is the live key count, which
    // countLiveKeys reads from `total` rather than from a page.
    //
    // So resume from the greater of the chain-derived position and the cache.
    // The max is the safe merge in both directions: the chain-derived value
    // prevents rewriting keys that already exist, and the cache covers the one
    // case where the chain-derived value is legitimately LOW - after step 7
    // tombstones a base key, live keys drop by one and the arithmetic would
    // otherwise walk backwards over keys already written. Overshooting only ever
    // writes new keys; undershooting rewrites paid-for ones.
    const chainDerivedStart = Math.max(0, liveKeys - SEED_BASE_KEYS);
    let start = Math.max(chainDerivedStart, Number(state.fillNext || 0));
    if (liveKeys < opts.keys) {
        if (start !== Number(state.fillNext || 0))
            log('  fill resumes at ' + start + ' (derived from the chain; the state file said ' +
                (state.fillNext === undefined ? 'nothing' : state.fillNext) + ')');
        step(6, 'EXECUTE fill to ' + opts.keys + ' keys');
        // TWO INDEPENDENT BRAKES, because this is the only loop here that
        // broadcasts, and its condition depends on a number read back over HTTP.
        // A miscount (pagination, a changed response shape, an explorer behind
        // the indexer) must not become an unbounded stream of paid transactions.
        //   - a hard iteration ceiling derived from the request itself; and
        //   - a no-progress detector, which catches ANY counting fault rather
        //     than the one already known about.
        const maxRounds = Math.ceil(opts.keys / opts.batch) + 3;
        let rounds = 0;
        while (liveKeys < opts.keys) {
            if (++rounds > maxRounds) {
                log('  STOPPING: ' + maxRounds + ' fill rounds ran and the live key count is still ' +
                    liveKeys + ' of ' + opts.keys + '. Something is miscounting rather than under-filling; ' +
                    'refusing to keep broadcasting. Check the explorer contract-state read.');
                process.exit(1);
            }
            const batch = Math.min(opts.batch, opts.keys - liveKeys);
            // NO gasLimit HERE, and it is not an oversight. EXECUTE has exactly one
            // wire format, `VERSION|CONTRACT_ACTION_INDEX|METHOD|...PARAMS`, with no
            // GAS_LIMIT slot; only DEPLOY carries one. Passing it does not get
            // ignored, it makes the action UNENCODABLE: the SDK's format selector
            // finds no version that can represent the field set and throws
            // NO_MATCHING_FORMAT. That is what killed the first fill to reach this
            // line, on BTC:testnet 2026-08-06, after the DEPLOY had already been
            // paid for. Execution gas is the protocol's business, not the caller's.
            const res = await submitChecked(
                { action: 'EXECUTE', params: {
                    contractActionIndex: contractIndex, method: 'fill',
                    params: ['seed/bulk/', String(start), String(batch)]
                } },
                txIo(address),
                submitOpts,
                'EXECUTE fill'
            );
            requireValid(res, 'EXECUTE fill');
            start += batch;
            state.fillNext = start;
            writeState(opts.state, state);
            const before = liveKeys;
            liveKeys = await countLiveKeys(sdk, contractIndex);
            log('  +' + batch + ' keys (live ' + before + ' -> ' + liveKeys + '), txid ' + res.txid);
            if (liveKeys <= before) {
                log('  STOPPING: that EXECUTE indexed valid but the live key count did not rise (' +
                    before + ' -> ' + liveKeys + '). Either the count is wrong or the writes are not ' +
                    'landing; both mean the next round would be broadcast blind.');
                process.exit(1);
            }
        }
    }

    // -----------------------------------------------------------------------
    // 7. TOMBSTONE
    // -----------------------------------------------------------------------
    if (!state.tombstoned) {
        step(7, 'EXECUTE remove seed/doomed');
        const res = await submitChecked(
            { action: 'EXECUTE', params: {
                contractActionIndex: contractIndex, method: 'remove',
                params: ['seed/doomed']   // no gasLimit: EXECUTE has no GAS_LIMIT slot, see step 6
            } },
            txIo(address),
            submitOpts,
            'EXECUTE remove'
        );
        requireValid(res, 'EXECUTE remove');
        state.tombstoned = true;
        writeState(opts.state, state);
        log('  ok, txid ' + res.txid + '  (this row now carries SQL-NULL state_value: the deletion tombstone)');
    }

    // -----------------------------------------------------------------------
    // 8. VERIFY
    // -----------------------------------------------------------------------
    step(8, 'verify');
    liveKeys = await countLiveKeys(sdk, contractIndex);
    log('  contract:        ' + contractIndex);
    log('  live state keys: ' + liveKeys);
    const finalMs = liveKeys * ARMING_MS_PER_KEY;
    log('  arming block will now cost roughly ' + (finalMs / 1000).toFixed(1) + ' s and ' +
        (liveKeys * ARMING_ROWS_PER_KEY).toLocaleString('en-US') + ' state_tree_nodes rows');
    if (Number.isInteger(H) && tip)
        log('  at the armed height ' + H + ' this chain will commit a REAL contract_state_root.');
    log('');
    log('# done. Verify the boundary at the crossing with:');
    log('#   node xchain-indexer/bin/verify-arming-boundary.js --chain ' + opts.chain +
        ' --network ' + opts.network);
    process.exit(0);

}

    // ASK THE CHAIN BEFORE DECLARING FAILURE. The index-wait above is a wall
    // clock, and on testnet4 the wall clock is the wrong instrument: miners ride
    // the 20-minute min-difficulty rule until the tip timestamp walks into the
    // future, and the chain then defers a block for up to two hours (see the
    // testnet4 stall write-up). A transaction that is broadcast, accepted and
    // simply not yet mined therefore trips CONFIRMATION_TIMEOUT and the tool
    // exits "FAILED: Timed out waiting for transaction ... to be indexed" for an
    // action that later confirms perfectly well. That message has now sent this
    // work in both directions: once reading a real failure as a stall, once
    // reading a success as a failure.
    //
    // The timeout is not evidence, so it no longer terminates on its own: on
    // CONFIRMATION_TIMEOUT we re-read the transaction from the explorer ONCE and
    // let the chain settle the question. Indexed with valid actions is a
    // success and the run continues from there; anything else re-throws the
    // original error unchanged, so a genuine failure still reads as one.
//
// The re-read itself goes through explorerField rather than reading tx.tx_hash
// and tx.actions off the top level: this recovery is the last thing standing
// between a real failure and a run that continues, and a top-level guess here
// would fail in the "absent" direction, which is the failure class this tool
// has already paid for twice (see explorerField's header).
function makeSubmitChecked(sdk, log, ledger) {
    const remember = (ledger && ledger.rememberPending) || (() => {});
    const forget   = (ledger && ledger.forgetPending)   || (() => {});
    return async function submitChecked(action, io, sopts, label) {
        // progress('waiting') is the broadcast boundary: the transaction is on
        // the wire and its fate is not yet known. Record it THERE, because that
        // is the only moment the txid exists and the outcome does not. A kill or
        // a timeout after this point leaves a trace the next run can resolve
        // instead of re-broadcasting blind.
        const withProgress = Object.assign({}, sopts, {
            onProgress: (step, data) => {
                if (step === 'waiting' && data && data.txid) remember(label, data.txid);
                if (sopts && typeof sopts.onProgress === 'function') sopts.onProgress(step, data);
            }
        });
        try {
            const res = await sdk.submitAction(action, io, withProgress);
            forget(label);
            return res;
        } catch (err) {
            if (!err || err.code !== 'CONFIRMATION_TIMEOUT') throw err;
            const txid = (err.details && err.details.txid) ||
                (String(err.message).match(/transaction ([0-9a-fA-F]{64})/) || [])[1];
            if (!txid) throw err;
            log('  ! index wait timed out for ' + label + '; re-reading tx ' + txid + ' from the chain');
            let tx = null;
            try { tx = await sdk.explorer.getTransaction(txid, 'tx_hash'); } catch (e) { tx = null; }
            const hash = explorerField(tx, 'tx_hash');
            if (!hash.found) {
                log('  ! the explorer still does not carry it; treating the timeout as real');
                throw err;
            }
            const actionsRead = explorerField(tx, 'actions');
            const blockRead   = explorerField(tx, 'block_index');
            const acts = Array.isArray(actionsRead.value) ? actionsRead.value : [];
            // Per-action status is prefixed: "valid" / "invalid: <reason>". An
            // action the indexer rejected is a failure whatever the clock said,
            // and so is one carrying NO status: the indexer not having written a
            // verdict is not the same as a verdict of valid.
            const bad = acts.filter(a => !/^valid\b/i.test(String((explorerField(a, 'status').value) || '')));
            if (!acts.length || bad.length) {
                log('  ! it is indexed but not valid (' +
                    (acts.length ? acts.map(a => explorerField(a, 'status').value).join(', ') : 'no actions') + ')');
                throw err;
            }
            const blockIndex = blockRead.found ? blockRead.value : undefined;
            log('  ok, it was indexed after all at block ' + blockIndex + ' (the timeout was the clock, not the chain)');
            // The chain has answered, so this is no longer in flight. Leaving it
            // recorded would make the NEXT run open with a spurious "in flight"
            // line for a transaction already known to have settled.
            forget(label);
            // Shaped as the SDK's own settled result, because the callers read
            // `res.indexed.status` (requireValid) and `res.indexed.actions`
            // (contractIndexOf). A bare `{ txid, actions }` would satisfy neither
            // and the recovery would fail a step it had just proven succeeded.
            return {
                txid,
                indexed: { status: 'valid', actions: acts, block_index: blockIndex },
                recheckedAfterTimeout: true
            };
        }
    };
}

if (require.main === module) {
    main().catch(err => {
        process.stderr.write('FAILED: ' + (err && err.message ? err.message : String(err)) + '\n');
        process.exit(1);
    });
}

module.exports = {
    contractIndexOf, coinPrefix, countLiveKeys, loadChunkHelper, makeSubmitChecked,
    explorerField, isExplorerError, EXPLORER_ENVELOPES,
    codeHashOf, findDeployedContract, resolveContractIndex,
    // requireValid is exported for the tests: "the run continues" after a
    // timeout recovery means the NEXT thing every step does with the result
    // does not throw, and that thing is this.
    requireValid,
    // Exported so seed-escrow-state.js pins the fee rate through the SAME
    // resolver rather than a copy that can drift out of agreement with it.
    resolveFeeRate
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// An action the indexer accepted is the only kind that counts. submitAction
// resolves on CONFIRMATION, not on validity, so a rejected action comes back as
// a resolved promise carrying `indexed.status === 'invalid'`; treating that as
// success is how a seed run "succeeds" and leaves the chain empty.
function requireValid(res, what) {
    const status = res && res.indexed && res.indexed.status;
    if (status !== 'valid') {
        const why = (res && res.indexed && (res.indexed.error || res.indexed.message)) || 'no reason given';
        throw new Error(what + ' indexed ' + status + ': ' + why);
    }
}

// ---------------------------------------------------------------------------
// THE EXPLORER RETURNS DOCUMENTS, NOT SCALARS, AND A TOP-LEVEL GUESS READS AS
// "ABSENT" RATHER THAN FAILING .
//
// This tool has now paid for that mistake twice, in two different fields:
//
//   - `last_block` is a MAP keyed by coin prefix (TBTC, RLTC, ...), not a
//     number. Read as a scalar it yields null, and the runway line the
//     preflight exists to produce silently vanishes.
//   - the token document nests identity under `info` and carries NO top-level
//     `tick`, so `!!(token.tick || token.TICK)` is false for every token that
//     EXISTS. The preflight announced "DOES NOT EXIST" against a live token and
//     the run broadcast a second ISSUE (BTC:testnet, 2026-08-04).
//
// Both bugs share one shape: a guess at the top level, a falsy result, and a
// caller that cannot tell "the explorer does not carry this" from "I looked in
// the wrong place". Nothing throws, so nothing gets caught until a paid
// transaction is on the chain.
//
// explorerField is the general form. It looks at the top level AND inside the
// envelopes the explorer actually uses, case-insensitively, and it reports
// enough for the caller to tell the two cases apart:
//
//   document  the explorer returned SOMETHING (a non-empty object). false means
//             null / {} / a scalar: genuinely nothing to read.
//   found     the field was located, with `value` and `at` (its real path).
//   surprise  a type mismatch worth saying out loud, e.g. a map-valued read
//             (opts.key) that met a scalar.
//
// `document && !found` is the case that used to be invisible: the explorer
// answered, and the field this tool depends on is nowhere in its answer. That
// is a shape change, and callers here treat it as a blocker rather than as an
// absence, because guessing "absent" is what re-ISSUEd a token that existed.
//
// EXPLORER_ENVELOPES is declared with the other constants at the top of the
// file, not here: `module.exports` sits above this block and a const declared
// here is in its temporal dead zone when the module body runs.
function explorerField(doc, name, opts) {
    opts = opts || {};
    const envelopes = opts.envelopes || EXPLORER_ENVELOPES;
    const key = Object.prototype.hasOwnProperty.call(opts, 'key') ? opts.key : null;
    const out = { document: false, found: false, value: undefined, at: null, surprise: null };
    if (doc === null || doc === undefined || typeof doc !== 'object') return out;

    // A list of documents is not a document: there is no single field to read,
    // and picking rows[0] is exactly the kind of guess this helper exists to
    // stop. Say so rather than returning a quiet "absent".
    if (Array.isArray(doc)) {
        out.document = doc.length > 0;
        if (out.document) out.surprise = 'the explorer returned a list of ' + doc.length +
            ' documents, so there is no single `' + name + '` to read';
        return out;
    }
    if (Object.keys(doc).length === 0) return out;
    out.document = true;

    const holders = [{ path: '', obj: doc }];
    for (const env of envelopes) {
        const sub = doc[env];
        if (sub && typeof sub === 'object' && !Array.isArray(sub)) holders.push({ path: env + '.', obj: sub });
    }
    for (const h of holders) {
        const hit = pickKey(h.obj, name);
        if (!hit) continue;
        const at = h.path + hit.key;
        if (key === null) {
            // Present-but-null is not a value: keep looking in the envelopes
            // rather than reporting a null as found.
            if (hit.value === null || hit.value === undefined) continue;
            out.found = true; out.value = hit.value; out.at = at;
            return out;
        }
        // A map-valued field (last_block and friends), indexed by opts.key.
        if (hit.value && typeof hit.value === 'object' && !Array.isArray(hit.value)) {
            const entry = key === null ? undefined : hit.value[key];
            if (entry === undefined || entry === null) { out.at = at; continue; }
            out.found = true; out.value = entry; out.at = at + '.' + key;
            return out;
        }
        // A scalar where a map was expected is the `last_block` bug inverted,
        // and it must not read as a plain absence.
        out.surprise = '`' + at + '` is a ' + (hit.value === null ? 'null' : typeof hit.value) +
            ', not the per-key map this read indexes by "' + key + '"';
    }
    return out;
}

// Case-insensitive single-level field pick. `tick` / `TICK` are both live in
// explorer responses depending on the endpoint, and the tool must not care.
function pickKey(obj, name) {
    if (Object.prototype.hasOwnProperty.call(obj, name)) return { key: name, value: obj[name] };
    const lower = String(name).toLowerCase();
    for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return { key: k, value: obj[k] };
    return null;
}

// An explorer answer that is only an error is an ABSENCE, not a shape change.
// Without this, a 200-with-{error:...} body (the explorer does this for some
// not-found paths) would trip the shape blocker and stop a run that has nothing
// wrong with it.
function isExplorerError(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
    return explorerField(doc, 'error').found || explorerField(doc, 'errors').found;
}

// The explorer's per-coin key: mainnet is bare, testnet 'T', regtest 'R'. Same
// mapping the SDK's endpoints.coinPrefix applies to a network string; spelled
// out here because this tool already has the chain and network as separate args.
function coinPrefix(chain, network) {
    const p = { mainnet: '', testnet: 'T', regtest: 'R' }[network];
    return p === undefined ? null : p + chain;
}

// WIF -> p2pkh address, through the SDK's own wallet so the network params come
// from the same place the signer will use. A mismatch here would otherwise show
// up much later as an unsignable PSBT.
function addressOf(sdk, wif) {
    const kp = sdk.importWIF(wif);
    return sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' });
}

// The contract's action_index out of a settled submitAction result.
//
// There is no single shape to match, which is why the first draft of this (a
// chain of top-level `||` guesses) returned null for ALL of them and would have
// aborted the run after a paid DEPLOY. `actionWaiter` settles from three places:
//   - the POLL path, with the full action set as `actions[]`;
//   - the WebSocket NEW_ACTION path, with ONE action row;
//   - `explorer.getAction`, likewise one row.
// Only the first carries `actions`, and none carries a top-level
// `contract_action_index`.
//
// In the array case find the DEPLOY EXPLICITLY rather than taking actions[0]:
// a constructor that emits (emit.issue and friends) lands siblings in the same
// transaction and they can sort first. spvSeed's initialize emits nothing, so
// this is defensive here, but the helper should not be the thing that breaks
// when someone changes the contract.
function contractIndexOf(indexed) {
    if (!indexed) return null;
    if (Array.isArray(indexed.actions)) {
        const d = indexed.actions.find(a => a && a.action === 'DEPLOY') || indexed.actions[0] || null;
        return (d && d.action_index != null) ? d.action_index : null;
    }
    if (indexed.action_index != null) {
        // A single row that is demonstrably NOT the DEPLOY is worse than nothing:
        // adopting it would point every later EXECUTE at the wrong contract.
        if (indexed.action && indexed.action !== 'DEPLOY') return null;
        return indexed.action_index;
    }
    return null;
}

// The sha256 the explorer publishes as a contract's `code_hash`, computed from
// the local source. Measured against BTC:testnet action_index 6 rather than
// assumed: sha256(bin/contracts/spvSeed.js) is f304ab58... and so is the
// explorer's code_hash for the DEPLOY that carried it.
function codeHashOf(code) {
    return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

// Resolve an ALREADY-DEPLOYED spvSeed contract from the chain, so the local
// state file cannot be the only thing standing between a resume and a duplicate
// DEPLOY.
//
// Matched by CONTENT, not by bookkeeping: the deploying address is queried
// (`/contracts/{address}/source`, an exact query with no pagination to get
// wrong on the small address this tool spends from) and the rows are filtered
// to valid DEPLOYs whose `code_hash` equals this file's own sha256. The address
// alone would not do, because it is free to deploy other contracts, and matching
// those would point every later EXECUTE at somebody else's code.
//
// Returns the LOWEST matching action_index so a chain that already carries
// duplicates resolves to the same contract on every subsequent run rather than
// drifting between them. Returns null when nothing matches, which is the honest
// "deploy it" answer; it never guesses.
// The state file is a cache in BOTH directions, and only one of them used to be
// handled. A cached index that the chain has never heard of is just as wrong as
// a missing one, and it is what a re-genesised chain produces: on 2026-08-10
// BTC:testnet's firstBlock moved from 138000 to 147500, so the contract this
// file remembered at action_index 6 (deployed in block 147007) stopped existing
// as far as the indexer is concerned. Trusting the file then produced a plan of
// ISSUE, MINT, three EXECUTE fills and a tombstone with NO DEPLOY in it, aimed
// at an index the chain does not carry: every one of those EXECUTEs would have
// been broadcast and paid for and none could have taken effect.
//
// So the chain is asked unconditionally and the file only ever contributes a
// hint worth reporting. A lookup that ERRORS still throws rather than reading as
// "not deployed", because that distinction is what stops a duplicate DEPLOY.
async function resolveContractIndex(sdk, code, address, state, log, statePath) {
    const cached = state && state.contractIndex ? Number(state.contractIndex) : null;
    const onChain = await findDeployedContract(sdk, code, address);

    if (onChain && cached && onChain !== cached) {
        log('  contract:          action_index ' + onChain + ' (found ON CHAIN by code_hash)');
        log('  ! ' + statePath + ' remembered action_index ' + cached + ', which is NOT what the');
        log('    chain carries. The chain wins; the file is being corrected.');
        return onChain;
    }
    if (onChain) {
        log('  contract:          action_index ' + onChain + ' (found ON CHAIN by code_hash' +
            (cached ? ', confirming ' + statePath : '') + ')');
        return onChain;
    }
    if (cached) {
        log('  contract:          not deployed on this chain');
        log('  ! ' + statePath + ' remembered action_index ' + cached + ' and the chain does not');
        log('    carry it, so that record is STALE and is being discarded. A re-genesis or a');
        log('    reindex below the deploy height does exactly this. The plan below therefore');
        log('    includes a fresh DEPLOY rather than executing against an index that is gone.');
        return null;
    }
    log('  contract:          not deployed yet');
    return null;
}

async function findDeployedContract(sdk, code, address) {
    const want = codeHashOf(code);
    // A lookup that FAILS is not a lookup that found nothing. Swallowing the
    // error here would make an explorer blip indistinguishable from "no contract
    // yet" and produce exactly the duplicate DEPLOY this function exists to
    // prevent, so it throws and the caller refuses to plan.
    let rows;
    try {
        const res = await sdk.explorer.getContracts(address, 'source');
        rows = (res && (res.data || res)) || [];
    } catch (e) {
        const err = new Error('contract lookup by source address failed: ' + e.message);
        err.code = 'CONTRACT_LOOKUP_FAILED';
        throw err;
    }
    if (!Array.isArray(rows)) return null;
    const matches = rows
        .filter(r => r && String(r.status) === 'valid' && String(r.action) === 'DEPLOY')
        .filter(r => String(r.code_hash || '') === want)
        .map(r => Number(r.action_index))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => a - b);
    if (!matches.length) return null;
    if (matches.length > 1)
        log('  ! this chain carries ' + matches.length + ' contracts with identical code: ' +
            matches.join(', ') + '. Using the first.');
    return matches[0];
}

// LIVE keys, which is what the arming build pays for.
//
// READ `total`, NOT `rows.length`. The explorer's contract-state query is
// PAGINATED (`... LIMIT sql.limit`, defaulting to a per-method cap) and returns
// the true count separately as `total`. Counting the returned array saturates at
// the page size, and this number drives a `while (liveKeys < target)` loop, so a
// target above the page size would have meant broadcasting EXECUTEs forever
// against a count that could never rise. On a public chain that is real money
// and real spam, which is why the loop below ALSO refuses to trust this function.
async function countLiveKeys(sdk, contractIndex) {
    try {
        const st = await sdk.explorer.getContractState(contractIndex);
        if (st && st.total !== undefined && Number.isFinite(Number(st.total)))
            return Number(st.total);
        const rows = (st && (st.data || st.state || st)) || [];
        if (Array.isArray(rows)) return rows.length;
        if (rows && typeof rows === 'object') return Object.keys(rows).length;
        return 0;
    } catch (e) {
        return 0;
    }
}
