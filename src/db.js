const mariadb = require('mariadb');

class Database {
    constructor(host, port, dbName, user, pass){
        this.sqlPath  = __dirname+'/sql';
        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        const DUPLICATED_TRANSACTION = 1
        // Database connection parameters
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };
        // Database pool connection parameters
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            // Connection options
            connectionLimit:  10,
            //connectTimeout: 0,
            insertIdAsNumber: true
        };
        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Handle getting a database Connection    
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        var connection = null;
        while(connection == null){        
            try {
                connection = await this.pool.getConnection();
                // console.log("Connected to database!");
            } catch (e){
                console.log("Can't connect to mariadb. Trying again...");
                connection = null;
                await this.sleep(1000);
            }
        }
        return connection;
    }

    async ping(){
        const query = `
            SELECT 1 + 1;
        `
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query)
            if (rows.length > 0){
                return true
            } else {
                return false  
            }
        } catch (err) {
            console.error('Error with database ping:', err);
            return false
        } finally {
            await connection.release()
        }
    }

    async waitForIssue(issueObject, timeMax = 30000){
    
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let issueExists = await this.checkIssue(issueObject)
                
                if (issueExists){
                    return true
                }
                
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        
        return false
    }

    async checkIssue({source, tick, txHash, maxSupply, maxMint, decimals, description, 
            mintSupply, transferAddress, transferMintSupplyAddress, 
            lockMaxSupply, lockMint, lockMintSupply, lockMaxMint, lockDescription, lockRug, lockSleep,
            lockCallback, callbackBlock, callbackTickId, callbackAmount, allowList, blockList, 
            mintAddressMax, mintStartBlock, mintStopBlock, status}){

        let whereClauses = []
        let whereValues = []

        if (source != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(source)
        }
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (maxSupply != null){
            whereClauses.push("i.max_supply = ?")
            whereValues.push(maxSupply)
        }
        if (maxMint != null){
            whereClauses.push("i.max_mint = ?")
            whereValues.push(maxMint)
        }
        if (decimals != null){
            whereClauses.push("i.decimals = ?")
            whereValues.push(decimals)
        }
        if (description != null){
            whereClauses.push("i.description = ?")
            whereValues.push(description)
        }
        if (mintSupply != null){
            whereClauses.push("i.mint_supply = ?")
            whereValues.push(mintSupply)
        }
        if (status != null){
            whereClauses.push("ist.status = ?")
            whereValues.push(status)
        }
            
            
        const query = `
            SELECT i.*, itick.tick AS tick, itx.hash AS tx_hash, ia.address AS source FROM issues i
            LEFT JOIN actions act ON act.action_index = i.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = i.source_id
            LEFT JOIN index_tickers itick ON itick.id = i.tick_id
            LEFT JOIN index_statuses ist ON ist.id = i.status_id
        `+"WHERE "+whereClauses.join(" AND ");
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return true
            } else {
                return false  
            }
        } catch (err) {
            console.error('Error with database query:', err);
            return false;
        } finally {
            await connection.release()
        }
    }
    
    async waitForSend(sendObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let sendExists = await this.checkSend(sendObject)
                
                if (sendExists){
                    return true
                }
                
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        
        return false
    }
    
    async checkSend({source,destination,tick,amount,txHash,memo,status}){
    
        let whereClauses = []
        let whereValues = []
        
        if (source != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(source)
        }
        if (destination != null){
            whereClauses.push("ia2.address = ?")
            whereValues.push(destination)
        }
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (amount != null){
            whereClauses.push("amount = ?")
            whereValues.push(amount)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (memo != null){
            whereClauses.push("im.memo = ?")
            whereValues.push(memo)
        }
        if (status != null){
            whereClauses.push("ist.status = ?")
            whereValues.push(status)
        }
    
        const query = `
            SELECT s.*, itick.tick AS tick, itx.hash AS tx_hash, ia.address AS source, ia2.address AS destination, im.memo AS memo, ist.status AS status FROM sends s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = s.source_id
            LEFT JOIN index_addresses ia2 ON ia2.id = s.destination_id
            LEFT JOIN index_memos im ON im.id = s.memo_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            LEFT JOIN index_tickers itick ON itick.id = s.tick_id 
        `+"WHERE "+whereClauses.join(" AND ");
        
        let connection = await this.getConnection()
        
        try {
        const rows = await connection.query(query, whereValues)//[source,destination,tick,amount,txHash])
            if (rows.length > 0){
                return true
            } else {
                return false  
            }
        } catch (err) {
            console.error('Error with database query:', err);
            return false;
        } finally {
            await connection.release()
        }
    }
}

module.exports = Database