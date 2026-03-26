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
                let row = await this.checkIssue(issueObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
                ia.address AS source,
                ist.status AS status
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
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (issue):', err);
            return null;
        } finally {
            await connection.release()
        }
    }
    
    async waitForSend(sendObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkSend(sendObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
        const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (send):', err);
            return null;
        } finally {
            await connection.release()
        }
    }
    
    async waitForCredit(creditObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkCredit(creditObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (credit):', err);
            return null;
        } finally {
            await connection.release()
        }
    }
    
    async waitForDebit(debitObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkDebit(debitObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (debit):', err);
            return null;
        } finally {
            await connection.release()
        }
    }
    
    async waitForMint(mintObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkMint(mintObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (mint):', err);
            return null;
        } finally {
            await connection.release()
        }
    }
    
    async waitForBroadcast(broadcastObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkBroadcast(broadcastObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (broadcast):', err);
            return null;
        } finally {
            await connection.release()
        }
    }

    async waitForList(listObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkList(listObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
        let listRow = null
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                listRow = rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (list):', err);
            return null
        } finally {
            await connection.release()
        }

        if (listRow){
            let newActionIndex = listRow["action_index"]
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
                        return listRow
                    } else {
                        console.log("ERROR! List items don't match with the items in the database")
                        return null
                    }
                } else {
                    console.log("ERROR! List items don't have the same length as the items in the database")
                    return null
                }
            } catch (err) {
                console.error('Error with database query (list items):', err);
                return null;
            } finally {
                await connection.release()
            }
        } else {
            console.error("ERROR! Couldn't find the new list action index");
            return null
        }
    }
    
    async waitForAirdrop(airdropObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkAirdrop(airdropObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
    
    async checkAirdrop({blockIndex,txHash,source,tick,amount,listActionIndex,memo,status}){
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
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (airdrop):', err);
            return null
        } finally {
            await connection.release()
        }
    }
    
    async waitForDispenser(dispenserObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkDispenser(dispenserObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (dispenser):', err);
            return null
        } finally {
            await connection.release()
        }
    }
    
    async waitForDispense(dispenseObject, timeMax = 30000){
        const endTime = Date.now() + timeMax

        while (Date.now() < endTime){
            try {
                let row = await this.checkDispense(dispenseObject)

                if (row){
                    return row
                }

                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }

        return null
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
        try {
            const rows = await connection.query(query, whereValues)
            if (rows.length > 0){
                return rows[0]
            } else {
                return null
            }
        } catch (err) {
            console.error('Error with database query (dispense):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── DISPENSER STATUS ────────────────────────────────────────────────
    async waitForDispenserStatus(obj, timeMax = 30000){ return this._waitFor(this.checkDispenserStatus, obj, timeMax) }

    async checkDispenserStatus({dispenserActionIndex, status}){
        let w = [], v = []
        if (dispenserActionIndex != null){ w.push("ds.dispenser_action_index = ?"); v.push(dispenserActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT ds.action_index, ds.dispenser_action_index, ist.status AS status
            FROM dispenser_statuses ds
            LEFT JOIN index_statuses ist ON ist.id = ds.status_id
        `+"WHERE "+w.join(" AND ")+" ORDER BY ds.action_index DESC LIMIT 1";
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (dispenser_status):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── Generic waitFor wrapper ───────────────────────────────────────
    async _waitFor(checkFn, params, timeMax = 30000){
        const endTime = Date.now() + timeMax
        while (Date.now() < endTime){
            try {
                let row = await checkFn.call(this, params)
                if (row) return row
                await this.sleep(1000)
            } catch(err) {
                console.log(err)
                await this.sleep(1000)
            }
        }
        return null
    }

    // ─── ADDRESS ───────────────────────────────────────────────────────
    async waitForAddressOption(obj, timeMax = 30000){ return this._waitFor(this.checkAddressOption, obj, timeMax) }

    async checkAddressOption({txHash, source, feePreference, requireMemo, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (feePreference != null){ w.push("ao.fee_preference = ?"); v.push(feePreference) }
        if (requireMemo != null){ w.push("ao.require_memo = ?"); v.push(requireMemo) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT ao.*, itx.hash AS tx_hash, ia.address AS source, im.memo AS memo, ist.status AS status
            FROM addresses ao
            LEFT JOIN actions act ON act.action_index = ao.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_memos im ON im.id = ao.memo_id
            LEFT JOIN index_statuses ist ON ist.id = ao.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (address):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── DESTROY ───────────────────────────────────────────────────────
    async waitForDestroy(obj, timeMax = 30000){ return this._waitFor(this.checkDestroy, obj, timeMax) }

    async checkDestroy({txHash, source, tick, amount, memo, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (amount != null){ w.push("d.amount = ?"); v.push(amount) }
        if (memo != null){ w.push("im.memo = ?"); v.push(memo) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT d.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, im.memo AS memo, ist.status AS status
            FROM destroys d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id
            LEFT JOIN index_memos im ON im.id = d.memo_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (destroy):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── MESSAGE ───────────────────────────────────────────────────────
    async waitForMessage(obj, timeMax = 30000){ return this._waitFor(this.checkMessage, obj, timeMax) }

    async checkMessage({txHash, source, destination, plaintextMessage, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (destination != null){ w.push("iad.address = ?"); v.push(destination) }
        if (plaintextMessage != null){ w.push("m.plaintext_message = ?"); v.push(plaintextMessage) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT m.*, itx.hash AS tx_hash, ias.address AS source, iad.address AS destination, ist.status AS status
            FROM messages m
            LEFT JOIN actions act ON act.action_index = m.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_addresses iad ON iad.id = m.destination_id
            LEFT JOIN index_statuses ist ON ist.id = m.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (message):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── FILE ──────────────────────────────────────────────────────────
    async waitForFile(obj, timeMax = 30000){ return this._waitFor(this.checkFile, obj, timeMax) }

    async checkFile({txHash, source, name, title, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (name != null){ w.push("f.name = ?"); v.push(name) }
        if (title != null){ w.push("f.title = ?"); v.push(title) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT f.*, itx.hash AS tx_hash, ia.address AS source, im.memo AS memo, ist.status AS status
            FROM files f
            LEFT JOIN actions act ON act.action_index = f.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_memos im ON im.id = f.memo_id
            LEFT JOIN index_statuses ist ON ist.id = f.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (file):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── SLEEP ─────────────────────────────────────────────────────────
    async waitForSleep(obj, timeMax = 30000){ return this._waitFor(this.checkSleep, obj, timeMax) }

    async checkSleep({txHash, source, type, tick, resumeBlock, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (type != null){ w.push("s.type = ?"); v.push(type) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (resumeBlock != null){ w.push("s.resume_block = ?"); v.push(resumeBlock) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT s.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, im.memo AS memo, ist.status AS status
            FROM sleeps s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = s.tick_id
            LEFT JOIN index_memos im ON im.id = s.memo_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (sleep):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── SWEEP ─────────────────────────────────────────────────────────
    async waitForSweep(obj, timeMax = 30000){ return this._waitFor(this.checkSweep, obj, timeMax) }

    async checkSweep({txHash, source, destination, balances, ownerships, escrows, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (destination != null){ w.push("iad.address = ?"); v.push(destination) }
        if (balances != null){ w.push("sw.balances = ?"); v.push(balances) }
        if (ownerships != null){ w.push("sw.ownerships = ?"); v.push(ownerships) }
        if (escrows != null){ w.push("sw.escrows = ?"); v.push(escrows) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT sw.*, itx.hash AS tx_hash, ias.address AS source, iad.address AS destination, im.memo AS memo, ist.status AS status
            FROM sweeps sw
            LEFT JOIN actions act ON act.action_index = sw.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_addresses iad ON iad.id = sw.destination_id
            LEFT JOIN index_memos im ON im.id = sw.memo_id
            LEFT JOIN index_statuses ist ON ist.id = sw.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (sweep):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── DIVIDEND ──────────────────────────────────────────────────────
    async waitForDividend(obj, timeMax = 30000){ return this._waitFor(this.checkDividend, obj, timeMax) }

    async checkDividend({txHash, source, tick, dividendTick, amount, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (dividendTick != null){ w.push("itick2.tick = ?"); v.push(dividendTick) }
        if (amount != null){ w.push("d.amount = ?"); v.push(amount) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT d.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, itick2.tick AS dividend_tick, im.memo AS memo, ist.status AS status
            FROM dividends d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id
            LEFT JOIN index_tickers itick2 ON itick2.id = d.dividend_tick_id
            LEFT JOIN index_memos im ON im.id = d.memo_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (dividend):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── CALLBACK ──────────────────────────────────────────────────────
    async waitForCallback(obj, timeMax = 30000){ return this._waitFor(this.checkCallback, obj, timeMax) }

    async checkCallback({txHash, source, tick, callbackTick, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (callbackTick != null){ w.push("itick2.tick = ?"); v.push(callbackTick) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT c.*, itx.hash AS tx_hash, ia.address AS source, itick.tick AS tick, itick2.tick AS callback_tick, im.memo AS memo, ist.status AS status
            FROM callbacks c
            LEFT JOIN actions act ON act.action_index = c.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_tickers itick ON itick.id = c.tick_id
            LEFT JOIN index_tickers itick2 ON itick2.id = c.callback_tick_id
            LEFT JOIN index_memos im ON im.id = c.memo_id
            LEFT JOIN index_statuses ist ON ist.id = c.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (callback):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── ORDER ─────────────────────────────────────────────────────────
    async waitForOrder(obj, timeMax = 30000){ return this._waitFor(this.checkOrder, obj, timeMax) }

    async checkOrder({txHash, source, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount, getAddress, expiration, status, orderStatus}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (giveCoin != null){ w.push("give_ic.coin = ?"); v.push(giveCoin) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        if (giveAmount != null){ w.push("o.give_amount = ?"); v.push(giveAmount) }
        if (getCoin != null){ w.push("get_ic.coin = ?"); v.push(getCoin) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (getAmount != null){ w.push("o.get_amount = ?"); v.push(getAmount) }
        if (getAddress != null){ w.push("get_ia.address = ?"); v.push(getAddress) }
        if (expiration != null){ w.push("o.expiration = ?"); v.push(expiration) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (orderStatus != null){ w.push("os_ist.status = ?"); v.push(orderStatus) }
        const query = `
            SELECT o.*, itx.hash AS tx_hash, ias.address AS source,
                give_ic.coin AS give_coin, give_it.tick AS give_tick,
                get_ic.coin AS get_coin, get_it.tick AS get_tick,
                get_ia.address AS get_address, im.memo AS memo, ist.status AS status,
                os_ist.status AS order_status
            FROM orders o
            LEFT JOIN actions act ON act.action_index = o.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = o.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = o.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = o.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = o.get_tick_id
            LEFT JOIN index_addresses get_ia ON get_ia.id = o.get_address_id
            LEFT JOIN index_memos im ON im.id = o.memo_id
            LEFT JOIN index_statuses ist ON ist.id = o.status_id
            LEFT JOIN order_statuses os ON os.order_action_index = o.action_index
                AND os.action_index = (SELECT MAX(os2.action_index) FROM order_statuses os2 WHERE os2.order_action_index = o.action_index)
            LEFT JOIN index_statuses os_ist ON os_ist.id = os.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (order):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── ORDER MATCH ──────────────────────────────────────────────────
    async waitForOrderMatch(obj, timeMax = 30000){ return this._waitFor(this.checkOrderMatch, obj, timeMax) }

    async checkOrderMatch({giveActionIndex, getActionIndex, giveTick, getTick, giveAmount, getAmount, status}){
        let w = [], v = []
        if (giveActionIndex != null){ w.push("om.give_action_index = ?"); v.push(giveActionIndex) }
        if (getActionIndex != null){ w.push("om.get_action_index = ?"); v.push(getActionIndex) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (giveAmount != null){ w.push("om.give_amount = ?"); v.push(giveAmount) }
        if (getAmount != null){ w.push("om.get_amount = ?"); v.push(getAmount) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT om.*,
                give_it.tick AS give_tick, get_it.tick AS get_tick,
                ist.status AS status
            FROM order_matches om
            LEFT JOIN index_tickers give_it ON give_it.id = om.give_tick_id
            LEFT JOIN index_tickers get_it ON get_it.id = om.get_tick_id
            LEFT JOIN index_statuses ist ON ist.id = om.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (order_match):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── SWAP ──────────────────────────────────────────────────────────
    async waitForSwap(obj, timeMax = 30000){ return this._waitFor(this.checkSwap, obj, timeMax) }

    async checkSwap({txHash, source, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount, getAddress, expiration, status, swapStatus}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (giveCoin != null){ w.push("give_ic.coin = ?"); v.push(giveCoin) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        if (giveAmount != null){ w.push("s.give_amount = ?"); v.push(giveAmount) }
        if (getCoin != null){ w.push("get_ic.coin = ?"); v.push(getCoin) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (getAmount != null){ w.push("s.get_amount = ?"); v.push(getAmount) }
        if (getAddress != null){ w.push("get_ia.address = ?"); v.push(getAddress) }
        if (expiration != null){ w.push("s.expiration = ?"); v.push(expiration) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (swapStatus != null){ w.push("ss_ist.status = ?"); v.push(swapStatus) }
        const query = `
            SELECT s.*, itx.hash AS tx_hash, ias.address AS source,
                give_ic.coin AS give_coin, give_it.tick AS give_tick,
                get_ic.coin AS get_coin, get_it.tick AS get_tick,
                get_ia.address AS get_address, im.memo AS memo, ist.status AS status,
                ss_ist.status AS swap_status
            FROM swaps s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = tr.source_id
            LEFT JOIN index_coins give_ic ON give_ic.id = s.give_coin_id
            LEFT JOIN index_tickers give_it ON give_it.id = s.give_tick_id
            LEFT JOIN index_coins get_ic ON get_ic.id = s.get_coin_id
            LEFT JOIN index_tickers get_it ON get_it.id = s.get_tick_id
            LEFT JOIN index_addresses get_ia ON get_ia.id = s.get_address_id
            LEFT JOIN index_memos im ON im.id = s.memo_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            LEFT JOIN swap_statuses ss ON ss.swap_action_index = s.action_index
                AND ss.action_index = (SELECT MAX(ss2.action_index) FROM swap_statuses ss2 WHERE ss2.swap_action_index = s.action_index)
            LEFT JOIN index_statuses ss_ist ON ss_ist.id = ss.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (swap):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── BATCH ─────────────────────────────────────────────────────────
    async waitForBatch(obj, timeMax = 30000){ return this._waitFor(this.checkBatch, obj, timeMax) }

    async checkBatch({txHash, source, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT b.*, itx.hash AS tx_hash, ia.address AS source, ist.status AS status
            FROM batches b
            LEFT JOIN actions act ON act.action_index = b.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_statuses ist ON ist.id = b.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (batch):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── LINK ──────────────────────────────────────────────────────────
    async waitForLink(obj, timeMax = 30000){ return this._waitFor(this.checkLink, obj, timeMax) }

    async checkLink({txHash, source, coin1, coin1ActionIndex, coin2, coin2ActionIndex, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ia.address = ?"); v.push(source) }
        if (coin1 != null){ w.push("ic1.coin = ?"); v.push(coin1) }
        if (coin1ActionIndex != null){ w.push("l.coin1_action_index = ?"); v.push(coin1ActionIndex) }
        if (coin2 != null){ w.push("ic2.coin = ?"); v.push(coin2) }
        if (coin2ActionIndex != null){ w.push("l.coin2_action_index = ?"); v.push(coin2ActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT l.*, itx.hash AS tx_hash, ia.address AS source,
                ic1.coin AS coin1, ic2.coin AS coin2, im.memo AS memo, ist.status AS status
            FROM links l
            LEFT JOIN actions act ON act.action_index = l.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = tr.source_id
            LEFT JOIN index_coins ic1 ON ic1.id = l.coin1_id
            LEFT JOIN index_coins ic2 ON ic2.id = l.coin2_id
            LEFT JOIN index_memos im ON im.id = l.memo_id
            LEFT JOIN index_statuses ist ON ist.id = l.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (link):', err);
            return null
        } finally {
            await connection.release()
        }
    }
}

module.exports = Database