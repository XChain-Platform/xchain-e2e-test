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

    isNullOrNullString(value){
        return value == null || value == ""
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
            if (memo == ''){
                whereClauses.push("im.memo IS NULL")
            } else {
                whereClauses.push("im.memo = ?")
                whereValues.push(memo)
            }
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
                let broadcastActionIndex = await this.checkBroadcast(broadcastObject)

                if (broadcastActionIndex >= 0){
                    return broadcastActionIndex
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return -1
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
                return Number(rows[0]["action_index"])
            } else {
                return -1
            }
        } catch (err) {
            console.error('Error with database query (broadcast):', err);
            return -1;
        } finally {
            await connection.release()
        }
    }

    async waitForList(listObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let listActionIndex = await this.checkList(listObject)
                
                if (listActionIndex >= 0){
                    return listActionIndex
                }
                
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        
        return -1
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
                newActionIndex = rows[0]["action_index"]
            } else {
                return -1               
            }
        } catch (err) {
            console.error('Error with database query (broadcast):', err);
            return -1
        } finally {
            await connection.release()
        }
        
        if (newActionIndex){
            let leftJoin = ""
            let field = ""
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
                if (rows.length == items.length){
                    let itemsClone = items.slice()
                    
                    for (let nextRowIndex in rows){
                        let nextRow = rows[nextRowIndex]
                        
                        let itemIndex = itemsClone.indexOf(nextRow["item_name"])
                        
                        if (itemIndex >= 0){
                            itemsClone.splice(itemIndex, 1)
                        }
                    }
                    
                    if (itemsClone.length == 0){
                        return newActionIndex
                    } else {
                        console.log("ERROR! List items don't match with the items in the database")
                        return -1
                    }
                } else {
                    console.log("ERROR! List items don't have the same length as the items in the database")
                    return -1  
                }
            } catch (err) {
                console.error('Error with database query (broadcast):', err);
                return -1;
            } finally {
                await connection.release()
            }
        } else {
            console.error("ERROR! Couldn't find the new list action index");
            return -1
        }
    }
    
    async waitForAirdrop(airdropObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let airdropNewActionIndex = await this.checkAirdrop(airdropObject)
                
                if (airdropNewActionIndex >= 0){
                    return airdropNewActionIndex
                }
                
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        
        return -1
    }
    
    async getListAddresses(listActionIndex){
        let listType = null
            
        //Check the type of the list
        const queryList = "SELECT type FROM lists WHERE action_index = ?"
        
        let connection = await this.getConnection()
        
        try {
            const rows = await connection.query(queryList, [listActionIndex])
            if (rows.length > 0){
                listType = parseInt(rows[0]["type"])
            } else {
                console.log("ERROR! Couldn't get the type of a list")
                return null 
            }
        } catch (err) {
            console.log(err)
            return null
        } finally {
            await connection.release()
        }
        
        if (listType){
            let addressesQuery = null
            
            switch (listType){
                case 1: //TICK
                    addressesQuery = `
                        WITH totalCredits AS (
                        SELECT address_id, tick_id, SUM(amount) AS total
                        FROM credits
                        GROUP BY address_id, tick_id
                    ),
                    totalDebits AS (
                        SELECT address_id, tick_id, SUM(amount) AS total
                        FROM debits
                        GROUP BY address_id, tick_id
                    )
                    SELECT 
                        DISTINCT(ia.id) AS address `+
                        //, 
                        //ia.address, 
                        //it.id, 
                        //COALESCE(tc.total, 0) - COALESCE(td.total, 0) AS balance
                    `FROM index_addresses ia 
                    LEFT JOIN index_tickers it ON it.id IN (SELECT item_id FROM list_items WHERE action_index = ?)
                    LEFT JOIN totalCredits tc ON tc.tick_id = it.id AND tc.address_id = ia.id
                    LEFT JOIN totalDebits td ON td.tick_id = it.id AND td.address_id = ia.id
                    WHERE
                        COALESCE(tc.total, 0) > 0 OR COALESCE(td.total, 0) > 0;
                    `
                    break
                case 2: //address
                    addressesQuery = `
                        SELECT 
                            ia.id AS address
                        FROM list_items li
                        LEFT JOIN index_addresses ia ON ia.id = li.item_id
                        WHERE li.action_index = ?
                    `
                    break
            }
            
            
            try {
                connection = await this.getConnection()
                
                const rows = await connection.query(addressesQuery, [listActionIndex])
                let result = []
                    
                for (let nextRowIndex in rows){
                    result.push(rows[nextRowIndex]["address"])
                }
                    
                return result
            } catch (err) {
                console.log(err)
                console.error("Couldn't get a list of addresses from a list")
            }
        }
        
        console.log("ERROR: there is no list with action index "+listActionIndex)
        return null
    }
    
    async checkAirdrop({blockIndex,txHash,source,tick,amount,tick2,amount2,listActionIndex,listActionIndex2,memo,memo2,status}){
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
        if (tick != null){
            whereClauses.push("itick.tick = ?")
            whereValues.push(tick)
        }
        if (amount != null){
            whereClauses.push("a.amount = ?")
            whereValues.push(amount)
        }
        if (listActionIndex != null){
            whereClauses.push("a.list_action_index = ?")
            whereValues.push(listActionIndex)
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
                a.action_index,
                ia.address AS source,
                itick.tick AS tick,
                a.amount,
                im.memo,
                a.list_action_index,
                ist.status AS status 
            FROM airdrops a
            LEFT JOIN actions act ON act.action_index = a.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_statuses ist ON ist.id = a.status_id
            LEFT JOIN index_tickers itick ON itick.id = a.tick_id
            LEFT JOIN index_memos im ON im.id = a.memo_id
        `+"WHERE "+whereClauses.join(" AND ");
        
        let connection = await this.getConnection()
        let newActionIndex = null
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                newActionIndex = rows[0]["action_index"]
            } else {
                console.error('Error with database query: rows are empty');
                console.log(query)
                console.log(whereValues)
                return -1               
            }
        } catch (err) {
            console.error('Error with database query (airdrop):', err);
            return -1
        } finally {
            await connection.release()
        }
        
        //Check for a second tick
        if (tick2 != null){
            let tickClauseIndex = whereClauses.indexOf("itick.tick = ?")
            let tickAmountClauseIndex = whereClauses.indexOf("a.amount = ?")
            whereValues.splice(tickClauseIndex, 1, tick2)
            whereValues.splice(tickAmountClauseIndex, 1, amount2)
            
            if (listActionIndex2 != null){
                let listActionIndexClauseIndex = whereClauses.indexOf("a.list_action_index = ?")
                whereValues.splice(listActionIndexClauseIndex, 1, listActionIndex2)
            }
            
            if (memo2 != null){
                let memoClauseIndex = whereClauses.indexOf("im.memo = ?")
                whereValues.splice(memoClauseIndex, 1, memo2)
            }
            
            let connection = await this.getConnection()
            try {
                const rows = await connection.query(query, whereValues)
                if (rows.length > 0){
                    //Continue
                } else {
                    console.error('Error with database query: second airdrop does not exist');
                    console.log(query)
                    console.log(whereValues)
                    return -1               
                }
            } catch (err) {
                console.error('Error with database query (airdrop):', err);
                return -1
            } finally {
                await connection.release()
            }
        }
        
        if (newActionIndex){
            let addressesId = await this.getListAddresses(listActionIndex)
            let addressesId2 = null
            
            if (listActionIndex2){
                addressesId2 = await this.getListAddresses(listActionIndex2)
            } else {
                addressesId2 = addressesId
            }
            
            if (addressesId){
                let addressesIdArray = "("+addressesId.join(",")+")"            
                let addressesId2Array = "("+addressesId2.join(",")+")"   
                
                let checkCreditsQuery = `
                    SELECT DISTINCT(c.address_id) FROM credits c
                    LEFT JOIN actions act ON act.action_index = c.action_index
                    LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
                    LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
                    LEFT JOIN index_tickers itick ON itick.id = c.tick_id 
                    WHERE amount = ?
                        AND itx.hash = ?
                        AND itick.tick = ?
                `
                
                try {
                    const rows = await connection.query(
                        checkCreditsQuery+" AND address_id IN "+addressesIdArray, [
                            amount, //amount
                            txHash, //txHash
                            tick //tick's name
                        ]
                    )
                    if (rows.length == addressesId.length){
                        //return newActionIndex
                    } else {
                        console.error('Error: there are '+rows.length+" credits for an airdrop of "+addressesId.length+" addresses");
                        return -1               
                    }
                } catch (err) {
                    console.error('Error getting ', err);
                    return -1
                } finally {
                    await connection.release()
                }
                
                if (tick2 != null){
                    try {
                        const rows = await connection.query(
                            checkCreditsQuery+" AND address_id IN "+addressesId2Array, [
                                amount2, //amount
                                txHash, //txHash
                                tick2 //tick's name
                            ]
                        )
                        if (rows.length == addressesId2.length){
                            //continue
                        } else {
                            console.error('Error: there are '+rows.length+" credits for an airdrop of "+addressesId2.length+" addresses");
                            return -1               
                        }
                    } catch (err) {
                        console.error('Error getting ', err);
                        return -1
                    } finally {
                        await connection.release()
                    }
                }
                
                
                let checkDebitQuery = `
                    SELECT d.*, itick.tick as tick FROM debits d
                    LEFT JOIN actions act ON act.action_index = d.action_index
                    LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
                    LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
                    LEFT JOIN index_addresses ia ON ia.id = tr.source_id
                    LEFT JOIN index_tickers itick ON itick.id = d.tick_id 
                    WHERE ia.address = ?
                        AND d.amount = ?
                        AND itx.hash = ?
                        AND itick.tick = ?
                `
                
                try {
                    const rows = await connection.query(
                        checkDebitQuery, [
                            source, //address
                            amount*addressesId.length, //amount
                            txHash, //txHash
                            tick //tick's name
                        ]
                    )
                    if (rows.length == 1){
                        if ((rows[0]["tick"] == tick)
                            && (rows[0]["amount"] == amount*addressesId.length)
                        ){
                            //continue
                        } else {
                            console.error("The debits aren't right")
                            return -1
                        }
                    } else {
                        console.error("There should be 1 debit, "+rows.length+" found")
                        return -1               
                    }
                } catch (err) {
                    console.error('Error with query (obtaining an airdrop debit)', err);
                    return -1
                } finally {
                    await connection.release()
                }
                
                if (tick2 != null){
                    try {
                        const rows = await connection.query(
                            checkDebitQuery, [
                                source, //address
                                amount2*(addressesId2?addressesId2.length:addressesId.length), //amount
                                txHash, //txHash
                                tick2 //tick's name
                            ]
                        )
                        if (rows.length == 1){
                            if ((rows[0]["tick"] == tick2)
                                && (rows[0]["amount"] == amount2*addressesId2.length)
                            ){
                                //continue
                            } else {
                                console.error("The debits aren't right")
                                return -1
                            }
                        } else {
                            console.error("There should be 1 debit, "+rows.length+" found")
                            return -1               
                        }
                    } catch (err) {
                        console.error('Error with query (obtaining an airdrop debit)', err);
                        return -1
                    } finally {
                        await connection.release()
                    }
                    
                    return newActionIndex
                }
            } else {
                console.error("ERROR! Couldn't get addresses from list");
                return -1
            }
        } else {
            console.error("ERROR! Couldn't find the new airdrop action index");
            return -1
        }
    }
    
    async waitForDispenser(dispenserObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let dispenserActionIndex = await this.checkDispenser(dispenserObject)
                
                if (dispenserActionIndex >= 0){
                    return dispenserActionIndex
                }
                
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        
        return -1
    }
    
    async checkDispenser({blockIndex, txHash, source, giveCoin, giveTick, giveAmount, giveEscrow, 
      getCoin, getTick, getAmount, getAddress, fiatCode, fiatAmount,
      expiration, allowList, blockList, memo, status}){
        let whereClauses = []
        let whereValues = []
        
        if (!this.isNullOrNullString(blockIndex)){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (!this.isNullOrNullString(txHash)){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (!this.isNullOrNullString(source)){
            whereClauses.push("ias.address = ?")
            whereValues.push(source)
        }
        if (!this.isNullOrNullString(giveCoin)){
            whereClauses.push("give_ic.coin = ?")
            whereValues.push(giveCoin)
        }
        if (!this.isNullOrNullString(giveTick)){
            whereClauses.push("give_it.tick = ?")
            whereValues.push(giveTick)
        }
        if (!this.isNullOrNullString(giveAmount)){
            whereClauses.push("d.give_amount = ?")
            whereValues.push(giveAmount)
        }   
        if (!this.isNullOrNullString(giveEscrow)){
            whereClauses.push("d.give_escrow = ?")
            whereValues.push(giveEscrow)
        }   
        if (!this.isNullOrNullString(getCoin)){
            whereClauses.push("get_ic.coin = ?")
            whereValues.push(getCoin)
        }
        if (!this.isNullOrNullString(getTick)){
            whereClauses.push("get_it.tick = ?")
            whereValues.push(getTick)
        }
        if (!this.isNullOrNullString(getAmount)){
            whereClauses.push("d.get_amount = ?")
            whereValues.push(getAmount)
        }   
        if (!this.isNullOrNullString(getAddress)){
            whereClauses.push("get_ia.address = ?")
            whereValues.push(getAddress)
        } else {
            whereClauses.push("get_ia.address = ias.address")
        }
        if (!this.isNullOrNullString(fiatCode)){
            whereClauses.push("ifs.code = ?")
            whereValues.push(fiatCode)
        }   
        if (!this.isNullOrNullString(expiration)){
            whereClauses.push("d.expiration = ?")
            whereValues.push(expiration)
        }   
        if (!this.isNullOrNullString(allowList)){
            whereClauses.push("d.allow_list = ?")
            whereValues.push(allowList)
        }   
        if (!this.isNullOrNullString(blockList)){
            whereClauses.push("d.block_list = ?")
            whereValues.push(blockList)
        }   
        if (!this.isNullOrNullString(memo)){
            whereClauses.push("im.memo = ?")
            whereValues.push(memo)
        }   
        if (!this.isNullOrNullString(status)){
            whereClauses.push("ist.status = ?")
            whereValues.push(status)
        }
         
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                d.action_index,
                give_ic.coin AS give_coin,
                give_it.tick AS give_tick,
                d.give_amount,
                d.give_escrow,
                get_ic.coin AS get_coin,
                get_it.tick AS get_tick,
                d.get_amount,
                get_ia.address AS get_address,
                ifs.code AS fiat_code,
                d.fiat_amount,
                d.expiration,
                d.allow_list,
                d.block_list,
                im.memo AS memo,
                ist.status AS status 
            FROM dispensers d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = d.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = d.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = d.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = d.get_tick_id
            LEFT JOIN index_addresses get_ia ON get_ia.id = d.get_address_id
            LEFT JOIN index_fiats ifs ON ifs.id = d.fiat_id
            LEFT JOIN index_memos im ON im.id = d.memo_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+whereClauses.join(" AND ");
        
        let connection = await this.getConnection()
        let newActionIndex = null
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                newActionIndex = rows[0]["action_index"]
            } else {
                return -1               
            }
        } catch (err) {
            console.error('Error with database query (dispenser):', err);
            return -1
        } finally {
            await connection.release()
        }
        
        return newActionIndex
    }
    
    async waitForDispense(dispenseObject, timeMax = 30000){
        const endTime = Date.now() + timeMax
        
        while (Date.now() < endTime){
            try {
                let dispenseActionIndex = await this.checkDispense(dispenseObject)
                
                if (dispenseActionIndex >= 0){
                    return dispenseActionIndex
                }
                
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        
        return -1
    }
    
    async checkDispense({blockIndex, txHash, source, giveCoin,
      giveTick, giveAmount, getCoin, getTick, getAmount,
      destination, status}){
        let whereClauses = []
        let whereValues = []
        
        if (!this.isNullOrNullString(blockIndex)){
            whereClauses.push("tr.block_index = ?")
            whereValues.push(blockIndex)
        }
        if (!this.isNullOrNullString(txHash)){
            whereClauses.push("itx.hash = ?")
            whereValues.push(txHash)
        }
        if (!this.isNullOrNullString(source)){
            whereClauses.push("ias.address = ?")
            whereValues.push(source)
        }
        if (!this.isNullOrNullString(giveCoin)){
            whereClauses.push("give_ic.coin = ?")
            whereValues.push(giveCoin)
        }
        if (!this.isNullOrNullString(giveTick)){
            whereClauses.push("give_it.tick = ?")
            whereValues.push(giveTick)
        }
        if (!this.isNullOrNullString(giveAmount)){
            whereClauses.push("d.give_amount = ?")
            whereValues.push(giveAmount)
        }   
        if (!this.isNullOrNullString(getCoin)){
            whereClauses.push("get_ic.coin = ?")
            whereValues.push(getCoin)
        }
        if (!this.isNullOrNullString(getTick)){
            whereClauses.push("get_it.tick = ?")
            whereValues.push(getTick)
        }
        if (!this.isNullOrNullString(getAmount)){
            whereClauses.push("d.get_amount = ?")
            whereValues.push(getAmount)
        }   
        if (!this.isNullOrNullString(destination)){
            whereClauses.push("iad.address = ?")
            whereValues.push(destination)
        }    
        if (!this.isNullOrNullString(status)){
            whereClauses.push("ist.status = ?")
            whereValues.push(status)
        }
         
        const query = `
            SELECT 
                tr.block_index AS block_index,
                itx.hash AS tx_hash,
                d.action_index,
                ias.address as source,
                d.dispenser_action_index,
                give_ic.coin AS give_coin,
                give_it.tick AS give_tick,
                d.give_amount,
                get_ic.coin AS get_coin,
                get_it.tick AS get_tick,
                d.get_amount,
                iad.address AS destination,
                ist.status AS status 
            FROM dispenses d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = d.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = d.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = d.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = d.get_tick_id
            LEFT JOIN index_addresses iad ON iad.id = d.destination_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+whereClauses.join(" AND ");
        
        let connection = await this.getConnection()
        let newActionIndex = null
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                newActionIndex = rows[0]["action_index"]
            } else {
                return -1               
            }
        } catch (err) {
            console.error('Error with database query (dispense):', err);
            return -1
        } finally {
            await connection.release()
        }
        
        return newActionIndex
    }
}

module.exports = Database