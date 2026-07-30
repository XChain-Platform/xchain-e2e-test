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
 *   --gas-mint-start <n>      default 1            (genesis pins a far-future sentinel)
 *
 * EXIT: 0 done or plan printed, 1 a step failed, 2 cannot run (missing key,
 * missing funds, chain already past its armed height).
 *
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

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

function loadSDK() {
    const candidates = ['xchain-sdk', '../../xchain-sdk', '../../../xchain-sdk'];
    let lastErr = null;
    for (const c of candidates) {
        try { return require(c); } catch (e) { lastErr = e; }
    }
    throw new Error('cannot resolve xchain-sdk: ' + (lastErr && lastErr.message));
}

function parseArgs() {
    const a = process.argv.slice(2);
    const o = {
        chain: 'BTC', network: 'testnet', keys: 250, batch: 100,
        budgetFraction: 0.10, broadcast: false, force: false,
        confirmGasIssue: false,
        gasDecimals: 8, gasMaxSupply: 100000000, gasMaxMint: 100000, gasMintStart: 1,
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

(async () => {
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
    const submitOpts = { wif, waitForIndexer: true, timeout: 1800000, pollInterval: 15000 };

    log('# seed contract state on ' + opts.chain + '/' + opts.network);
    log('# mode: ' + (opts.broadcast ? 'BROADCAST' : 'PLAN ONLY (no transaction is sent)'));

    // -----------------------------------------------------------------------
    // 1. PREFLIGHT
    // -----------------------------------------------------------------------
    step(1, 'preflight');

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
    // the number this preflight exists to produce, just vanishes.
    let tip = null;
    try {
        const st     = await sdk.explorer.getStatus();
        const prefix = coinPrefix(opts.chain, opts.network);
        const pick   = m => (m && prefix && m[prefix] != null) ? Number(m[prefix]) : null;
        tip = pick(st && st.last_block) || pick(st && st.decoder_tip) || null;
        if (tip === null) log('  ! explorer status carried no tip for ' + prefix);
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
    let gasToken = null;
    try { gasToken = await sdk.explorer.getToken(gasTick); } catch (e) { gasToken = null; }
    const gasExists = !!(gasToken && (gasToken.tick || gasToken.TICK));
    log('  gas token ' + gasTick + ':   ' + (gasExists ? 'exists' : 'DOES NOT EXIST on this chain'));

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
            const g = rows.find(r => String(r.tick || r.TICK).toUpperCase() === gasTick);
            if (g) gasBalance = String(g.amount || g.quantity || g.balance || '0');
        }
        log('  gas balance:       ' + gasBalance + ' ' + gasTick);
    } catch (e) {
        log('  ! balance lookup failed: ' + e.message);
    }

    // Contract, if a previous run deployed one.
    let contractIndex = state.contractIndex || null;
    let liveKeys = 0;
    if (contractIndex) {
        log('  contract:          action_index ' + contractIndex + ' (from ' + opts.state + ')');
        liveKeys = await countLiveKeys(sdk, contractIndex);
        log('  live state keys:   ' + liveKeys);
    } else {
        log('  contract:          not deployed yet');
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
    if (!gasExists && !gasWif) blockers.push(
        'the gas token does not exist on this chain and XC_SEED_GAS_WIF is not set. Off regtest ' +
        'only the configured GAS address may issue it (xchain-indexer/src/actions/issue.js), so ' +
        'this step cannot be done with the working key.');
    if (utxoTotal === 0) blockers.push(
        'the working address holds no confirmed funding utxos. Fund ' + address + ' before broadcasting.');
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
        const res = await sdk.submitAction(
            { action: 'ISSUE', params: {
                tick: gasTick, amount: 0,
                decimals:       opts.gasDecimals,
                maxSupply:      opts.gasMaxSupply,
                maxMint:        opts.gasMaxMint,
                mintStartBlock: opts.gasMintStart,
                description:    'XChain gas token'
            } },
            { pubkey: gasAddress, change: gasAddress },
            Object.assign({}, submitOpts, { wif: gasWif })
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
        const res = await sdk.submitAction(
            { action: 'MINT', params: { tick: gasTick, amount: 100000, destination: address } },
            { pubkey: address, change: address },
            submitOpts
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
        const res = await sdk.submitAction(
            { action: 'DEPLOY', params: { code, gasLimit: 500000 } },
            { pubkey: address, change: address },
            submitOpts
        );
        requireValid(res, 'DEPLOY');
        contractIndex = contractIndexOf(res.indexed);
        if (!contractIndex) { log('  ! deploy indexed valid but no contract action_index was returned'); process.exit(1); }
        state.contractIndex = contractIndex;
        state.deployTxid    = res.txid;
        writeState(opts.state, state);
        log('  ok, contract action_index ' + contractIndex + ', txid ' + res.txid);
        liveKeys = await countLiveKeys(sdk, contractIndex);
    }

    // -----------------------------------------------------------------------
    // 6. FILL to the target key count
    // -----------------------------------------------------------------------
    let start = state.fillNext || 0;
    if (liveKeys < opts.keys) {
        step(6, 'EXECUTE fill to ' + opts.keys + ' keys');
        while (liveKeys < opts.keys) {
            const batch = Math.min(opts.batch, opts.keys - liveKeys);
            // Gas: VM_EXECUTE_BASE + VM_STATE_WRITE per key, with headroom for
            // the seed/count write and the metering the VM adds around it.
            const gasLimit = 20000 + batch * 400;
            const res = await sdk.submitAction(
                { action: 'EXECUTE', params: {
                    contractActionIndex: contractIndex, method: 'fill',
                    params: ['seed/bulk/', String(start), String(batch)], gasLimit
                } },
                { pubkey: address, change: address },
                submitOpts
            );
            requireValid(res, 'EXECUTE fill');
            start += batch;
            state.fillNext = start;
            writeState(opts.state, state);
            const before = liveKeys;
            liveKeys = await countLiveKeys(sdk, contractIndex);
            log('  +' + batch + ' keys (live ' + before + ' -> ' + liveKeys + '), txid ' + res.txid);
        }
    }

    // -----------------------------------------------------------------------
    // 7. TOMBSTONE
    // -----------------------------------------------------------------------
    if (!state.tombstoned) {
        step(7, 'EXECUTE remove seed/doomed');
        const res = await sdk.submitAction(
            { action: 'EXECUTE', params: {
                contractActionIndex: contractIndex, method: 'remove',
                params: ['seed/doomed'], gasLimit: 20000
            } },
            { pubkey: address, change: address },
            submitOpts
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

})().catch(err => {
    process.stderr.write('FAILED: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exit(1);
});

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

function contractIndexOf(indexed) {
    if (!indexed) return null;
    return indexed.contract_action_index || indexed.contractActionIndex ||
           indexed.action_index || indexed.actionIndex || null;
}

// LIVE keys, which is what the arming build pays for: rows whose latest value is
// not a tombstone. The explorer's contract-state read already filters tombstones
// out (it reconstructs live state the way the VM sees it), so its row count IS
// the live count and no second rule is applied here.
async function countLiveKeys(sdk, contractIndex) {
    try {
        const st = await sdk.explorer.getContractState(contractIndex);
        const rows = (st && (st.data || st.state || st)) || [];
        if (Array.isArray(rows)) return rows.length;
        if (rows && typeof rows === 'object') return Object.keys(rows).length;
        return 0;
    } catch (e) {
        return 0;
    }
}
