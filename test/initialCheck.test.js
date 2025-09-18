const dotenv = require('dotenv')
dotenv.config()

const BlockchainConnector = require('../src/BlockchainConnector.js')
const XChainUtxoTrackerConnector = require('../src/XChainUtxoTrackerConnector.js')
const XChainEncoderConnector = require('../src/XChainEncoderConnector.js')
const XChainHubConnector = require('../src/XChainHubConnector.js')
const XChainIndexerConnector = require('../src/XChainIndexerConnector.js')
const RegtestMinerConnector = require('../src/RegtestMinerConnector.js')
const Database = require('../src/db.js')

global.COIN = process.env.COIN
global.NETWORK = process.env.NETWORK
const HUB_URL =  process.env.HUB_URL
const HUB_PORT =  process.env.HUB_PORT

exports.mochaHooks = {
    async beforeAll(){
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
                global.nodeConnector = new BlockchainConnector(
                    NODE_URL, NODE_PORT, NODE_USER, NODE_PASS
                )
                
                //DATABASE_URL = hubConfigs[COIN][NETWORK]["database"]["host"]
                DATABASE_URL = "localhost"
                DATABASE_PORT = hubConfigs[COIN][NETWORK]["database"]["port"]
                
                try {
                    let pingNode = await nodeConnector.getNetworkInfo()
                    
                    if (!pingNode){
                        throw new Error("Can't connect to the node")
                    }
                } catch (err){
                    console.log(err)
                    throw new Error("There was an error trying to connect to the node")
                }
                
                //UTXO_TRACKER_URL = hubConfigs[COIN][NETWORK]["xchain-utxo-tracker"]["host"]
                UTXO_TRACKER_URL = "localhost"
                UTXO_TRACKER_PORT = hubConfigs[COIN][NETWORK]["xchain-utxo-tracker"]["server_port"]
                
                global.utxoTrackerConnector = new XChainUtxoTrackerConnector(UTXO_TRACKER_URL, UTXO_TRACKER_PORT)
                
                let pingUtxoTracker = await utxoTrackerConnector.ping()
                
                if (!pingUtxoTracker){
                    throw new Error("Can't connect to the XChain Utxo Tracker module")
                }
                
                //ENCODER_URL = hubConfigs[COIN][NETWORK]["xchain-encoder"]["host"]
                ENCODER_URL = "localhost"
                ENCODER_PORT = hubConfigs[COIN][NETWORK]["xchain-encoder"]["server_port"]
                
                global.encoderConnector = new XChainEncoderConnector(ENCODER_URL, ENCODER_PORT)
                
                let pingEncoder = await encoderConnector.ping()
                
                if (!pingEncoder){
                    throw new Error("Can't connect to the XChain Encoder module")
                }
                
                //INDEXER_URL = hubConfigs[COIN][NETWORK]["xchain-indexer"]["host"]
                INDEXER_URL = "localhost"
                INDEXER_PORT = hubConfigs[COIN][NETWORK]["xchain-indexer"]["server_port"]
                INDEXER_DATABASE_NAME = hubConfigs[COIN][NETWORK]["xchain-indexer"]["name"]
                INDEXER_DATABASE_USER = hubConfigs[COIN][NETWORK]["xchain-indexer"]["user"]
                INDEXER_DATABASE_PASS = hubConfigs[COIN][NETWORK]["xchain-indexer"]["pass"]
                
                global.indexerConnector = new XChainIndexerConnector(INDEXER_URL, INDEXER_PORT)
                
                let pingIndexer = await indexerConnector.ping()
                
                if (!pingIndexer){
                    throw new Error("Can't connect to the XChain Indexer module")
                }
                
                global.indexerDatabase = new Database(DATABASE_URL, DATABASE_PORT, INDEXER_DATABASE_NAME, INDEXER_DATABASE_USER, INDEXER_DATABASE_PASS)
                
                let pingIndexerDatabase = await indexerDatabase.ping()
                
                if (!pingIndexerDatabase){
                    throw new Error("Can't connect to the XChain Indexer Database")
                }
                
                
                //REGTEST_MINER_URL = hubConfigs[COIN][NETWORK]["xchain-regtest-miner"]["host"]
                REGTEST_MINER_URL = "localhost"
                REGTEST_MINER_PORT = hubConfigs[COIN][NETWORK]["xchain-regtest-miner"]["server_port"]
                
                global.regtestMinerConnector = new RegtestMinerConnector(REGTEST_MINER_URL, REGTEST_MINER_PORT)
                
                let pingRegtestMiner = await regtestMinerConnector.ping()
                
                if (!pingRegtestMiner){
                    throw new Error("Can't connect to the XChain Regtest Miner module")
                }
            } else {
                throw new Error("There was an error trying to get all the configs from the hub")
            }
        } else {
            throw new Error("Can't connect to the XChain Hub")
        }
    },

    async afterAll(){
        //decoder.stop()
    }
}
