// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const dotenv = require('dotenv')
dotenv.config()

const fs   = require('fs')
const path = require('path')

// Vendor-bundle pre-flight: warn loudly when the gitignored ./xchain-sdk or
// ./xchain-hub directories are absent. These are staged by `xchain-node install`
// (via LIBRARY_BUNDLES) and are not part of the repo. When missing, `npm install`
// creates a dangling symlink in node_modules rather than failing, so SDK suites
// crash at require() time with a cryptic MODULE_NOT_FOUND. Surface the cause here
// so the operator knows to run `xchain-node install xchain-e2e-test` (or copy the
// sibling directories in manually) before attempting the SDK test suites.
const VENDOR_LIBS = ['xchain-sdk', 'xchain-hub'];
for (const lib of VENDOR_LIBS) {
    const libPath = path.join(__dirname, '..', lib);
    if (!fs.existsSync(libPath)) {
        console.warn(
            '[e2e setup] WARNING: vendored library directory ./' + lib + ' is absent. ' +
            'Run `xchain-node install xchain-e2e-test` (or `xchain-node update xchain-e2e-test`) ' +
            'to stage it. The `npm run test:sdk` suites will fail at require() until it is present.'
        );
    }
}

const BlockchainConnector = require('../src/BlockchainConnector.js')
const XChainUtxoTrackerConnector = require('../src/XChainUtxoTrackerConnector.js')
const XChainEncoderConnector = require('../src/XChainEncoderConnector.js')
const XChainDecoderConnector = require('../src/XChainDecoderConnector.js')
const XChainHubConnector = require('../src/XChainHubConnector.js')
const XChainIndexerConnector = require('../src/XChainIndexerConnector.js')
const XChainExplorerConnector = require('../src/XChainExplorerConnector.js')
const RegtestMinerConnector = require('../src/RegtestMinerConnector.js')
const Database = require('../src/db.js')
const CryptoNetworks = require('../src/CryptoNetworks')
const cryptoHelper = require('./cryptoHelper')
const issueHelper = require('./helpers/issueHelper')

let perfCollector = null
try { perfCollector = require('./perf/perfCollector') } catch(e) {}
const phase = perfCollector
    ? (name, fn) => perfCollector.phase(name, fn)
    : (name, fn) => fn()

const GAS_TICK = "XCHAIN"

global.COIN = process.env.COIN
global.NETWORK = process.env.NETWORK

if (COIN === null || COIN === undefined){
    let networkSplit = NETWORK.split("-")
    global.COIN = networkSplit[0]
    global.NETWORK = networkSplit[1]
}

// NETWORK can arrive in combined coin-network form (e.g. "bitcoin-regtest") when COIN is
// injected separately by xchain-node. Strip the coin prefix so it is the bare network
// ("regtest") everywhere: otherwise COIN+"-"+NETWORK doubles the coin
// ("bitcoin-bitcoin-regtest"), getBitcoinJsNetwork misses, and bitcoinjs falls back to
// MAINNET ("1..." addresses) which a regtest node rejects, so funding never confirms.
if (COIN && NETWORK && NETWORK.indexOf(COIN + "-") === 0){
    global.NETWORK = NETWORK.substring((COIN + "-").length)
}

global.NETWORK_OBJECT = CryptoNetworks.getBitcoinJsNetwork(COIN+"-"+NETWORK)

const COIN_CODE_MAP = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' }
global.COIN_CODE = COIN_CODE_MAP[COIN] || COIN.toUpperCase().slice(0, 3)


var HUB_URL =  process.env.HUB_URL
var HUB_PORT =  process.env.HUB_PORT
var NODE_URL = process.env.NODE_URL
var NODE_PORT = process.env.NODE_PORT
var NODE_USER = process.env.NODE_USER
var NODE_PASS = process.env.NODE_PASSWORD
var DATABASE_URL = process.env.DATABASE_URL || "mariadb"
var DATABASE_PORT = parseInt(process.env.DATABASE_PORT, 10) || 3306
var UTXO_TRACKER_URL = process.env.UTXO_TRACKER_URL
var UTXO_TRACKER_PORT = process.env.UTXO_TRACKER_API_PORT
var ENCODER_URL = process.env.ENCODER_URL
var ENCODER_PORT = process.env.ENCODER_API_PORT
var DECODER_URL = process.env.DECODER_URL
var DECODER_PORT = process.env.DECODER_API_PORT
var INDEXER_URL = process.env.INDEXER_URL
var INDEXER_PORT = process.env.INDEXER_API_PORT
var EXPLORER_URL = process.env.EXPLORER_URL
var EXPLORER_PORT = process.env.EXPLORER_API_PORT
var INDEXER_DATABASE_NAME = process.env.INDEXER_DB_NAME
var INDEXER_DATABASE_USER = process.env.INDEXER_DB_USER
var INDEXER_DATABASE_PASS = process.env.INDEXER_DB_PASS
var REGTEST_MINER_URL = process.env.REGTEST_MINER_URL
var REGTEST_MINER_PORT = process.env.REGTEST_MINER_API_PORT

function checkAllEnvironmentalVariables(){
    let variableArray = [
        NODE_URL, 
        NODE_PORT,
        NODE_USER,
        NODE_PASS,
        DATABASE_URL,
        DATABASE_PORT,
        UTXO_TRACKER_URL,
        UTXO_TRACKER_PORT,
        ENCODER_URL,
        ENCODER_PORT,
        DECODER_URL,
        DECODER_PORT,
        INDEXER_URL,
        INDEXER_PORT,
        EXPLORER_URL,
        EXPLORER_PORT,
        INDEXER_DATABASE_NAME,
        INDEXER_DATABASE_USER,
        INDEXER_DATABASE_PASS,
        REGTEST_MINER_URL,
        REGTEST_MINER_PORT
    ]
    
    return variableArray.every((variable) => variable !== null && variable !== undefined)
}

function maskSecret(value){
    if (value == null || value === undefined) return '(not set)'
    const str = String(value)
    if (str.length <= 4) return '****'
    return '****' + str.slice(-4)
}

function printAllEnvironmentalVariables(){
    console.log({
      node_url:NODE_URL,
      node_port:NODE_PORT,
      node_user:maskSecret(NODE_USER),
      node_pass:maskSecret(NODE_PASS),
      database_url:DATABASE_URL,
      database_port:DATABASE_PORT,
      utxo_tracker_url:UTXO_TRACKER_URL,
      utxo_tracker_port:UTXO_TRACKER_PORT,
      encoder_url:ENCODER_URL,
      encoder_port:ENCODER_PORT,
      decoder_url:DECODER_URL,
      decoder_port:DECODER_PORT,
      indexer_url:INDEXER_URL,
      indexer_port:INDEXER_PORT,
      explorer_url:EXPLORER_URL,
      explorer_port:EXPLORER_PORT,
      indexer_database_name:INDEXER_DATABASE_NAME,
      indexer_database_user:maskSecret(INDEXER_DATABASE_USER),
      indexer_database_pass:maskSecret(INDEXER_DATABASE_PASS),
      regtest_miner_url:REGTEST_MINER_URL,
      regtest_miner_port:REGTEST_MINER_PORT
    })
}

exports.mochaHooks = {
    async beforeAll(){
        if (perfCollector) perfCollector.startRun()

        if (NETWORK === 'mainnet' && process.env.ALLOW_MAINNET !== 'true'){
            throw new Error('Refusing to run tests against mainnet. Set ALLOW_MAINNET=true to override.')
        }

        await phase('env-resolution', async () => {
            if (!checkAllEnvironmentalVariables()){
                printAllEnvironmentalVariables()


                console.log("Connecting to the hub")
                let hubEndpoints = XChainHubConnector.parseEndpoints();
                global.hubConnector = new XChainHubConnector(hubEndpoints)
                let pingHub = await hubConnector.ping()

                if (pingHub){
                    let hubConfigs = await hubConnector.getAllConfig()

                    if (hubConfigs){
                        const coinNet = hubConfigs[COIN] && hubConfigs[COIN][NETWORK]
                        if (!coinNet) {
                            throw new Error("Hub returned no config for " + COIN + "/" + NETWORK)
                        }

                        // Hub schema uses "port" (not "server_port"); DB fields live
                        // directly in the xchain-indexer entry (db_host/db_port/name/user/pass).
                        NODE_URL = "localhost"
                        NODE_PORT = coinNet["node"]["port"]
                        NODE_USER = coinNet["node"]["user"]
                        NODE_PASS = coinNet["node"]["pass"]

                        // DB config comes from the indexer's db_host/db_port fields
                        // (hub has no top-level "database" section).
                        DATABASE_URL = "127.0.0.1"
                        DATABASE_PORT = coinNet["xchain-indexer"]["db_port"]

                        UTXO_TRACKER_URL = "localhost"
                        UTXO_TRACKER_PORT = coinNet["xchain-utxo-tracker"]["port"]

                        ENCODER_URL = "localhost"
                        ENCODER_PORT = coinNet["xchain-encoder"]["port"]

                        DECODER_URL = "localhost"
                        DECODER_PORT = coinNet["xchain-decoder"] && coinNet["xchain-decoder"]["port"]

                        INDEXER_URL = "localhost"
                        INDEXER_PORT = coinNet["xchain-indexer"]["port"]
                        INDEXER_DATABASE_NAME = coinNet["xchain-indexer"]["name"]
                        INDEXER_DATABASE_USER = coinNet["xchain-indexer"]["user"]
                        INDEXER_DATABASE_PASS = coinNet["xchain-indexer"]["pass"]

                        REGTEST_MINER_URL = "localhost"
                        REGTEST_MINER_PORT = coinNet["xchain-regtest-miner"] && coinNet["xchain-regtest-miner"]["port"]

                        // Explorer is not coin-scoped in the hub config tree; it
                        // must be supplied via EXPLORER_URL / EXPLORER_API_PORT env vars.
                        if (!EXPLORER_URL || !EXPLORER_PORT) {
                            throw new Error("EXPLORER_URL and EXPLORER_API_PORT must be set in env; explorer is not hub-discoverable")
                        }
                    } else {
                        throw new Error("There was an error trying to get all the configs from the hub")
                    }
                } else {
                    let failures = (hubConnector.lastFailures && hubConnector.lastFailures.length)
                        ? ' No hub endpoints reachable: [' + hubConnector.lastFailures.join(', ') + ']'
                        : ''
                    throw new Error("Can't connect to the XChain Hub." + failures)
                }


            }
        })

        await phase('connector-init', async () => {
            global.nodeConnector = new BlockchainConnector(
                NODE_URL, NODE_PORT, NODE_USER, NODE_PASS
            )
            global.utxoTrackerConnector = new XChainUtxoTrackerConnector(UTXO_TRACKER_URL, UTXO_TRACKER_PORT)
            global.encoderConnector = new XChainEncoderConnector(ENCODER_URL, ENCODER_PORT)
            global.decoderConnector = new XChainDecoderConnector(DECODER_URL, DECODER_PORT)
            global.indexerConnector = new XChainIndexerConnector(INDEXER_URL, INDEXER_PORT, process.env.INDEXER_API_KEY || null)
            global.explorerConnector = new XChainExplorerConnector(EXPLORER_URL, EXPLORER_PORT)
            global.indexerDatabase = new Database(DATABASE_URL, DATABASE_PORT, INDEXER_DATABASE_NAME, INDEXER_DATABASE_USER, INDEXER_DATABASE_PASS)
            global.regtestMinerConnector = new RegtestMinerConnector(REGTEST_MINER_URL, REGTEST_MINER_PORT, process.env.MINER_API_KEY || null)
        })

        await phase('service-pings', async () => {
            try {
                let pingNode = await nodeConnector.getNetworkInfo()
                if (!pingNode){
                    throw new Error("Can't connect to the node")
                }
            } catch (err){
                console.log(err)
                throw new Error("There was an error trying to connect to the node")
            }

            let pingUtxoTracker = await utxoTrackerConnector.ping()
            if (!pingUtxoTracker){
                throw new Error("Can't connect to the XChain Utxo Tracker module")
            }

            let pingEncoder = await encoderConnector.ping()
            if (!pingEncoder){
                throw new Error("Can't connect to the XChain Encoder module")
            }

            let pingDecoder = await decoderConnector.ping()
            if (!pingDecoder){
                throw new Error("Can't connect to the XChain Decoder module")
            }

            let pingIndexer = await indexerConnector.ping()
            if (!pingIndexer){
                throw new Error("Can't connect to the XChain Indexer module")
            }

            let pingExplorer = await explorerConnector.ping()
            if (!pingExplorer){
                throw new Error("Can't connect to the XChain Explorer module")
            }

            let pingIndexerDatabase = await indexerDatabase.ping()
            if (!pingIndexerDatabase){
                throw new Error("Can't connect to the XChain Indexer Database")
            }

            let pingRegtestMiner = await regtestMinerConnector.waitForReady()
            if (!pingRegtestMiner){
                throw new Error("Can't connect to the XChain Regtest Miner module (not ready after wait)")
            } else {
                await regtestMinerConnector.setMiningTime(1000, 1000)
            }
        })

        await phase('native-fee-price-seed', async () => {
            // Seed XCHAIN/USD + {COIN}/USD up front on EVERY chain. LTC/DOGE
            // value the native-coin fee output against these; gas-mode BTC needs
            // a fresh {COIN}/USD for USD-pegged contract-fee validation. Seeding
            // here lets the very first ISSUE (incl. the GAS-token bootstrap
            // below) and any contract action be priced. The per-action paths
            // refresh during long runs (transactionHelper -> getNativeFeeOutput
            // for the actions suite, sdkHelper.submit for the SDK suite), so a
            // run past ORACLE_MAX_PRICE_AGE never ages out. See nativeFeeHelper.js.
            const nativeFeeHelper = require('./helpers/nativeFeeHelper')
            await nativeFeeHelper.seedGlobalPrices(true)
        })

        await phase('gas-token-check', async () => {
            // Ensure the GAS token exists before any tests run
            console.log("Checking if GAS token ("+GAS_TICK+") exists...")
            const gasTokenExists = await indexerDatabase.checkIssue({ tick: GAS_TICK, status: 'valid' })
            if (!gasTokenExists) {
                console.log("GAS token not found, creating it...")
                // seedGas=false: this is the address that ISSUEs XCHAIN itself. On a
                // genesis-fresh chain the gas token does not exist yet, so the default
                // gas-seeding MINT would reject as invalid:TICK(unknown) and hang the
                // bootstrap. Seed gas only after XCHAIN is issued below.
                let gasAddressInfo = await cryptoHelper.getNewFundedAddress("GAS.TOKEN", COIN, NETWORK, null, "legacy", 0, 1, false)
                // XCHAIN is an open-mint GAS faucet on testnet/regtest: anyone MINTs it (no owner
                // check, no fee) to grab gas to play. Genesis therefore mints NO initial supply
                // (mintSupply=0) and leaves minting unlocked + open from genesis (lockMint unset,
                // mintStartBlock unset => 0). MAX_MINT is held high here so the e2e suite
                // (mints 100-5000 gas per call via gasHelper) is not throttled; the real testnet
                // bootstrap can impose a tighter per-mint cap separately.
                await issueHelper.sendIssueV0(
                    gasAddressInfo,
                    GAS_TICK,
                    100000000,   // MAX_SUPPLY
                    100000,      // MAX_MINT (per tx): high for e2e; real faucet may cap tighter
                    0,           // decimals
                    "XChain GAS Token",
                    0            // MINT_SUPPLY: faucet, no pre-minted supply
                )
                console.log("GAS token ("+GAS_TICK+") created successfully")
            } else {
                console.log("GAS token ("+GAS_TICK+") already exists")
            }
        })
    },

    // After every test, wait for the regtest stack to be quiescent before
    // the next test starts. "Quiescent" = node mempool empty AND tracker
    // committed-height == node height. This eliminates the ordering-dependent
    // flakes where a previous test leaves a mid-batch state that breaks the
    // next test's encoder queries with phantom "no utxos" errors.
    //
    // Failures here are logged but never throw; we don't want to mask the
    // actual test outcome with barrier issues. The 15s timeout is generous
    // for regtest under load; quiescence usually lands in < 1s on a clean
    // stack.
    async afterEach(){
        try {
            const status = await utxoTrackerConnector.quiesce({
                timeoutMs: 15000,
                pollMs: 250,
                regtestMiner: regtestMinerConnector,
            })
            if (!status || !status.ready){
                const summary = status
                    ? `mempool=${status.mempool_size} tracker=${status.tracker_height} node=${status.node_height} lag=${status.lag}`
                    : 'no-response'
                console.log(`afterEach: stack did not reach quiescence within 15s (${summary})`)
            }
        } catch (err){
            console.log('afterEach: quiesce failed: ' + (err && err.message))
        }
    },

    async afterAll(){
        await phase('teardown', async () => {
            try{
                await regtestMinerConnector.setDefaultMiningTime()
            } catch (err){
                console.log("There was a problem setting the default mining time values for the regtest miner")
            }

            if (global.wallets) {
                for (const label of Object.keys(global.wallets)) {
                    const w = global.wallets[label]
                    if (w.seed && Buffer.isBuffer(w.seed)) w.seed.fill(0)
                    if (w.addresses) {
                        for (const addr of w.addresses) {
                            if (addr.privateKey && Buffer.isBuffer(addr.privateKey)) addr.privateKey.fill(0)
                        }
                    }
                }
                global.wallets = {}
            }

            try {
                if (global.indexerDatabase && global.indexerDatabase.pool) {
                    await global.indexerDatabase.pool.end()
                }
            } catch (err) {
                console.log("There was a problem closing the database connection pool")
            }
        })
    }
}
