/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform E2E - SDK-driven test harness helper
 *
 * These suites exercise the platform exactly the way a developer (and
 * the xchain-wallet, which is built on top of the SDK) does: through
 * the public xchain-sdk API. Unlike the connector-based suites under
 * test/actions/ (which call the encoder/indexer directly and sign PSBTs
 * by hand), everything here flows through sdk.submitAction(), so the
 * SDK's own orchestration (action-string building, format selection,
 * encoder calls, PSBT signing, P2SH/P2WSH two-phase reveal, broadcast
 * and indexer confirmation) is what is under test.
 *
 * Reuses the live regtest stack + global connectors that
 * test/initialCheck.test.js stands up (regtestMinerConnector,
 * utxoTrackerConnector, nodeConnector). Run with:
 *
 *     npm run test:sdk
 *
 * (requires Node 22: the indexer DB layer pulled in by initialCheck
 * uses the mariadb ESM build.)
 *
 ********************************************************************/

// Resolve xchain-sdk from a sibling checkout (host runs) or node_modules
// (CI / container runs where it's installed as a dependency).
function loadSDK() {
    const candidates = [
        'xchain-sdk',
        '../../../xchain-sdk',      // <platform>/xchain-e2e-test/test/sdk -> <platform>/xchain-sdk
        '../../../../xchain-sdk',
    ];
    let lastErr = null;
    for (const c of candidates) {
        try { return require(c); } catch (e) { lastErr = e; }
    }
    throw new Error(
        'Could not resolve the xchain-sdk module. Install it as a dependency ' +
        '(npm i xchain-sdk) or keep an xchain-sdk checkout beside xchain-e2e-test. ' +
        'Last error: ' + (lastErr && lastErr.message)
    );
}

const { XChainSDK } = loadSDK();

// Resolve the SDK network string ("bitcoin-regtest") from the same env
// initialCheck consumes. global.COIN / global.NETWORK are set by the
// initialCheck beforeAll hook; fall back to raw env for standalone use.
function resolveNetwork() {
    let coin = (typeof global.COIN !== 'undefined' && global.COIN) || process.env.COIN || 'bitcoin';
    let net  = (typeof global.NETWORK !== 'undefined' && global.NETWORK) || process.env.NETWORK || 'regtest';
    // NETWORK may arrive as "bitcoin-regtest"; normalise to the tier.
    if (String(net).includes('-')) net = String(net).split('-')[1];
    if (String(coin).includes('-')) coin = String(coin).split('-')[0];
    return coin + '-' + net;
}

// Build a real SDK instance pointed at the live regtest stack. Endpoints
// come from env (the e2e .env) with host-port-mapping fallbacks so a
// freshly-cloned checkout works against the default xchain-node layout.
function makeSdk(overrides = {}) {
    const sdk = new XChainSDK({
        network:      resolveNetwork(),
        encoderUrl:   process.env.ENCODER_URL || 'localhost',
        encoderPort:  parseInt(process.env.ENCODER_API_PORT || '3023', 10),
        explorerUrl:  process.env.EXPLORER_URL || 'localhost',
        explorerPort: parseInt(process.env.EXPLORER_PORT || '18080', 10),
        timeout:      30000,
        retry:        { maxRetries: 2 },
        ...overrides,
    });
    return sdk;
}

// Generate a fresh keypair via the SDK and fund its address on regtest,
// reusing the proven funding path from cryptoHelper (miner sendFunds +
// utxo-tracker wait, with block-nudging on stall). Returns
// { wif, privateKey, publicKey, publicKeyHex, compressed, address }.
async function fundedSdkAddress(sdk, amountToFund = 1, addressType = 'p2pkh') {
    if (!global.regtestMinerConnector || !global.utxoTrackerConnector || !global.nodeConnector) {
        throw new Error('Global connectors not initialised. Run via "npm run test:sdk" (which --requires initialCheck).');
    }

    const kp = sdk.generateKeyPair();
    const address = sdk.deriveAddress(kp.publicKey, { type: addressType });

    const txId = await global.regtestMinerConnector.sendFunds(address, amountToFund);
    const txExists = await global.nodeConnector.waitForTx(txId);
    if (!txExists) throw new Error('Funding tx ' + txId + ' never appeared on-chain for ' + address);

    let hasUtxos = false;
    for (let attempt = 1; attempt <= 6 && !hasUtxos; attempt++) {
        try { hasUtxos = await global.utxoTrackerConnector.waitForUtxos(address, 30000); }
        catch (e) { hasUtxos = false; }
        if (!hasUtxos) {
            try { await global.regtestMinerConnector.generateBlocks(1); } catch (e) {}
        }
    }
    if (!hasUtxos) throw new Error('UTXO tracker never saw funding for ' + address);

    return { ...kp, address };
}

// Transient regtest-stack errors that warrant a quiesce + rebuild rather
// than a hard failure (same class the connector suite's transactionHelper
// retries: stale/spent UTXOs, tracker lag, mempool chain limits). These are
// timing characteristics of a fast regtest stack, not action-level failures
// (a genuinely invalid action is rejected later by the indexer, not here).
function isTransientStackError(err) {
    const msg = (err && err.message) || '';
    return /missingorspent|missing\s*or\s*spent|missing\s+inputs|bad-txns-inputs|no utxos|Cannot read propert(y|ies).*txid|Internal encoder error|txn-mempool-conflict|too-long-mempool-chain|insufficient priority|min relay fee/i.test(msg);
}

// Submit an action through the SDK with a quiesce+retry barrier around
// transient stack races, so sequential actions from one address don't flake
// under regtest load. Mirrors transactionHelper.createAndSendTransaction.
async function submit(sdk, actionData, encoderOpts, opts, attempts = 6) {
    // Default to confirmed-only UTXOs (like the connector suite): submitAction
    // waits for indexer confirmation, so each action's change is mined before the
    // next runs. Spending unconfirmed UTXOs invites the tracker's stale mempool
    // view -> bad-txns-inputs-missingorspent. Caller can override.
    const eo = Object.assign({ unconfirmed: false }, encoderOpts);
    // Keep oracle prices fresh for USD-pegged fee validation (throttled; a no-op
    // when the last seed is still fresh). Gas-mode BTC contract actions
    // (DEPLOY/EXECUTE) index `no current oracle price for BTC/USD` once the seed
    // ages out, so the SDK path refreshes here just as the actions-suite path
    // does via nativeFeeHelper.getNativeFeeOutput. Per-action (not a background
    // timer) so it never clobbers dispenser.test.js's latestBlockTime()-60
    // reverse-match seed (that DISPENSE payment uses createSimpleTransaction).
    try { await require('../helpers/nativeFeeHelper').seedGlobalPrices(false); } catch (e) { /* best effort */ }
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        // Settle the stack BEFORE building so the encoder + tracker see a
        // consistent, fully-confirmed UTXO set (including the previous action's
        // change). quiesce mines any pending mempool and waits tracker==node.
        try {
            await global.utxoTrackerConnector.quiesce({ timeoutMs: 20000, pollMs: 250, regtestMiner: global.regtestMinerConnector });
        } catch (e) { /* best effort */ }
        try {
            return await sdk.submitAction(actionData, eo, opts);
        } catch (err) {
            lastErr = err;
            if (i < attempts && isTransientStackError(err)) continue;
            throw err;
        }
    }
    throw lastErr;
}

const GAS_TICK = 'XCHAIN';

// The faucet genesis (initialCheck gas-token-check) issues XCHAIN with
// MAX_MINT=100000 per transaction. A seed above that is indexed
// 'invalid: AMOUNT > MAX_MINT' and kills every suite's before-hook on a
// fresh chain, so the default seed IS the cap (== passes; > fails).
const GAS_FAUCET_MAX_MINT = 100000;

// Mint XCHAIN gas to an address through the SDK. MINT charges no protocol
// fee, and on regtest any address may mint the gas token, so this is the
// bootstrap primitive a real user uses to acquire gas. Required before any
// action that pays the protocol fee in XCHAIN (ISSUE of a new token, ORDER,
// SWAP, DISPENSER, CALLBACK, EXECUTE, ...). Also exercises MINT via the SDK.
async function mintGas(sdk, addr, amount = GAS_FAUCET_MAX_MINT) {
    return submit(
        sdk,
        { action: 'MINT', params: { tick: GAS_TICK, amount, destination: addr.address } },
        { pubkey: addr.address, change: addr.address },
        submitOpts({ wif: addr.wif })
    );
}

// Fund an address with native coin AND seed it with XCHAIN gas in one call.
async function fundedGasAddress(sdk, amountToFund = 1, gasAmount = GAS_FAUCET_MAX_MINT, addressType = 'p2pkh') {
    const addr = await fundedSdkAddress(sdk, amountToFund, addressType);
    await mintGas(sdk, addr, gasAmount);
    return addr;
}

// Force the regtest miner to confirm whatever is in the mempool, so an
// action that has been broadcast gets mined + indexed. The miner
// auto-mines (~1s) once initialCheck calls setMiningTime, but nudging
// keeps two-phase (P2SH/P2WSH) flows snappy and deterministic.
async function mine(blocks = 1) {
    try { await global.regtestMinerConnector.generateBlocks(blocks); } catch (e) {}
}

// Unique, protocol-valid ticker for a test token (uppercase alnum).
let _tickSeq = 0;
function uniqueTick(prefix = 'SDK') {
    _tickSeq += 1;
    const stamp = Date.now().toString(36).toUpperCase();
    return (prefix + stamp + _tickSeq).slice(0, 12);
}

// Default submit options for harness flows.
function submitOpts(extra = {}) {
    return { waitForIndexer: true, timeout: 120000, pollInterval: 1500, ...extra };
}

module.exports = {
    loadSDK,
    XChainSDK,
    makeSdk,
    resolveNetwork,
    submit,
    isTransientStackError,
    fundedSdkAddress,
    mintGas,
    fundedGasAddress,
    GAS_TICK,
    mine,
    uniqueTick,
    submitOpts,
};
