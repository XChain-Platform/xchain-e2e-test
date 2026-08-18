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
 * Seed a live chain with real LOCKED BALANCES ahead of its armed escrow-leaf
 * height (see the SPV state-subtree extension spec, §3 Stage B).
 *
 * WHY THIS EXISTS. This is Stage B's counterpart to seed-contract-state.js, and
 * the reasoning is the same one §3 gives for Stage A: a chain whose lockers hold
 * nothing commits an EMPTY leaf into `balances_root`, and §2 makes an empty leaf
 * byte-identical to an absent one. So the arming block proves the version flip
 * and nothing about the derivation, the journal, the replication or the proof.
 * BTC:regtest has real escrows and has proved all four. No public chain has.
 *
 * WHAT AN ESCROW ACTUALLY IS HERE, because it decides the whole design. There is
 * no "escrow" action. Escrows are a SIDE EFFECT of ORDER, SWAP and DISPENSER
 * (xchain-indexer/src/utility.js prices the premium for exactly those three, and
 * processTransactionLedgerChanges writes the `escrows` rows). The cheapest,
 * longest-lived seed is therefore ONE POSTED ORDER THAT NEVER MATCHES: order.js
 * pushes [GIVE_TICK, GIVE_AMOUNT, SOURCE] into escrows the moment the create
 * indexes valid, with no counterparty required and nothing to settle. The lock
 * then stands until the order is cancelled, matched or expires.
 *
 *   GIVE  the gas token, which every seeded chain already has.
 *   GET   the native coin, at an ask nobody will ever fill.
 *
 * Native-coin GET is deliberate: it needs no second token to exist, and
 * order.js's "cannot trade native coin for native coin" guard only fires when
 * BOTH sides are native, so a token GIVE against a native GET is a valid,
 * ordinary, permanently-unmatched maker order.
 *
 * THE LEAF IS NOT THE `escrows` LEDGER, AND THIS TOOL DOES NOT PRETEND OTHERWISE.
 * `escrowLeafSubtree.js` reads `escrow_leaf_journal` and never the live tables,
 * because the ledger is a per-tick CONSERVATION ledger: of its 26 write sites,
 * nine key releases to whoever RECEIVES the funds, so SUM(escrows) per (address,
 * tick) is stale-positive for the locker and negative for the recipient. On a
 * seeded address that only ever LOCKS, the two happen to agree, which is exactly
 * why reading the ledger here would be a comfortable mistake. The verify step
 * reports the ledger sum as CORROBORATION and reports the journal separately.
 *
 * AND THE JOURNAL IS WRITTEN ONLY WHEN THE CHAIN IS ARMED OR SHADOWING.
 * computeAndStoreRoots calls the journal writer under
 * `isEscrowLockedLeafActive(...) || isEscrowLockedLeafShadowActive(...)` and not
 * otherwise. So on a chain with neither, this tool can seed perfect locked
 * balances and `escrow_leaf_journal` stays EMPTY, `XCHAIN_ESC` stays empty, and
 * nothing downstream moves. That is not a defect in the seed and it is not
 * something a later step fixes by accident: it is a separate operator act, and
 * the preflight says so in as many words rather than letting a green run imply
 * otherwise. Seeding first is still correct - the arming (or window-start)
 * block replays the whole ledger from history, so positions opened BEFORE it
 * land in the journal at that block.
 *
 * IT DOES NOT BROADCAST BY DEFAULT, and it never creates the gas token.
 * Creating XCHAIN is a once-per-chain irreversible act whose parameters are the
 * operator's (it is why seed-contract-state.js gates step 2 behind
 * --confirm-gas-issue, and why this spec banked dq6). Two tools that can both do
 * it is two places to get it wrong, so this one refuses and names the other.
 *
 * KEYS COME FROM THE ENVIRONMENT, NEVER FROM ARGV.
 *   XC_SEED_WIF   working address: pays miner fees, holds and locks the gas token
 * It is never printed, logged or written to the state file.
 *
 * USAGE
 *   # what would happen, and what is missing (reads only)
 *   XC_SEED_WIF=... node bin/seed-escrow-state.js --chain BTC --network testnet
 *
 *   # do it
 *   XC_SEED_WIF=... node bin/seed-escrow-state.js --chain BTC --network testnet \
 *       --orders 3 --lock 100 --broadcast
 *
 * BTC ONLY, for the same reason seed-contract-state.js is: LTC and DOGE pay the
 * protocol fee in the native coin and this tool attaches no FEE_DESTINATION
 * output, so every ORDER it built would be broadcast, mined, and THEN indexed
 * `invalid: insufficient fee (native coin output required)`. Refused up front.
 *
 * OPTIONS
 *   --chain <COIN>            default BTC (the only supported value)
 *   --network <net>           default testnet
 *   --orders <n>              target count of OPEN seed orders, default 3
 *   --lock <n>                gas units each order locks, default 100
 *   --ask <n>                 native-coin GET_AMOUNT per order, default 1000
 *                             (an ask nobody fills; it only has to be positive)
 *   --expiration-days <n>     default 89. Above UNIFIED_EXPIRATION_FEE_FREE_DAYS
 *                             (90) every extra day costs gas, so this refuses
 *                             past the free window unless --force.
 *   --encoder-url / --encoder-port / --explorer-url / --explorer-port
 *   --state <path>            resume file, default ./.seed-escrow-<COIN>-<net>.json
 *   --broadcast               actually send
 *   --force                   proceed past the expiration-window refusal
 *   --clear-pending           discard a recorded broadcast the chain never took
 *
 * EXIT: 0 done or plan printed, 1 a step failed, 2 cannot run (missing key,
 * missing funds, missing gas token), 3 a broadcast is still unconfirmed.
 *
 *********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
// Only for identifying the activation module the gate resolved to; see
// escrowLeafGate for why a path alone is not enough.
const crypto = require('crypto');

// SHARED WITH seed-contract-state.js BY REQUIRE, NOT BY COPY, and that is a
// decision rather than convenience. Every one of frontier rows 14, 15, 16, 18
// and 26 was a defect in this exact machinery - the pending ledger, the
// index-wait recovery, the explorer field reads - and each was fixed once. A
// forked copy is five fixes that silently stop applying to half the seeding
// work. That file guards its own CLI entry with require.main, so requiring it
// here runs nothing.
const SEED = require('./seed-contract-state.js');
const { makeSubmitChecked, explorerField, isExplorerError, requireValid } = SEED;
// The fee-rate resolver is shared for the same reason the pending ledger is:
// create_tx's unguarded use of the node estimate hits an ORDER exactly as it
// hits a DEPLOY, and a second copy is a second thing to forget to pin.
const { resolveFeeRate } = SEED;

// The protocol gas token, named here for the same reason seed-contract-state.js
// names it: the SDK carries no copy and reading it from a service risks reading
// it from one on older config.
const GAS_TICK = 'XCHAIN';

// Free expiration window, xchain-hub/src/coins/BTC.js
// UNIFIED_EXPIRATION_FEE_FREE_DAYS. getUnifiedDurationFee charges only when the
// duration is STRICTLY greater, so 90 is free and 91 is not.
const EXPIRATION_FREE_DAYS = 90;

// Gas held back for fees rather than locked. Each ORDER pays a create fee out of
// the same balance the order locks, so a seed that locks everything cannot pay
// for its own last order. Sized well above the schedule's ORDER cost because the
// cost of being wrong is a half-finished seed on a chain with 10-minute blocks.
const GAS_FEE_HEADROOM = 500;

function loadSDK() {
    const candidates = ['xchain-sdk', '../../xchain-sdk', '../../../xchain-sdk'];
    let lastErr = null;
    for (const c of candidates) {
        try { return require(c); } catch (e) { lastErr = e; }
    }
    throw new Error('cannot resolve xchain-sdk: ' + (lastErr && lastErr.message));
}

// The escrow-leaf gate, read out of the indexer's own activation module rather
// than passed in, so this tool cannot be pointed at a height nobody armed. Both
// halves are returned because they have different consequences and only their
// UNION decides whether the journal is being written at all.
//
// IT ALSO NAMES THE FILE IT READ, AND HASHES IT, because the sibling it resolves
// is whatever happens to sit beside the tool and that is not always what the
// fleet runs. Measured on 2026-08-15: the production seed venue carries a FLAT
// staged copy of xchain-indexer whose map still read `ESCROW_LOCKED_LEAF_SHADOW
// = {}`, while the BTC:testnet indexer it was seeding had been deployed with
// `{'BTC:testnet': 148000}` and the chain was already 500+ blocks past it. The
// preflight therefore printed `shadow window: none` and the NOTE below it,
// which says in as many words that the journal will stay EMPTY - the exact
// opposite of the truth, and an argument for arming first, which is the one
// ordering dq1 exists to prevent. Nothing was wrong with the map, the code or
// the chain; the tool simply could not see WHICH copy answered.
//
// A path plus a sha256 makes that visible and hash-matchable against the
// deployed indexer (`docker exec <indexer> sha256sum
// /XChainIndexer/src/state_subtree_activation.js`), which is the check this
// project already applies to every staged module. It is deliberately NOT a
// refusal: the tool cannot reach the fleet to know the right hash, so it
// reports what it read and leaves the comparison to the operator.
function escrowLeafGate(chain, network) {
    const candidates = [
        '../../xchain-indexer/src/state_subtree_activation.js',
        '../../../xchain-indexer/src/state_subtree_activation.js',
    ];
    for (const c of candidates) {
        const abs = path.resolve(__dirname, c);
        try {
            const SUB = require(abs);
            const key = chain + ':' + network;
            const armed  = SUB.ESCROW_LOCKED_LEAF_ACTIVATION[key];
            const shadow = SUB.ESCROW_LOCKED_LEAF_SHADOW[key];
            // Hashed AFTER the require succeeds, so the hash always describes the
            // file whose values are being reported rather than a candidate that
            // failed to load.
            let sha = null;
            try {
                sha = crypto.createHash('sha256')
                    .update(fs.readFileSync(abs)).digest('hex');
            } catch (e) { /* unreadable after require is not worth failing on */ }
            return {
                resolved: true,
                source: abs,
                sha256: sha,
                armed:  armed  === undefined ? null : Number(armed),
                shadow: shadow === undefined ? null : Number(shadow),
            };
        } catch (e) { /* try the next layout */ }
    }
    return { resolved: false, source: null, sha256: null, armed: null, shadow: null };
}

function parseArgs() {
    const a = process.argv.slice(2);
    const o = {
        chain: 'BTC', network: 'testnet',
        orders: 3, lock: 100, ask: 1000, expirationDays: 89,
        broadcast: false, force: false, clearPending: false,
    };
    for (let i = 0; i < a.length; i++) {
        switch (a[i]) {
            case '--chain':            o.chain = String(a[++i]).toUpperCase(); break;
            case '--network':          o.network = a[++i]; break;
            case '--orders':           o.orders = parseInt(a[++i], 10); break;
            case '--lock':             o.lock = parseInt(a[++i], 10); break;
            case '--ask':              o.ask = parseInt(a[++i], 10); break;
            case '--expiration-days':  o.expirationDays = parseInt(a[++i], 10); break;
            case '--encoder-url':      o.encoderUrl = a[++i]; break;
            case '--encoder-port':     o.encoderPort = parseInt(a[++i], 10); break;
            case '--explorer-url':     o.explorerUrl = a[++i]; break;
            case '--explorer-port':    o.explorerPort = parseInt(a[++i], 10); break;
            case '--state':            o.state = a[++i]; break;
            case '--broadcast':        o.broadcast = true; break;
            case '--force':            o.force = true; break;
            case '--clear-pending':    o.clearPending = true; break;
            case '--fee-per-kb':       o.feePerKb = parseInt(a[++i], 10); break;
            case '--help': case '-h':
                process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0] + '\n');
                process.exit(0);
                break;
            default:
                process.stderr.write('unknown arg: ' + a[i] + '\n');
                process.exit(64);
        }
    }
    if (!Number.isInteger(o.orders) || o.orders < 1) fail64('--orders must be a positive integer');
    if (!Number.isInteger(o.lock)   || o.lock   < 1) fail64('--lock must be a positive integer');
    if (!Number.isInteger(o.ask)    || o.ask    < 1) fail64('--ask must be a positive integer');
    if (!Number.isInteger(o.expirationDays) || o.expirationDays < 1)
        fail64('--expiration-days must be a positive integer');
    if (!o.state) o.state = path.join(process.cwd(), '.seed-escrow-' + o.chain + '-' + o.network + '.json');
    return o;
}

function fail64(msg) { process.stderr.write(msg + '\n'); process.exit(64); }

function log(msg)  { process.stdout.write(msg + '\n'); }
function step(n, msg) { log(''); log('== ' + n + '. ' + msg); }

// Resume file. Public facts only; no key material ever reaches it.
function readState(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}
function writeState(p, s) {
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}

// Rows out of a `{ data: [...], total: n }` explorer list. The list routes answer
// with that envelope and NOT with a bare array, so a caller that treats the
// response as iterable silently sees zero rows - which for this tool would mean
// "no orders exist yet" and a duplicate broadcast every run.
function listRows(doc) {
    if (Array.isArray(doc)) return doc;
    if (!doc || typeof doc !== 'object') return [];
    for (const k of ['data', 'results', 'rows']) if (Array.isArray(doc[k])) return doc[k];
    return [];
}

// An order still holding its escrow. Deliberately a NEGATIVE test rather than a
// positive one: the statuses that RELEASE the lock are the closed set (filled,
// cancelled, expired), while the ones that hold it include the transitional
// warts the journal writer's header calls out - 'cancelling' and 'expiring' hold
// escrow, because no release row has been written yet. Enumerating the holding
// states positively would drop those and undercount, and undercounting here
// means broadcasting orders that are already there.
const RELEASED_STATUSES = ['filled', 'cancelled', 'canceled', 'expired', 'invalid', 'closed', 'matched'];
function holdsEscrow(row) {
    const s = explorerField(row, 'status');
    if (!s.found) return false;
    return !RELEASED_STATUSES.includes(String(s.value).toLowerCase());
}

// A seed order is one THIS tool would post: our own address giving the gas tick.
// Matching on the give side rather than on a memo keeps the identification in
// the same place the escrow is: an order that locks something else is not this
// tool's, and must not be counted toward its target or cancelled by it.
function isSeedOrder(row, gasTick) {
    const give = explorerField(row, 'give_tick');
    return give.found && String(give.value).toUpperCase() === String(gasTick).toUpperCase();
}

async function main() {
    const opts  = parseArgs();
    const state = readState(opts.state);
    const { XChainSDK } = loadSDK();

    const wif = process.env.XC_SEED_WIF || null;
    if (!wif) {
        process.stderr.write('XC_SEED_WIF is required (the working address key). ' +
                             'Set it in the environment; never pass a WIF on the command line.\n');
        process.exit(2);
    }

    const chainName = { BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin' }[opts.chain];
    if (!chainName) fail64('unsupported --chain ' + opts.chain);

    // GAS-MODE CHAINS ONLY. Same refusal, same reasoning, as
    // seed-contract-state.js: on LTC and DOGE a top-level fee-paying action with
    // no FEE_DESTINATION output is indexed invalid AFTER being mined and paid
    // for, which on a slow chain is discovered an hour later.
    if (opts.chain !== 'BTC') {
        process.stderr.write(
            opts.chain + ' pays its protocol fee in the native coin, and this tool does not attach a\n' +
            'FEE_DESTINATION output, so every ORDER it built would index as\n' +
            '"invalid: insufficient fee (native coin output required)" AFTER being paid for and mined.\n' +
            'Only BTC (gas-mode, fees in ' + GAS_TICK + ') is supported. Refusing rather than wasting coin.\n');
        process.exit(2);
    }

    if (opts.expirationDays > EXPIRATION_FREE_DAYS && !opts.force) {
        process.stderr.write(
            '--expiration-days ' + opts.expirationDays + ' exceeds the free window (' +
            EXPIRATION_FREE_DAYS + ' days, UNIFIED_EXPIRATION_FEE_FREE_DAYS).\n' +
            'Every day past it is charged at EXPIRATION_PER_DAY against the same gas balance the\n' +
            'orders lock, so a long seed can run itself out of gas mid-run. Pass --force if you\n' +
            'have decided this venue can afford it.\n');
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

    const address = addressOf(sdk, wif);

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

    const submitOpts    = { wif, waitForIndexer: true, timeout: 1800000, pollInterval: 15000 };

    // Same reasoning as seed-contract-state.js: the encoder takes the node's
    // estimatesmartfee verbatim off a non-regtest chain, and an ORDER's carrier
    // outputs clear a dust threshold derived from that rate. An ORDER is a much
    // smaller payload than a DEPLOY, so a bad estimate is less likely to make it
    // unaffordable outright - which is exactly why it needs saying: it would
    // quietly overpay instead of failing, and this tool posts several.
    const txIo = (addr) => {
        const io = { pubkey: addr, change: addr };
        if (opts.feePerKb) io.feePerKb = opts.feePerKb;
        return io;
    };
    const submitChecked = makeSubmitChecked(sdk, log, { rememberPending, forgetPending });

    log('# seed escrow state on ' + opts.chain + '/' + opts.network);
    log('# mode: ' + (opts.broadcast ? 'BROADCAST' : 'PLAN ONLY (no transaction is sent)'));

    // -----------------------------------------------------------------------
    // 1. PREFLIGHT
    // -----------------------------------------------------------------------
    step(1, 'preflight');

    // Settle anything in flight before planning, for the reason
    // seed-contract-state.js documents at length: every decision below is a
    // chain read, a mempool transaction is invisible to a chain read, and the
    // gap between the two is where a duplicate broadcast lives.
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
                if (!explorerField(tx, 'tx_hash').found) {
                    log('    ' + label + ' ' + txid + ' -> NOT ON CHAIN YET');
                    unresolved++;
                    continue;
                }
                const acts = Array.isArray(explorerField(tx, 'actions').value)
                    ? explorerField(tx, 'actions').value : [];
                const bad = acts.filter(a => !/^valid\b/i.test(String((explorerField(a, 'status').value) || '')));
                if (!acts.length || bad.length)
                    log('    ' + label + ' ' + txid + ' -> indexed but NOT valid (' +
                        (acts.length ? acts.map(a => explorerField(a, 'status').value).join(', ') : 'no actions') +
                        '); the step will be retried');
                else
                    log('    ' + label + ' ' + txid + ' -> settled valid at block ' +
                        explorerField(tx, 'block_index').value);
                forgetPending(label);
            }
            if (unresolved) {
                log('');
                log('  REFUSING to plan while ' + unresolved + ' broadcast transaction(s) are still unconfirmed.');
                log('  Every step here decides by reading the chain, and the mempool is not the chain, so');
                log('  re-running now would post a DUPLICATE order that locks gas a second time.');
                log('  Wait for them to confirm and re-run; this is idempotent once they land.');
                log('  If one was genuinely dropped, discard it deliberately with --clear-pending.');
                process.exit(3);
            }
        }
    }

    // THE GATE, AND WHAT IT DOES NOT DO. This is the line most likely to be
    // misread as "nothing to worry about", so it is reported as three separate
    // facts rather than one verdict.
    const gate = escrowLeafGate(opts.chain, opts.network);
    if (!gate.resolved) {
        log('  escrow leaf:       UNKNOWN (could not resolve the indexer activation module)');
    } else {
        log('  escrow leaf armed: ' + (gate.armed === null ? 'no' : 'from block ' + gate.armed));
        log('  shadow window:     ' + (gate.shadow === null ? 'none' : 'from block ' + gate.shadow));
        // Printed on every run, not only when the answer looks odd: a stale
        // sibling reads exactly like a correct one, so the only way to notice is
        // to have the identity in front of you before you trust the two lines
        // above. Hash-match it against the chain's own indexer.
        log('  gate read from:    ' + gate.source);
        log('                     sha256 ' + (gate.sha256 || '(unreadable)'));
        log('                     hash-match this against the indexer that serves ' +
            opts.chain + ':' + opts.network + ' before trusting the two lines above;');
        log('                     a stale sibling checkout answers just as confidently as a current one.');
    }
    const journalWritten = gate.resolved && (gate.armed !== null || gate.shadow !== null);
    if (gate.resolved && !journalWritten) {
        log('');
        log('  NOTE, and it is not a blocker: with neither an armed height nor a shadow window on');
        log('  ' + opts.chain + ':' + opts.network + ', the indexer does not write escrow_leaf_journal at all');
        log('  (computeAndStoreRoots calls the writer only under isEscrowLockedLeafActive ||');
        log('  isEscrowLockedLeafShadowActive). So this seed will create real, correct locked');
        log('  balances, and the journal will stay EMPTY and the XCHAIN_ESC leaf will stay empty');
        log('  until one of those is armed. That is a separate operator act, not a later step here.');
        log('  Seeding first is still the right order: the arming block - and a shadow WINDOW START -');
        log('  replays the whole escrows ledger from history, so positions opened now DO land in the');
        log('  journal at that block. Arming first is what spends the transition on an empty leaf.');
        log('');
        log('  CHECK THE GATE HASH ABOVE BEFORE ACTING ON THIS NOTE. It is derived from the');
        log('  sibling checkout named above, not from the running indexer, and on 2026-08-15 a');
        log('  stale sibling made this exact NOTE print on a chain whose window was already open.');
    }

    // Chain tip, read the same way seed-contract-state.js reads it: `last_block`
    // is a per-coin MAP on the fleet status document, not a scalar.
    let tip = null;
    try {
        const st     = await sdk.explorer.getStatus();
        const prefix = SEED.coinPrefix(opts.chain, opts.network);
        let read = explorerField(st, 'last_block', { key: prefix });
        if (!read.found) {
            const alt = explorerField(st, 'decoder_tip', { key: prefix });
            if (alt.found || alt.surprise) read = alt;
        }
        tip = read.found && Number.isFinite(Number(read.value)) ? Number(read.value) : null;
        if (tip === null)
            log('  ! explorer status carried no tip for ' + prefix +
                (read.surprise ? ' (' + read.surprise + ')' : ''));
    } catch (e) {
        log('  ! explorer status unavailable: ' + e.message);
    }
    if (tip) log('  chain tip:         ' + tip);
    if (tip && gate.armed !== null) {
        const runway = gate.armed - tip;
        log('  blocks of runway:  ' + runway + (runway <= 0 ? '  (ALREADY PAST THE ARMED HEIGHT)' : ''));
    }

    // The gas token must already exist. This tool never creates it; see the
    // header. Read through explorerField for the reason that helper exists: a
    // top-level `tick` read is false for every token that exists, because the
    // explorer nests identity under `info`.
    let gasToken = null;
    try { gasToken = await sdk.explorer.getToken(GAS_TICK); } catch (e) { gasToken = null; }
    const gasTickRead = explorerField(gasToken, 'tick');
    const gasExists = gasTickRead.found &&
        String(gasTickRead.value).toUpperCase() === GAS_TICK;
    let gasShapeProblem = null;
    if (!gasExists && gasToken && !isExplorerError(gasToken) && gasTickRead.document && !gasTickRead.found)
        gasShapeProblem =
            'the explorer answered getToken(' + GAS_TICK + ') with a document carrying no `tick` at the ' +
            'top level or in any known envelope (its keys: ' + Object.keys(gasToken).join(', ') + '). That ' +
            'is a SHAPE CHANGE, not an absent token, and reading it as absent would send this run down ' +
            'the "gas token missing" path against a chain that has one. Fix the read, then re-run.';
    log('  gas token ' + GAS_TICK + ':   ' + (gasExists
        ? 'exists (read at `' + gasTickRead.at + '`)'
        : 'DOES NOT EXIST on this chain'));

    await resolveFeeRate(sdk, opts, log);
    log('  working address:   ' + (address || '(could not derive from XC_SEED_WIF)'));
    let utxoTotal = 0;
    try {
        const u = await sdk.encoder.getUTXOs(address);
        const list = (u && (u.utxos || u.data || u)) || [];
        if (Array.isArray(list)) for (const x of list) utxoTotal += Number(x.value || x.amount || 0);
        log('  funding utxos:     ' + (Array.isArray(list) ? list.length : 0) + ' totalling ' + utxoTotal + ' sats');
    } catch (e) {
        log('  ! utxo lookup failed: ' + e.message);
    }

    let gasBalance = 0;
    try {
        const rows = listRows(await sdk.explorer.getBalances(address));
        const g = rows.find(r => {
            const t = explorerField(r, 'tick');
            return t.found && String(t.value).toUpperCase() === GAS_TICK;
        });
        if (g) {
            const amt = ['amount', 'quantity', 'balance'].map(n => explorerField(g, n)).find(x => x.found);
            gasBalance = amt ? Number(amt.value) : 0;
        }
        log('  gas balance:       ' + gasBalance + ' ' + GAS_TICK + '   (spendable; escrowed gas is NOT counted here)');
    } catch (e) {
        log('  ! balance lookup failed: ' + e.message);
    }

    // WHAT THE CHAIN ALREADY CARRIES. This is the resume, and it reads the CHAIN
    // and not the state file, because the state file is written after a submit
    // returns and the normal testnet4 outcome is a run that dies in the index
    // wait having already broadcast. Rows 14/16/18/26 of the spec's frontier are
    // four separate instances of that one lesson.
    let openSeedOrders = [];
    try {
        const rows = listRows(await sdk.explorer.getOrders(address, 'address'));
        openSeedOrders = rows.filter(r => isSeedOrder(r, GAS_TICK) && holdsEscrow(r));
        log('  open seed orders:  ' + openSeedOrders.length + ' of ' + rows.length + ' order(s) at this address');
    } catch (e) {
        log('  ! order lookup failed: ' + e.message);
        log('    Refusing to plan: treating an unreadable order list as "none exist" is how this');
        log('    tool would post a second set of orders over a first set it could not see.');
        process.exit(4);
    }

    // The ledger sum, as CORROBORATION only. See the header: this agrees with the
    // locked total on a seed address precisely because that address never
    // receives a release, and it would stop agreeing the moment one did.
    let ledgerLocked = null;
    try {
        const rows = listRows(await sdk.explorer.getEscrows(address, 'address'));
        ledgerLocked = 0;
        for (const r of rows) {
            const t = explorerField(r, 'tick');
            if (!t.found || String(t.value).toUpperCase() !== GAS_TICK) continue;
            const amt = ['amount', 'quantity'].map(n => explorerField(r, n)).find(x => x.found);
            if (amt) ledgerLocked += Number(amt.value);
        }
        log('  escrows ledger:    ' + rows.length + ' row(s), ' + ledgerLocked + ' ' + GAS_TICK +
            ' net   (corroboration, NOT the leaf - see the header)');
    } catch (e) {
        log('  ! escrow lookup failed: ' + e.message);
    }

    // -----------------------------------------------------------------------
    // 2. PLAN
    // -----------------------------------------------------------------------
    const needOrders = Math.max(0, opts.orders - openSeedOrders.length);
    const needGas    = needOrders * opts.lock + GAS_FEE_HEADROOM;

    const plan = [];
    if (needOrders > 0)
        plan.push('ORDER x' + needOrders + ' (each locks ' + opts.lock + ' ' + GAS_TICK +
                  ' against a ' + opts.ask + '-sat ask that will never fill)');

    step(2, 'plan');
    if (!plan.length) log('  nothing to do: this chain already carries the target locked balances.');
    else plan.forEach((p, i) => log('  ' + (i + 1) + '. ' + p));

    const blockers = [];
    if (gasShapeProblem) blockers.push(gasShapeProblem);
    if (!gasExists) blockers.push(
        'the gas token ' + GAS_TICK + ' does not exist on this chain, and there is nothing else to lock. ' +
        'This tool deliberately will NOT create it: that is a once-per-chain irreversible act whose ' +
        'parameters are the operator\'s. Run bin/seed-contract-state.js --confirm-gas-issue first, ' +
        'which owns that step and its defaults.');
    if (gasExists && needOrders > 0 && gasBalance < needGas) blockers.push(
        'the working address holds ' + gasBalance + ' ' + GAS_TICK + ' and this plan needs ' + needGas +
        ' (' + needOrders + ' x ' + opts.lock + ' locked, plus ' + GAS_FEE_HEADROOM + ' held back for the ' +
        'order fees, which are paid out of the SAME balance the orders lock). MINT more to ' + address +
        ', or lower --orders / --lock.');
    if (utxoTotal === 0) blockers.push(
        'the working address holds no confirmed funding utxos to pay miner fees. Fund ' + address +
        ' before broadcasting.');
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
    // 3. ORDER, one per round, to the target open count
    // -----------------------------------------------------------------------
    if (needOrders > 0) {
        step(3, 'ORDER x' + needOrders);
        // TWO INDEPENDENT BRAKES, for the reason the fill loop in
        // seed-contract-state.js has them: this is the only loop here that
        // broadcasts, its condition comes back over HTTP, and a miscount must
        // not become an unbounded stream of paid transactions.
        const maxRounds = opts.orders + 3;
        let rounds = 0;
        let have = openSeedOrders.length;
        while (have < opts.orders) {
            if (++rounds > maxRounds) {
                log('  STOPPING: ' + maxRounds + ' rounds ran and the open seed-order count is still ' +
                    have + ' of ' + opts.orders + '. Something is miscounting rather than under-posting; ' +
                    'refusing to keep broadcasting. Check the explorer /orders/<address>/address read.');
                process.exit(1);
            }
            // EXPIRATION is a UNIX TIMESTAMP compared against BLOCK_TIME, not a
            // block count and not a duration. Deriving it from the local clock is
            // safe in both directions here: testnet4 blocks run FUTURE-dated by
            // up to two hours, which only shortens the realised duration and can
            // therefore never push it past the free window, and being minutes
            // short of 89 days costs nothing.
            const expiration = Math.floor(Date.now() / 1000) + opts.expirationDays * 86400;
            const res = await submitChecked(
                // GET is the native coin: getTick is deliberately absent. order.js
                // rejects only native-for-native, so a token GIVE against a native
                // GET is an ordinary maker order - and it needs no second token to
                // exist on the chain, which on a freshly re-genesised chain is the
                // difference between one transaction and three.
                //
                // getAddress is passed explicitly even though order.js defaults it
                // to SOURCE for a same-coin GET: relying on that default would make
                // this order's shape depend on a branch that only exists for
                // same-coin trades, and the seed should read the same on any chain.
                { action: 'ORDER', params: {
                    giveCoin:   opts.chain,
                    giveTick:   GAS_TICK,
                    giveAmount: opts.lock,
                    getCoin:    opts.chain,
                    getAmount:  opts.ask,
                    getAddress: address,
                    expiration: expiration,
                } },
                txIo(address),
                submitOpts,
                'ORDER ' + (have + 1) + '/' + opts.orders
            );
            requireValid(res, 'ORDER ' + (have + 1) + '/' + opts.orders);
            state.orderTxids = (state.orderTxids || []).concat(res.txid);
            writeState(opts.state, state);

            const before = have;
            const rows = listRows(await sdk.explorer.getOrders(address, 'address'));
            have = rows.filter(r => isSeedOrder(r, GAS_TICK) && holdsEscrow(r)).length;
            log('  order posted (open seed orders ' + before + ' -> ' + have + '), txid ' + res.txid);
            if (have <= before) {
                log('  STOPPING: that ORDER indexed valid but the open seed-order count did not rise (' +
                    before + ' -> ' + have + '). Either the count is wrong or the order is not holding ' +
                    'escrow; both mean the next round would be broadcast blind.');
                process.exit(1);
            }
        }
    }

    // -----------------------------------------------------------------------
    // 4. VERIFY
    // -----------------------------------------------------------------------
    step(4, 'verify');
    const finalRows   = listRows(await sdk.explorer.getOrders(address, 'address'));
    const finalOpen   = finalRows.filter(r => isSeedOrder(r, GAS_TICK) && holdsEscrow(r));
    let   finalLocked = 0;
    for (const r of finalOpen) {
        // GIVE_REMAINING, not GIVE_AMOUNT: a partially-filled order still holds
        // only what is left, and GIVE_AMOUNT would overstate it. On a seed order
        // nothing fills, so the two agree - which is exactly why reading the
        // wrong one here would never be noticed on this venue and would be
        // wrong the first time this tool met a real market.
        const rem = ['give_remaining', 'give_amount'].map(n => explorerField(r, n)).find(x => x.found);
        if (rem) finalLocked += Number(rem.value);
    }
    log('  open seed orders:  ' + finalOpen.length);
    log('  locked (orders):   ' + finalLocked + ' ' + GAS_TICK + '   (sum of GIVE_REMAINING)');
    if (ledgerLocked !== null) {
        let nowLedger = 0;
        try {
            for (const r of listRows(await sdk.explorer.getEscrows(address, 'address'))) {
                const t = explorerField(r, 'tick');
                if (!t.found || String(t.value).toUpperCase() !== GAS_TICK) continue;
                const amt = ['amount', 'quantity'].map(n => explorerField(r, n)).find(x => x.found);
                if (amt) nowLedger += Number(amt.value);
            }
            log('  locked (ledger):   ' + nowLedger + ' ' + GAS_TICK + '   (corroboration only)');
            if (nowLedger !== finalLocked)
                log('  ! the two disagree. On a seed address that only ever LOCKS they must agree; a ' +
                    'disagreement means either a release keyed elsewhere, or a read that is wrong.');
        } catch (e) {
            log('  ! escrow re-read failed: ' + e.message);
        }
    }
    log('');
    if (journalWritten) {
        log('# done. escrow_leaf_journal IS being written on this chain, so verify the leaf with:');
        log('#   node xchain-indexer/bin/verify-escrow-arming-boundary.js --chain ' + opts.chain +
            ' --network ' + opts.network);
        log('#   node xchain-indexer/bin/verify-armed-locked-balance-proof.js --chain ' + opts.chain +
            ' --network ' + opts.network);
    } else {
        log('# done, and the locked balances are real - but escrow_leaf_journal is NOT being written');
        log('# on ' + opts.chain + ':' + opts.network + ', because neither an armed height nor a shadow');
        log('# window is set for it. Nothing downstream of the ledger will move until one is. The rows');
        log('# seeded here are not lost by waiting: the arming block, and a shadow window start, both');
        log('# replay the whole escrows ledger from history into the journal.');
    }
    process.exit(0);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// p2pkh, matching seed-contract-state.js: the same working address funds both
// seeds, and a second address type would mean a second set of UTXOs to keep
// funded on a chain where funding is a manual act.
function addressOf(sdk, wif) {
    const kp = sdk.importWIF(wif);
    return sdk.deriveAddress(kp.publicKey, { type: 'p2pkh' });
}

module.exports = {
    listRows, holdsEscrow, isSeedOrder, escrowLeafGate,
    RELEASED_STATUSES, EXPIRATION_FREE_DAYS, GAS_FEE_HEADROOM, GAS_TICK,
};

if (require.main === module) {
    main().catch(e => {
        process.stderr.write('FAILED: ' + (e && e.message ? e.message : String(e)) + '\n');
        process.exit(1);
    });
}
