/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain End-to-End Test Suite - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Load required libraries
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
            SELECT i.*, 
                itick.tick AS tick, 
                itx.hash AS tx_hash, 
                ia.address AS source 
            FROM issues i
            LEFT JOIN actions act ON act.action_index = i.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
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
            console.error('Error with database query (issue):', err);
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
            SELECT s.*, 
                itick.tick AS tick, 
                itx.hash AS tx_hash, 
                ia.address AS source, 
                ia2.address AS destination, 
                im.memo AS memo, 
                ist.status AS status 
            FROM sends s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
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
            console.error('Error with database query (send):', err);
            return false;
        } finally {
            await connection.release()
        }
    }
    
    async waitForCredit(creditObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let creditExists = await this.checkCredit(creditObject)
                
                if (creditExists){
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
    
    async checkCredit({blockIndex,txHash,tick,address,amount}){
        let whereClauses = []
        let whereValues = []
        
        if (blockIndex != null){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (address != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(address)
        }
        if (amount != null){
            whereClauses.push("amount = ?")
            whereValues.push(amount)
        }
           
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                c.action_index,
                itick.tick AS tick,
                ia.address AS address,
                c.amount
            FROM credits c
            LEFT JOIN actions act ON act.action_index = c.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = c.address_id
            LEFT JOIN index_tickers itick ON itick.id = c.tick_id 
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
            console.error('Error with database query (credit):', err);
            return false;
        } finally {
            await connection.release()
        }
    }
    
    async waitForDebit(debitObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let debitExists = await this.checkDebit(debitObject)
                
                if (debitExists){
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
    
    async checkDebit({blockIndex,txHash,tick,address,amount}){
        let whereClauses = []
        let whereValues = []
        
        if (blockIndex != null){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (address != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(address)
        }
        if (amount != null){
            whereClauses.push("amount = ?")
            whereValues.push(amount)
        }
           
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                d.action_index,
                itick.tick AS tick,
                ia.address AS address,
                d.amount
            FROM debits d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = d.address_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id 
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
            console.error('Error with database query (debit):', err);
            return false;
        } finally {
            await connection.release()
        }
    }
    
    async waitForMint(mintObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let mintExists = await this.checkMint(mintObject)
                
                if (mintExists){
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
    
    async checkMint({blockIndex,txHash,tick,destination,amount,memo,status}){
        let whereClauses = []
        let whereValues = []
        
        if (blockIndex != null){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (destination != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(destination)
        }
        if (amount != null){
            whereClauses.push("m.amount = ?")
            whereValues.push(amount)
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
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                m.action_index,
                itick.tick AS tick,
                ia.address AS destination,
                m.amount,
                im.memo AS memo, 
                ist.status AS status 
            FROM mints m
            LEFT JOIN actions act ON act.action_index = m.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = m.destination_id
            LEFT JOIN index_memos im ON im.id = m.memo_id
            LEFT JOIN index_statuses ist ON ist.id = m.status_id
            LEFT JOIN index_tickers itick ON itick.id = m.tick_id 
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
            console.error('Error with database query (mint):', err);
            return false;
        } finally {
            await connection.release()
        }
    }
    
    async waitForBroadcast(broadcastObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let mintExists = await this.checkBroadcast(broadcastObject)
                
                if (mintExists){
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
    
    async checkBroadcast({blockIndex,txHash,source,message,value,fee,memo,broadcastActionIndex,status}){
        let whereClauses = []
        let whereValues = []
        
        if (blockIndex != null){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (source != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(source)
        }
        if (message != null){
            whereClauses.push("b.message = ?")
            whereValues.push(message)
        }
        if (value != null){
            whereClauses.push("b.value = ?")
            whereValues.push(value)
        }
        if (fee != null){
            whereClauses.push("b.fee = ?")
            whereValues.push(fee)
        }
        if (memo != null){
            whereClauses.push("im.memo = ?")
            whereValues.push(memo)
        }
        if (broadcastActionIndex != null){
            whereClauses.push("b.broadcast_action_index = ?")
            whereValues.push(broadcastActionIndex)
        }
        if (status != null){
            whereClauses.push("ist.status = ?")
            whereValues.push(status)
        }
         
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                b.action_index,
                ia.address AS source,
                b.message,
                b.value,
                b.fee,
                im.memo AS memo, 
                b.broadcast_action_index,
                ist.status AS status 
            FROM broadcasts b
            LEFT JOIN actions act ON act.action_index = b.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_memos im ON im.id = b.memo_id
            LEFT JOIN index_statuses ist ON ist.id = b.status_id
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
            console.error('Error with database query (broadcast):', err);
            return false;
        } finally {
            await connection.release()
        }
    }
    
    async waitForList(listObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let listExists = await this.checkList(listObject)
                
                if (listExists){
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
    
    async checkList({blockIndex,txHash,source,type,edit,listActionIndex,status,items}){
        let whereClauses = []
        let whereValues = []
        
        if (blockIndex != null){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (txHash != null){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (source != null){
            whereClauses.push("ia.address = ?")
            whereValues.push(source)
        }
        if (type != null){
            whereClauses.push("l.type = ?")
            whereValues.push(type)
        }
        if (edit != null){
            whereClauses.push("l.edit = ?")
            whereValues.push(edit)
        }
        if (listActionIndex != null){
            whereClauses.push("b.list_action_index = ?")
            whereValues.push(listActionIndex)
        }
        if (status != null){
            whereClauses.push("ist.status = ?")
            whereValues.push(status)
        }
         
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                l.action_index,
                ia.address AS source,
                l.type,
                l.edit,
                l.list_action_index,
                ist.status AS status 
            FROM lists l
            LEFT JOIN actions act ON act.action_index = l.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_statuses ist ON ist.id = l.status_id
        `+"WHERE "+whereClauses.join(" AND ");
        
        let connection = await this.getConnection()
        let newActionIndex = null
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                
                return true
            } else {
                return false  
            }
        } catch (err) {
            console.error('Error with database query (broadcast):', err);
            return false;
        } finally {
            await connection.release()
        }
        
        if (newActionIndex){
            let leftJoin = ""
            let fields = ""
            switch (type){
                case 1: //TICK
                    leftJoin = " LEFT JOIN index_tickers it ON it.id = li.item_id "
                    field = " it.tick AS item_name "
                    break
                case 2: //address
                    leftJoin = " LEFT JOIN index_addresses ia ON ia.id = li.item_id "
                    field = " ia.address AS item_name "
                    break
            }
            
            //Check the list's items
            const queryItems = "SELECT "+field+
                " FROM list_items li "+leftJoin+
                " WHERE li.action_index = ?"
            
            connection = await this.getConnection()
            
            try {
                const rows = await connection.query(queryItems, [newActionIndex])
                if (rows.length > 0){
                    let itemsClone = items.slice()
                    
                    for (let nextRowIndex in rows){
                        let nextRow = rows[nextRowIndex]
                        
                        let itemIndex = itemsClone.indexOf(nextRow["item_name"])
                        
                        if (itemIndex >= 0){
                            itemsClone.splice(itemIndex, 1)
                        }
                    }
                    
                    if (itemsClone.length == 0){
                        return true
                    } else {
                        return false
                    }
                } else {
                    return false  
                }
            } catch (err) {
                console.error('Error with database query (broadcast):', err);
                return false;
            } finally {
                await connection.release()
            }
        } else {
            return false
        }
    }
}

module.exports = Database