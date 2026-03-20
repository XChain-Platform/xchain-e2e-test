const dotenv = require('dotenv')
dotenv.config()

const BlockchainConnector = require('../src/BlockchainConnector.js')
const XChainUtxoTrackerConnector = require('../src/XChainUtxoTrackerConnector.js')
const XChainEncoderConnector = require('../src/XChainEncoderConnector.js')
const XChainHubConnector = require('../src/XChainHubConnector.js')
const XChainIndexerConnector = require('../src/XChainIndexerConnector.js')
const RegtestMinerConnector = require('../src/RegtestMinerConnector.js')
const Database = require('../src/db.js')
const CryptoNetworks = require('../src/CryptoNetworks')
const cryptoHelper = require('./cryptoHelper')
const issueHelper = require('./helpers/issueHelper')

const GAS_TICK = "XCHAIN"

global.COIN = process.env.COIN
global.NETWORK = process.env.NETWORK

if (COIN === null || COIN === undefined){
    let networkSplit = NETWORK.split("-")
    global.COIN = networkSplit[0]
    global.NETWORK = networkSplit[1]
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
var DATABASE_URL = "mariadb"
var DATABASE_PORT = 3306
var UTXO_TRACKER_URL = process.env.UTXO_TRACKER_URL
var UTXO_TRACKER_PORT = process.env.UTXO_TRACKER_API_PORT
var ENCODER_URL = process.env.ENCODER_URL
var ENCODER_PORT = process.env.ENCODER_API_PORT
var INDEXER_URL = process.env.INDEXER_HOST
var INDEXER_PORT = process.env.INDEXER_API_PORT
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
        INDEXER_URL,
        INDEXER_PORT,
        INDEXER_DATABASE_NAME,
        INDEXER_DATABASE_USER,
        INDEXER_DATABASE_PASS,
        REGTEST_MINER_URL,
        REGTEST_MINER_PORT
    ]
    
    return variableArray.every((variable) => variable !== null && variable !== undefined)
}

function printAllEnvironmentalVariables(){
    console.log({
      node_url:NODE_URL,
      node_port:NODE_PORT,
      node_user:NODE_USER,
      node_pass:NODE_PASS,
      database_url:DATABASE_URL,
      database_port:DATABASE_PORT,
      utxo_tracker_url:UTXO_TRACKER_URL,
      utxo_tracker_port:UTXO_TRACKER_PORT,
      encoder_url:ENCODER_URL,
      encoder_port:ENCODER_PORT,
      indexer_url:INDEXER_URL,
      indexer_port:INDEXER_PORT,
      indexer_database_name:INDEXER_DATABASE_NAME,
      indexer_database_user:INDEXER_DATABASE_USER,
      indexer_database_pass:INDEXER_DATABASE_PASS,
      regtest_miner_url:REGTEST_MINER_URL,
      regtest_miner_port:REGTEST_MINER_PORT
    })
}

exports.mochaHooks = {
    async beforeAll(){
        if (!checkAllEnvironmentalVariables()){
            printAllEnvironmentalVariables()
        
        
            console.log("Connecting to the hub")
            global.hubConnector = new XChainHubConnector(HUB_URL, HUB_PORT)
            let pingHub = await hubConnector.ping()
            
            if (pingHub){
                let hubConfigs = await hubConnector.getAllConfig()
                
                if (hubConfigs){
                    //NODE_URL = hubConfigs[COIN][NETWORK]["node"]["host"]
                    NODE_URL = "localhost"
                    NODE_PORT = hubConfigs[COIN][NETWORK]["node"]["server_port"]
                    NODE_USER = hubConfigs[COIN][NETWORK]["node"]["user"]
                    NODE_PASS = hubConfigs[COIN][NETWORK]["node"]["pass"]
                    
                    //DATABASE_URL = hubConfigs[COIN][NETWORK]["database"]["host"]
                    DATABASE_URL = "localhost"
                    DATABASE_PORT = hubConfigs[COIN][NETWORK]["database"]["port"]
                    
                    //UTXO_TRACKER_URL = hubConfigs[COIN][NETWORK]["xchain-utxo-tracker"]["host"]
                    UTXO_TRACKER_URL = "localhost"
                    UTXO_TRACKER_PORT = hubConfigs[COIN][NETWORK]["xchain-utxo-tracker"]["server_port"]
                    
                    //ENCODER_URL = hubConfigs[COIN][NETWORK]["xchain-encoder"]["host"]
                    ENCODER_URL = "localhost"
                    ENCODER_PORT = hubConfigs[COIN][NETWORK]["xchain-encoder"]["server_port"]
                    
                    //INDEXER_URL = hubConfigs[COIN][NETWORK]["xchain-indexer"]["host"]
                    INDEXER_URL = "localhost"
                    INDEXER_PORT = hubConfigs[COIN][NETWORK]["xchain-indexer"]["server_port"]
                    INDEXER_DATABASE_NAME = hubConfigs[COIN][NETWORK]["xchain-indexer"]["name"]
                    INDEXER_DATABASE_USER = hubConfigs[COIN][NETWORK]["xchain-indexer"]["user"]
                    INDEXER_DATABASE_PASS = hubConfigs[COIN][NETWORK]["xchain-indexer"]["pass"]
                    
                    //REGTEST_MINER_URL = hubConfigs[COIN][NETWORK]["xchain-regtest-miner"]["host"]
                    REGTEST_MINER_URL = "localhost"
                    REGTEST_MINER_PORT = hubConfigs[COIN][NETWORK]["xchain-regtest-miner"]["server_port"]
                } else {
                    throw new Error("There was an error trying to get all the configs from the hub")
                }
            } else {
                throw new Error("Can't connect to the XChain Hub")
            }
            
            
        }
        
        global.nodeConnector = new BlockchainConnector(
            NODE_URL, NODE_PORT, NODE_USER, NODE_PASS
        )
        global.utxoTrackerConnector = new XChainUtxoTrackerConnector(UTXO_TRACKER_URL, UTXO_TRACKER_PORT)
        global.encoderConnector = new XChainEncoderConnector(ENCODER_URL, ENCODER_PORT)
        global.indexerConnector = new XChainIndexerConnector(INDEXER_URL, INDEXER_PORT)
        global.indexerDatabase = new Database(DATABASE_URL, DATABASE_PORT, INDEXER_DATABASE_NAME, INDEXER_DATABASE_USER, INDEXER_DATABASE_PASS)
        global.regtestMinerConnector = new RegtestMinerConnector(REGTEST_MINER_URL, REGTEST_MINER_PORT)
        
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
        
        let pingIndexer = await indexerConnector.ping()
        if (!pingIndexer){
            throw new Error("Can't connect to the XChain Indexer module")
        }
        
        let pingIndexerDatabase = await indexerDatabase.ping()
        if (!pingIndexerDatabase){
            throw new Error("Can't connect to the XChain Indexer Database")
        }       
        
        let pingRegtestMiner = await regtestMinerConnector.ping()
        if (!pingRegtestMiner){
            throw new Error("Can't connect to the XChain Regtest Miner module")
        } else {
            await regtestMinerConnector.setMiningTime(1000, 1000)
        }

        // Ensure the GAS token exists before any tests run
        console.log("Checking if GAS token ("+GAS_TICK+") exists...")
        const gasTokenExists = await indexerDatabase.checkIssue({ tick: GAS_TICK, status: 'valid' })
        if (!gasTokenExists) {
            console.log("GAS token not found, creating it...")
            let gasAddressInfo = await cryptoHelper.getNewFundedAddress("GAS.TOKEN", COIN, NETWORK, null, "legacy", 0, 1)
            await issueHelper.sendIssueV0(
                gasAddressInfo,
                GAS_TICK,
                1000000000,
                1000000,
                0,
                "XChain GAS Token",
                1000000
            )
            console.log("GAS token ("+GAS_TICK+") created successfully")
        } else {
            console.log("GAS token ("+GAS_TICK+") already exists")
        }
    },

    async afterAll(){
        try{
            await regtestMinerConnector.setDefaultMiningTime()
        } catch (err){
            console.log("There was a problem setting the default mining time values for the regtest miner")
        }
        //decoder.stop()
    }
}
