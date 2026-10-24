// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Load the requested coin's environment from the current working directory.
const coinEnv = require('./helpers/rail/coin_env').loadCoinEnv({ dir: process.cwd() })
if (coinEnv.warning) console.warn('[e2e setup] WARNING: ' + coinEnv.warning)
else if (coinEnv.reason === 'coin-file')
    console.log('[e2e setup] env from ' + require('path').basename(coinEnv.file) +
        (coinEnv.derived.BTC_INDEXER_API_URL ? ' (BTC indexer URL from .env)' : ''))

const fs = require('fs')
const path = require('path')

// These gitignored vendor bundles are staged by xchain-node, not npm. Without
// them npm leaves a dangling node_modules symlink and SDK suites fail later
// with an unhelpful MODULE_NOT_FOUND, so warn at setup time with the remedy.
// This preflight stays non-fatal because non-SDK suites do not need the bundles.
for (const library of ['xchain-sdk', 'xchain-hub']) {
    if (!fs.existsSync(path.join(__dirname, '..', library))) {
        console.warn('[e2e setup] WARNING: vendored library directory ./' + library + ' is absent. ' +
            'Run `xchain-node install xchain-e2e-test` (or `xchain-node update xchain-e2e-test`) ' +
            'to stage it. The `npm run test:sdk` suites will fail at require() until it is present.')
    }
}

const BlockchainConnector = require('../src/blockchain_connector.js')
const XChainUtxoTrackerConnector = require('../src/XChainUtxoTrackerConnector.js')
const XChainEncoderConnector = require('../src/XChainEncoderConnector.js')
const XChainDecoderConnector = require('../src/XChainDecoderConnector.js')
const XChainHubConnector = require('../src/XChainHubConnector.js')
const XChainIndexerConnector = require('../src/XChainIndexerConnector.js')
const XChainExplorerConnector = require('../src/XChainExplorerConnector.js')
const RegtestMinerConnector = require('../src/regtest_miner_connector.js')
const Database = require('../src/db.js')
const CryptoNetworks = require('../src/crypto_networks')
const cryptoHelper = require('./helpers/core/cryptoHelper')
const { hubNodePort } = require('./helpers/hub_node_port')
const hubMirrorTopology = require('./helpers/hubMirrorTopology')
const xchainPriceConstants = require('./helpers/xchainPriceConstants')
const issueHelper = require('./helpers/issueHelper')
const gasHelper = require('./helpers/gasHelper')
const stakeHelper = require('./helpers/stakeHelper')
const stakeTeardown = require('./helpers/stakeTeardown')
const runtime = require('./initial_check.test/runtime_phases.test')
const teardown = require('./initial_check.test/teardown.test')

let perfCollector = null
try { perfCollector = require('./perf/helpers/perfCollector') } catch(error) {}
const phase = perfCollector ? (name, fn) => perfCollector.phase(name, fn) : (name, fn) => fn()
const GAS_TICK = 'XCHAIN'
const BOOTSTRAP_ISSUE_WAIT_MS = 240000

global.COIN = process.env.COIN
global.NETWORK = process.env.NETWORK
if (COIN === null || COIN === undefined) {
    const networkSplit = NETWORK.split('-')
    global.COIN = networkSplit[0]
    global.NETWORK = networkSplit[1]
}
// xchain-node can inject NETWORK as coin-network even when COIN is separate.
// Strip that prefix before selecting bitcoinjs parameters; otherwise the
// doubled coin name misses regtest and produces mainnet addresses.
// Funding those addresses on a regtest node would never confirm.
if (COIN && NETWORK && NETWORK.indexOf(COIN + '-') === 0)
    global.NETWORK = NETWORK.substring((COIN + '-').length)
global.NETWORK_OBJECT = CryptoNetworks.getBitcoinJsNetwork(COIN + '-' + NETWORK)
const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }
global.COIN_CODE = COIN_CODE_MAP[COIN] || COIN.toUpperCase().slice(0, 3)

const HUB_URL = process.env.HUB_URL
const HUB_PORT = process.env.HUB_PORT
let NODE_URL = process.env.NODE_URL
let NODE_PORT = process.env.NODE_PORT
let NODE_USER = process.env.NODE_USER
let NODE_PASS = process.env.NODE_PASSWORD
let DATABASE_URL = process.env.DATABASE_URL || 'mariadb'
let DATABASE_PORT = parseInt(process.env.DATABASE_PORT, 10) || 3306
let UTXO_TRACKER_URL = process.env.UTXO_TRACKER_URL
let UTXO_TRACKER_PORT = process.env.UTXO_TRACKER_API_PORT
let ENCODER_URL = process.env.ENCODER_URL
let ENCODER_PORT = process.env.ENCODER_API_PORT
let DECODER_URL = process.env.DECODER_URL
let DECODER_PORT = process.env.DECODER_API_PORT
let INDEXER_URL = process.env.INDEXER_URL
let INDEXER_PORT = process.env.INDEXER_API_PORT
const EXPLORER_URL = process.env.EXPLORER_URL
const EXPLORER_PORT = process.env.EXPLORER_API_PORT
let INDEXER_DATABASE_NAME = process.env.INDEXER_DB_NAME
let INDEXER_DATABASE_USER = process.env.INDEXER_DB_USER
let INDEXER_DATABASE_PASS = process.env.INDEXER_DB_PASS
let REGTEST_MINER_URL = process.env.REGTEST_MINER_URL
let REGTEST_MINER_PORT = process.env.REGTEST_MINER_API_PORT

function allEnvironmentPresent() {
    // Empty strings count as explicitly supplied values and are left for the
    // owning connector to validate. Discovery is concerned only with absent
    // values, which avoids silently overriding an intentional test fixture.
    return [NODE_URL, NODE_PORT, NODE_USER, NODE_PASS, DATABASE_URL, DATABASE_PORT,
        UTXO_TRACKER_URL, UTXO_TRACKER_PORT, ENCODER_URL, ENCODER_PORT, DECODER_URL,
        DECODER_PORT, INDEXER_URL, INDEXER_PORT, EXPLORER_URL, EXPLORER_PORT,
        INDEXER_DATABASE_NAME, INDEXER_DATABASE_USER, INDEXER_DATABASE_PASS,
        REGTEST_MINER_URL, REGTEST_MINER_PORT].every((value) => value !== null && value !== undefined)
}

// Setup diagnostics reveal only presence. Even a suffix or length leaks
// credential information into CI output.
// These diagnostics are commonly retained as build artifacts.
function maskSecret(value) { return value == null || value === undefined ? '(not set)' : '(set)' }

// Hub config uses a redaction sentinel when the caller lacks the credential
// tier. Never pass that sentinel to a downstream service where it would become
// a delayed authentication failure. An explicit environment value may supply
// the credential because discovery runs only when some setup value is absent.
// Failing here identifies the missing credential and avoids a later database
// access denial or service 401 that looks like a topology problem.
function hubCredential(hubValue, envValue, purpose) {
    if (hubValue !== XChainHubConnector.REDACTED) return hubValue
    if (envValue) return envValue
    return XChainHubConnector.assertUnredactedCredential(hubValue, purpose)
}

function printEnvironment() {
    // Keep this object-shaped output so setup logs remain searchable by field
    // without exposing any credential content.
    console.log({
        node_url: NODE_URL, node_port: NODE_PORT, node_user: maskSecret(NODE_USER),
        node_pass: maskSecret(NODE_PASS), database_url: DATABASE_URL, database_port: DATABASE_PORT,
        utxo_tracker_url: UTXO_TRACKER_URL, utxo_tracker_port: UTXO_TRACKER_PORT,
        encoder_url: ENCODER_URL, encoder_port: ENCODER_PORT, decoder_url: DECODER_URL,
        decoder_port: DECODER_PORT, indexer_url: INDEXER_URL, indexer_port: INDEXER_PORT,
        explorer_url: EXPLORER_URL, explorer_port: EXPLORER_PORT,
        indexer_database_name: INDEXER_DATABASE_NAME,
        indexer_database_user: maskSecret(INDEXER_DATABASE_USER),
        indexer_database_pass: maskSecret(INDEXER_DATABASE_PASS),
        regtest_miner_url: REGTEST_MINER_URL, regtest_miner_port: REGTEST_MINER_PORT
    })
}

// Service ports are coin-scoped in the hub tree. Database fields live on the
// indexer entry, while explorer coordinates remain environment-only because
// the explorer is not represented in that coin-scoped config.
// Hostnames use loopback because this hook runs outside the service network.
function applyHubConfig(coinNet) {
    NODE_URL = 'localhost'
    // An explicit host-side node port wins over the hub's in-network port.
    NODE_PORT = hubNodePort(process.env.NODE_PORT, coinNet["node"]["port"])
    NODE_USER = coinNet.node.user
    NODE_PASS = hubCredential(coinNet.node.pass, process.env.NODE_PASS, 'the node RPC password (NODE_PASS)')
    DATABASE_URL = '127.0.0.1'
    DATABASE_PORT = coinNet['xchain-indexer'].db_port
    UTXO_TRACKER_URL = 'localhost'
    UTXO_TRACKER_PORT = coinNet['xchain-utxo-tracker'].port
    ENCODER_URL = 'localhost'
    ENCODER_PORT = coinNet['xchain-encoder'].port
    DECODER_URL = 'localhost'
    DECODER_PORT = coinNet['xchain-decoder'] && coinNet['xchain-decoder'].port
    INDEXER_URL = 'localhost'
    INDEXER_PORT = coinNet['xchain-indexer'].port
    INDEXER_DATABASE_NAME = coinNet['xchain-indexer'].name
    INDEXER_DATABASE_USER = coinNet['xchain-indexer'].user
    INDEXER_DATABASE_PASS = hubCredential(coinNet['xchain-indexer'].pass,
        process.env.INDEXER_DATABASE_PASS, 'the indexer database password (INDEXER_DATABASE_PASS)')
    REGTEST_MINER_URL = 'localhost'
    REGTEST_MINER_PORT = coinNet['xchain-regtest-miner'] && coinNet['xchain-regtest-miner'].port
    if (!EXPLORER_URL || !EXPLORER_PORT)
        throw new Error('EXPLORER_URL and EXPLORER_API_PORT must be set in env; explorer is not hub-discoverable')
}

async function resolveEnvironment() {
    // Fully specified environments bypass hub discovery. Partial environments
    // are printed with credentials masked, then completed from the hub's coin
    // and network config. The selected coin entry must exist as a unit so ports
    // from one network cannot be combined with credentials from another.
    if (allEnvironmentPresent()) return
    printEnvironment()
    console.log('Connecting to the hub')
    global.hubConnector = new XChainHubConnector(XChainHubConnector.parseEndpoints())
    if (!await hubConnector.ping()) {
        const failures = hubConnector.lastFailures && hubConnector.lastFailures.length
            ? ' No hub endpoints reachable: [' + hubConnector.lastFailures.join(', ') + ']' : ''
        throw new Error("Can't connect to the XChain Hub." + failures)
    }
    const hubConfigs = await hubConnector.getAllConfig()
    if (!hubConfigs) throw new Error('There was an error trying to get all the configs from the hub')
    const coinNet = hubConfigs[COIN] && hubConfigs[COIN][NETWORK]
    if (!coinNet) throw new Error('Hub returned no config for ' + COIN + '/' + NETWORK)
    applyHubConfig(coinNet)
}

function initializeConnectors() {
    // Publish connectors on global because the full suite shares this root hook
    // and its helpers consume these names as process-wide fixtures. Initialization
    // stays separate from liveness checks so timing can attribute setup failures.
    global.nodeConnector = new BlockchainConnector(NODE_URL, NODE_PORT, NODE_USER, NODE_PASS)
    global.utxoTrackerConnector = new XChainUtxoTrackerConnector(UTXO_TRACKER_URL, UTXO_TRACKER_PORT)
    global.encoderConnector = new XChainEncoderConnector(ENCODER_URL, ENCODER_PORT, process.env.ENCODER_API_KEY || null)
    global.decoderConnector = new XChainDecoderConnector(DECODER_URL, DECODER_PORT)
    global.indexerConnector = new XChainIndexerConnector(INDEXER_URL, INDEXER_PORT, process.env.INDEXER_API_KEY || null)
    global.explorerConnector = new XChainExplorerConnector(EXPLORER_URL, EXPLORER_PORT)
    global.indexerDatabase = new Database(
        DATABASE_URL, DATABASE_PORT, INDEXER_DATABASE_NAME, INDEXER_DATABASE_USER, INDEXER_DATABASE_PASS)
    global.regtestMinerConnector = new RegtestMinerConnector(
        REGTEST_MINER_URL, REGTEST_MINER_PORT, process.env.MINER_API_KEY || null)
}

// Ensure the GAS token exists on the active chain before any suite runs. BTC
// creates the open-mint faucet directly. DOGE and LTC must receive the token
// through the bridge because a local GAS issue is refused and the first v2
// in-leg creates the token row lazily. Anchor-only rails can disable the
// off-BTC reservoir fill when no bridge relay exists.
// Read the disable switch at hook time because multiple suites can invoke this
// bootstrap in the same process with different rail setup.
async function bootstrapGas() {
    if (process.env.E2E_GAS_BOOTSTRAP === 'off' && global.COIN_CODE !== 'BTC') {
        console.log('Skipping the GAS token bootstrap on ' + global.COIN_CODE + ': E2E_GAS_BOOTSTRAP=off')
        return
    }
    console.log('Checking if GAS token (' + GAS_TICK + ') exists...')
    if (await indexerDatabase.checkIssue({ tick: GAS_TICK, status: 'valid' })) {
        console.log('GAS token (' + GAS_TICK + ') already exists')
        return
    }
    console.log('GAS token not found, creating it...')
    if (global.COIN_CODE === 'BTC') {
        // This address issues XCHAIN itself, so gas seeding must stay disabled
        // until the token exists. The zero initial supply keeps the test token
        // as an unlocked faucet; the high per-mint cap supports large suites.
        // A default pre-issue MINT would fail with an unknown tick and leave the
        // bootstrap waiting for a balance that cannot exist.
        const gasAddressInfo = await cryptoHelper.getNewFundedAddress(
            'GAS.TOKEN', COIN, NETWORK, null, 'legacy', 0, 1, false)
        // Testnet and regtest treat XCHAIN as an open faucet: no owner check or
        // fee is required for MINT. Genesis therefore creates no supply and
        // leaves minting unlocked from block zero. A generous per-transaction
        // maximum avoids throttling fixtures that request thousands of units;
        // production faucet policy may impose a smaller cap separately.
        await issueHelper.sendIssueV0Waiting(
            BOOTSTRAP_ISSUE_WAIT_MS, gasAddressInfo,
            GAS_TICK, 100000000, 100000, 0, 'XChain GAS Token', 0)
    } else {
        // Filling the reservoir mints on BTC and bridges inward. That first
        // in-leg creates a byte-identical local token definition, after which
        // ordinary gas funding is a local transfer from the reservoir.
        // The amount bridged does not affect the lazily created definition.
        await gasHelper.fillGasReservoir()
    }
    console.log('GAS token (' + GAS_TICK + ') created successfully')
}

async function beforeAll() {
    // Phase boundaries feed the optional performance collector and keep setup
    // failures attributable. Ordering is contractual: resolve topology before
    // constructing connectors, prove services live before writing prices, seed
    // prices before creating GAS, and capture stake only after bootstrap.
    if (perfCollector) perfCollector.startRun()
    if (NETWORK === 'mainnet' && process.env.ALLOW_MAINNET !== 'true')
        throw new Error('Refusing to run tests against mainnet. Set ALLOW_MAINNET=true to override.')
    await phase('env-resolution', resolveEnvironment)
    await phase('connector-init', initializeConnectors)
    await phase('service-pings', () => runtime.pingServices(gasHelper))
    await phase('native-fee-price-seed', runtime.seedNativePrices)
    await phase('gas-token-check', bootstrapGas)
    await phase('stake-baseline', () => runtime.captureStakeBaseline(stakeTeardown))
}

async function afterAll() {
    let teardownError = null
    try {
        await teardown.afterAll({ phase, gasHelper, stakeTeardown, stakeHelper })
    } catch (error) {
        teardownError = error
    }

    let priceCleanupError = null
    try {
        const removed = await xchainPriceConstants.clearRootHookPriceSeeds(
            hubMirrorTopology.clearTargets())
        if (removed > 0)
            console.log('[e2e teardown] removed ' + removed + ' root-hook price seed row(s)')
    } catch (error) {
        priceCleanupError = error
    }

    if (teardownError && priceCleanupError)
        throw new AggregateError([teardownError, priceCleanupError],
            'E2E teardown and root-hook price cleanup both failed')
    if (teardownError) throw teardownError
    if (priceCleanupError) throw priceCleanupError
}

exports.mochaHooks = {
    beforeAll,
    afterEach: teardown.afterEachBarrier,
    afterAll
}
