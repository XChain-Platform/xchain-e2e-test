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
 * XChain End-to-End Test Suite - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// : the driver is resolved when a pool is created, NOT when this module is
// loaded. Tests mock mariadb by injecting a synthetic module into require.cache,
// and a module-level binding froze whichever driver happened to be cached the
// first time anything in the mocha process required this file. A new test file
// sorting alphabetically earlier than the injecting one left db.js bound to the
// REAL driver, so every `new Database()` opened a real pool against a dead host:
// 55 failures across unrelated describes, all timeouts pointing nowhere near the
// cause, and the injecting file still passed alone. require() re-reads
// require.cache on every call, so looking the driver up here makes injection
// order-independent: it only has to happen before the first `new Database()`.
function mariadbDriver(){ return require('mariadb'); }

class Database {
    constructor(host, port, dbName, user, pass){
        this.sqlPath  = __dirname+'/sql';
        //  adaptive-wait tunables. Extensions are bounded so a wedged stack
        // still fails; the lag threshold is above zero so ordinary one-block skew
        // between the RPC tip and the indexer does not count as "behind".
        this.WAIT_MAX_EXTENSIONS = parseInt(process.env.E2E_WAIT_MAX_EXTENSIONS) || 3;
        this.WAIT_LAG_BLOCKS     = parseInt(process.env.E2E_WAIT_LAG_BLOCKS) || 2;
        this.WAIT_LAG_PROBE_MS   = parseInt(process.env.E2E_WAIT_LAG_PROBE_MS) || 2000;
        this.WAIT_MIN_FOR_EXTENSION = parseInt(process.env.E2E_WAIT_MIN_FOR_EXTENSION) || 5000;
        // The second progress signal (see _waitFor): how often a long wait samples
        // pipeline progress, and how recently action rows must have landed for the
        // indexer to count as "still writing". The sample interval is floored so a
        // wait cannot spend its budget probing, and the idle window is at least two
        // intervals so two samples taken moments apart cannot read as a stall.
        this.WAIT_PROBE_INTERVAL_MS = parseInt(process.env.E2E_WAIT_PROBE_INTERVAL_MS) || 10000;
        this.WAIT_PROBE_MIN_MS      = parseInt(process.env.E2E_WAIT_PROBE_MIN_MS) || 1000;
        this.WAIT_WRITE_IDLE_MS     = parseInt(process.env.E2E_WAIT_WRITE_IDLE_MS) || 20000;
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        const DUPLICATED_TRANSACTION = 1
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            connectionLimit:  10,
            //connectTimeout: 0,
            insertIdAsNumber: true,
            // BIGINT columns (action_index, tx_index, …) must deserialize as Number, not
            // BigInt: the consensus hash serializes a BigInt as a quoted string, so a pool
            // without this diverges from the indexer/sync prod pools (both set bigIntAsNumber);
            // it made consensusHashConformance falsely RED on every block with such columns.
            bigIntAsNumber:   true
        };
        this.pool = mariadbDriver().createPool(this.connectionPoolParams);
        this.transactionConnection = null;
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    isNullOrNullString(value){
        return value == null || value == ""
    }

    _recordPerfPoll(method, startMs, polls, resolved) {
        try {
            const collector = require('../test/perf/perfCollector')
            collector.recordPoll({ method, startMs, endMs: Date.now(), polls, resolved })
        } catch (e) {
            // perfCollector not loaded (unit tests, etc.); silently skip
        }
    }

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

    async waitForIssue(issueObject, timeMax = 60000){ return this._waitFor(this.checkIssue, issueObject, timeMax) }

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
    
    async waitForSend(sendObject, timeMax = 60000){ return this._waitFor(this.checkSend, sendObject, timeMax) }
    
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
    
    async waitForCredit(creditObject, timeMax = 60000){ return this._waitFor(this.checkCredit, creditObject, timeMax) }
    
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
    
    async waitForDebit(debitObject, timeMax = 60000){ return this._waitFor(this.checkDebit, debitObject, timeMax) }
    
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
    
    async waitForMint(mintObject, timeMax = 60000){ return this._waitFor(this.checkMint, mintObject, timeMax) }
    
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
    
    async waitForBroadcast(broadcastObject, timeMax = 60000){ return this._waitFor(this.checkBroadcast, broadcastObject, timeMax) }
    
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

    async waitForList(listObject, timeMax = 60000){ return this._waitFor(this.checkList, listObject, timeMax) }
    
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
    
    async waitForAirdrop(airdropObject, timeMax = 60000){ return this._waitFor(this.checkAirdrop, airdropObject, timeMax) }
    
    async getListAddresses(listActionIndex){
        let listType = null
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
                console.error("Couldn't get a list of addresses from a list:", err);
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
    
    async waitForDispenser(dispenserObject, timeMax = 60000){ return this._waitFor(this.checkDispenser, dispenserObject, timeMax) }
    
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
    
    async waitForDispense(dispenseObject, timeMax = 60000){ return this._waitFor(this.checkDispense, dispenseObject, timeMax) }
    
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
    async waitForDispenserStatus(obj, timeMax = 60000){ return this._waitFor(this.checkDispenserStatus, obj, timeMax) }

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
    // Default 60s (was 30s). Under full-suite load (especially the OWNERSHIP
    // suite right after ORDER's 7-test pile of MINTs/SENDs/ORDERs) the indexer
    // sometimes needs >30s to write an ORDER row (match-scan + balance/token
    // updates fan out per insert). 60s absorbs that without masking real
    // assertion failures, which surface as null on a row that was never written.
    // . Every waitForX in this file routes through here, so this is the one
    // place that decides how long a suite is willing to wait for a row.
    //
    // A fixed deadline silently assumes a quiet machine. Under concurrent load the
    // indexer falls behind the chain and a row that WILL arrive gets reported
    // missing purely because the indexer had not reached its block yet. That is
    // what made the dispenser suite fail a DIFFERENT case on every full run while
    // each one passed in isolation, and it reads like a product defect rather than
    // a slow venue: the action is later found in the database, correct.
    //
    // The tempting signal, "the chain is still advancing", is WRONG here: the
    // regtest miner mines continuously, so it is always true and the wait would
    // never end. Two signals ARE safe, because each one goes quiet exactly when
    // waiting longer stops being useful:
    //
    //   1. indexer LAG. The indexer has not reached the block our row would be in,
    //      so the row cannot exist yet. Falls to zero when the indexer catches up.
    //   2. action-row WRITES. MAX(action_index) is still climbing, so the indexer
    //      is chewing through real work and our row may be in the queue behind it.
    //      This is the signal lag cannot see, and the one the observed failures
    //      needed: every one of them was a wait for a ROW while the indexer kept
    //      pace with blocks, so lag read zero and bought no time. Crucially this is
    //      NOT the rejected "chain is advancing" signal: the miner's empty regtest
    //      blocks carry no actions, so an idle stack does not move this mark and a
    //      genuinely absent row still fails on the original deadline.
    //
    // Neither signal can be sampled once at the deadline: "still writing" is a
    // comparison, so the wait samples progress periodically while it runs and asks
    // at the deadline whether rows landed recently.
    //
    // Considered and rejected as a third signal: a non-empty mempool (the
    // confirmation-latency case). A single stuck transaction would hold it true
    // forever and inflate every genuine failure to the full extension budget, and
    // unlike the other two it never goes quiet on its own.
    //
    // Extensions are capped so a wedged stack still fails a suite instead of
    // hanging it forever, and each one is logged so a slow run stays diagnosable
    // after the fact.
    async _waitFor(checkFn, params, timeMax = 60000){
        const startMs = Date.now()
        const label   = checkFn.name || 'unknown'
        let deadline   = startMs + timeMax
        let extensions = 0
        let polls      = 0
        // Retained for the give-up report below: the last answers the probe gave
        // (null means it could not answer) and whether it was ever consulted.
        let lastLag    = null
        let probes     = 0
        let writeMark  = null   // highest action_index the indexer has written
        let writeMoved = null   // when that mark last advanced
        // Only waits that were meant to be long can be extended. Short waits are
        // callers polling for something that should be immediate, and probing on
        // their behalf costs more than it can ever save.
        const eligible = timeMax >= this.WAIT_MIN_FOR_EXTENSION
        // Sample often enough that even a short eligible wait gets two samples to
        // compare, since one sample carries no write signal at all.
        const probeEvery = Math.max(this.WAIT_PROBE_MIN_MS,
                                    Math.min(this.WAIT_PROBE_INTERVAL_MS, Math.floor(timeMax / 3)))
        const writeIdleMs = Math.max(this.WAIT_WRITE_IDLE_MS, probeEvery * 2)
        let nextProbeAt = startMs + probeEvery

        while (Date.now() < deadline){
            polls++
            try {
                let row = await checkFn.call(this, params)
                if (row) {
                    this._recordPerfPoll(label, startMs, polls, true)
                    return row
                }
            } catch(err) {
                console.log(err)
            }
            await this.sleep(1000)

            if (!eligible) continue
            const expired = Date.now() >= deadline
            // Budget spent: stop probing and let the loop end, so a wedged stack
            // fails on time instead of paying for advice it can no longer act on.
            if (expired && extensions >= this.WAIT_MAX_EXTENSIONS) continue
            if (!expired && Date.now() < nextProbeAt) continue

            const progress = await this._pipelineProgress()
            probes++
            nextProbeAt = Date.now() + probeEvery
            lastLag = progress.lag
            if (progress.writes !== null){
                if (writeMark !== null && progress.writes > writeMark) writeMoved = Date.now()
                if (writeMark === null || progress.writes > writeMark) writeMark = progress.writes
            }
            if (!expired) continue

            const behind  = lastLag !== null && lastLag > this.WAIT_LAG_BLOCKS
            const writing = writeMoved !== null && (Date.now() - writeMoved) <= writeIdleMs
            if (behind || writing){
                extensions++
                deadline = Date.now() + timeMax
                console.log(label + ': '
                    + (behind
                        ? 'indexer is ' + lastLag + ' blocks behind the chain tip'
                        : 'indexer is still writing action rows (index ' + writeMark + ')')
                    + '; extending the wait (' + extensions + '/' + this.WAIT_MAX_EXTENSIONS + ')')
            }
        }
        this._recordPerfPoll(label, startMs, polls, false)
        // : a timed-out wait must say WHY it gave up, because the diagnosis
        // this feeds turns on a distinction the old code could not express.
        //
        // Extensions were logged only when GRANTED, so the "no extension was
        // granted" case emitted nothing at all, and the ledger's own next step
        // ("if this recurs with extensions=0, change the SIGNAL, not the budget")
        // was unfalsifiable: zero lines is what a never-eligible wait, a
        // zero-lag wait and an unreachable probe all look like. Silence read as
        // evidence when it was the absence of evidence.
        //
        // The states are distinguishable by name:
        //   lag N > 0    the indexer had not reached the row's block
        //   lag 0        the indexer kept pace with the chain, so the write signal
        //                below is the one that decided this wait
        //   lag null     the probe could not answer, so the fixed deadline stood
        //   not eligible timeMax below the extension floor
        // and the write signal says whether rows were still landing at give-up time,
        // which separates "the stack is busy and we ran out of budget" from "the
        // stack was idle and the row is genuinely absent".
        console.log(label + ': GAVE UP after ' + (Date.now() - startMs) + 'ms'
            + ' (' + polls + ' polls, ' + extensions + '/' + this.WAIT_MAX_EXTENSIONS + ' extensions, '
            + 'timeMax ' + timeMax + 'ms, '
            + (!eligible
                ? 'not eligible for extension'
                : probes === 0
                    ? 'extension never probed'
                    : 'last indexer lag ' + (lastLag === null ? 'unknown (probe failed)' : lastLag + ' blocks')
                      + ', action writes ' + (writeMark === null
                            ? 'unknown'
                            : writeMoved === null
                                ? 'idle at index ' + writeMark
                                : 'last advanced ' + (Date.now() - writeMoved) + 'ms ago (index ' + writeMark + ')'))
            + ')')
        return null
    }

    // One sample of how far along the pipeline is, for the two signals _waitFor
    // extends on:
    //   lag    blocks the indexer still has to process before it could see our row
    //   writes the highest action_index it has written, whose movement between
    //          samples is what "the indexer is busy but not behind" looks like
    // Either field is null when it is not observable (no node connector wired, RPC
    // down, empty table, probe timed out), and null deliberately disables that
    // signal so the fixed deadline stands: without progress, waiting longer is
    // indistinguishable from hanging.
    async _pipelineProgress(){
        if (!this.pool) return { lag: null, writes: null }
        // The probe is an optimisation, never a reason to block. If it cannot answer
        // promptly the fixed deadline stands, so a probe that hangs costs one timeout
        // rather than stalling the suite. Learned the hard way: the first cut called
        // this.getConnection(), which retries until a connection appears.
        const blind  = { lag: null, writes: null }
        const capped = new Promise(resolve => setTimeout(() => resolve(blind), this.WAIT_LAG_PROBE_MS))
        return Promise.race([this._probePipeline().catch(err => { this._warnProbeFailed(err); return blind }), capped])
    }

    // A probe that can never answer degrades every wait back to a fixed deadline
    // and says nothing about it, which is how this item's mechanism went unproven
    // for a week. Say it once per Database, not once per poll: a wait polls every
    // second and the point is a visible cause, not a flooded log.
    _warnProbeFailed(err){
        if (this._probeWarned) return
        this._probeWarned = true
        console.log('_pipelineProgress: probe unavailable (' + (err && err.message ? err.message : err) + '); '
            + 'waits fall back to the fixed deadline')
    }

    async _probePipeline(){
        let chainTip = null
        if (global.nodeConnector && typeof global.nodeConnector.getBlockCount === 'function'){
            const count = Number(await global.nodeConnector.getBlockCount())
            if (Number.isFinite(count)) chainTip = count
        }
        let conn = await this.pool.getConnection()
        try {
            // Both marks in one round trip: each is an index-only MAX, and a wait
            // that samples twice as often must not cost twice as much.
            let rows = await conn.query('SELECT (SELECT MAX(block_index) FROM blocks) AS tip, '
                + '(SELECT MAX(action_index) FROM actions) AS writes')
            const row    = rows && rows.length ? rows[0] : null
            const tip    = this._finiteOrNull(row ? row.tip : null)
            const writes = this._finiteOrNull(row ? row.writes : null)
            return {
                lag:    (chainTip !== null && tip !== null) ? chainTip - tip : null,
                writes: writes
            }
        } finally {
            await conn.release().catch(() => {})
        }
    }

    _finiteOrNull(value){
        if (value === null || value === undefined) return null
        const n = Number(value)
        return Number.isFinite(n) ? n : null
    }

    // Kept as the named single-signal view: callers and tests that only care how far
    // behind the indexer is should not have to know the probe carries two marks.
    async _indexerLagBlocks(){
        const progress = await this._pipelineProgress()
        return progress ? progress.lag : null
    }

    // ─── ADDRESS ───────────────────────────────────────────────────────
    async waitForAddressOption(obj, timeMax = 60000){ return this._waitFor(this.checkAddressOption, obj, timeMax) }

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
    async waitForDestroy(obj, timeMax = 60000){ return this._waitFor(this.checkDestroy, obj, timeMax) }

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
    async waitForMessage(obj, timeMax = 60000){ return this._waitFor(this.checkMessage, obj, timeMax) }

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

    // ─── PRICE ─────────────────────────────────────────────────────────
    async waitForPrice(obj, timeMax = 60000){ return this._waitFor(this.checkPrice, obj, timeMax) }

    async checkPrice({txHash, source, version, tick, fiat, value, validationStatus, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (version != null){ w.push("p.version = ?"); v.push(version) }
        if (tick != null){ w.push("itick.tick = ?"); v.push(tick) }
        if (fiat != null){ w.push("ifi.code = ?"); v.push(fiat) }
        if (value != null){ w.push("p.value = ?"); v.push(value) }
        if (validationStatus != null){ w.push("p.validation_status = ?"); v.push(validationStatus) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT p.*, itx.hash AS tx_hash, ias.address AS source,
                   icoin.coin AS v1_coin, itick.tick AS v1_tick, ifi.code AS v1_fiat,
                   ist.status AS status
            FROM prices p
            LEFT JOIN actions act ON act.action_index = p.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ias ON ias.id = p.source_id
            LEFT JOIN index_coins icoin ON icoin.id = p.coin_id
            LEFT JOIN index_tickers itick ON itick.id = p.tick_id
            LEFT JOIN index_fiats ifi ON ifi.id = p.fiat_id
            LEFT JOIN index_statuses ist ON ist.id = p.status_id
        `+"WHERE "+w.join(" AND ")+" ORDER BY p.action_index DESC LIMIT 1";
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (price):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── FILE ──────────────────────────────────────────────────────────
    async waitForFile(obj, timeMax = 60000){ return this._waitFor(this.checkFile, obj, timeMax) }

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
    async waitForSleep(obj, timeMax = 60000){ return this._waitFor(this.checkSleep, obj, timeMax) }

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
    async waitForSweep(obj, timeMax = 60000){ return this._waitFor(this.checkSweep, obj, timeMax) }

    async checkSweep({txHash, source, destination, balances, ownerships, orders, swaps, dispensers, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (destination != null){ w.push("iad.address = ?"); v.push(destination) }
        if (balances != null){ w.push("sw.balances = ?"); v.push(balances) }
        if (ownerships != null){ w.push("sw.ownerships = ?"); v.push(ownerships) }
        if (orders != null){ w.push("sw.orders = ?"); v.push(orders) }
        if (swaps != null){ w.push("sw.swaps = ?"); v.push(swaps) }
        if (dispensers != null){ w.push("sw.dispensers = ?"); v.push(dispensers) }
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
    async waitForDividend(obj, timeMax = 60000){ return this._waitFor(this.checkDividend, obj, timeMax) }

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
    async waitForCallback(obj, timeMax = 60000){ return this._waitFor(this.checkCallback, obj, timeMax) }

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
    async waitForOrder(obj, timeMax = 60000){ return this._waitFor(this.checkOrder, obj, timeMax) }

    async checkOrder({txHash, source, giveCoin, giveTick, giveAmount, getCoin, getTick, getAmount, getAddress, expiration, status, orderStatus}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (source != null){ w.push("ias.address = ?"); v.push(source) }
        if (giveCoin != null){ w.push("give_ic.coin = ?"); v.push(giveCoin) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        // orders.give_amount/get_amount are VARCHAR(250), so string-comparing them
        // against the test's raw input ("100.00000000", "0.00000003") misses the
        // DB row, which stores the bignumber-normalized form ("100", "3e-8").
        // Coerce both sides to numeric via +0 so the match is by value, not by
        // string representation.
        if (giveAmount != null){ w.push("o.give_amount+0 = ?+0"); v.push(giveAmount) }
        if (getCoin != null){ w.push("get_ic.coin = ?"); v.push(getCoin) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (getAmount != null){ w.push("o.get_amount+0 = ?+0"); v.push(getAmount) }
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
    async waitForOrderMatch(obj, timeMax = 60000){ return this._waitFor(this.checkOrderMatch, obj, timeMax) }

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
    async waitForSwap(obj, timeMax = 60000){ return this._waitFor(this.checkSwap, obj, timeMax) }

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

    // ─── SWAP MATCH ───────────────────────────────────────────────────
    async waitForSwapMatch(obj, timeMax = 60000){ return this._waitFor(this.checkSwapMatch, obj, timeMax) }

    async checkSwapMatch({giveActionIndex, getActionIndex, giveTick, getTick, giveAmount, getAmount, status}){
        let w = [], v = []
        if (giveActionIndex != null){ w.push("sm.give_action_index = ?"); v.push(giveActionIndex) }
        if (getActionIndex != null){ w.push("sm.get_action_index = ?"); v.push(getActionIndex) }
        if (giveTick != null){ w.push("give_it.tick = ?"); v.push(giveTick) }
        if (getTick != null){ w.push("get_it.tick = ?"); v.push(getTick) }
        if (giveAmount != null){ w.push("sm.give_amount = ?"); v.push(giveAmount) }
        if (getAmount != null){ w.push("sm.get_amount = ?"); v.push(getAmount) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        if (w.length === 0) return null
        const query = `
            SELECT sm.*,
                give_it.tick AS give_tick, get_it.tick AS get_tick,
                ist.status AS status
            FROM swap_matches sm
            LEFT JOIN index_tickers give_it ON give_it.id = sm.give_tick_id
            LEFT JOIN index_tickers get_it ON get_it.id = sm.get_tick_id
            LEFT JOIN index_statuses ist ON ist.id = sm.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (swap_match):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── BATCH ─────────────────────────────────────────────────────────
    async waitForBatch(obj, timeMax = 60000){ return this._waitFor(this.checkBatch, obj, timeMax) }

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
    async waitForLink(obj, timeMax = 60000){ return this._waitFor(this.checkLink, obj, timeMax) }

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

    // ─── ORDER_MATCH ──────────────────────────────────────────────────
    async waitForOrderMatch(obj, timeMax = 60000){ return this._waitFor(this.checkOrderMatch, obj, timeMax) }

    async checkOrderMatch({giveActionIndex, getActionIndex, status}){
        let w = [], v = []
        if (giveActionIndex != null){ w.push("m.give_action_index = ?"); v.push(giveActionIndex) }
        if (getActionIndex != null){ w.push("m.get_action_index = ?"); v.push(getActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT m.*, ist.status AS status
            FROM order_matches m
            LEFT JOIN index_statuses ist ON ist.id = m.status_id
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

    // ─── COINPAY ──────────────────────────────────────────────────────
    async waitForCoinpay(obj, timeMax = 60000){ return this._waitFor(this.checkCoinpay, obj, timeMax) }

    async checkCoinpay({txHash, obligationActionIndex, status}){
        let w = [], v = []
        if (txHash != null){ w.push("itx.hash = ?"); v.push(txHash) }
        if (obligationActionIndex != null){ w.push("m.obligation_action_index = ?"); v.push(obligationActionIndex) }
        if (status != null){ w.push("ist.status = ?"); v.push(status) }
        const query = `
            SELECT m.*, itx.hash AS tx_hash, ist.status AS status
            FROM coinpays m
            LEFT JOIN actions act ON act.action_index = m.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_statuses ist ON ist.id = m.status_id
        `+"WHERE "+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (coinpay):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ─── COINPAY_OBLIGATION ───────────────────────────────────────────
    async waitForCoinpayObligation(obj, timeMax = 60000){ return this._waitFor(this.checkCoinpayObligation, obj, timeMax) }

    async checkCoinpayObligation({actionIndex, coinpayStatus}){
        let w = [], v = []
        if (actionIndex != null){ w.push("co.action_index = ?"); v.push(actionIndex) }
        if (coinpayStatus != null){ w.push("ist.status = ?"); v.push(coinpayStatus) }
        const query = `
            SELECT co.*, ia1.address AS payer_address, ia2.address AS payee_address, c1.coin, ist.status AS coinpay_status
            FROM coinpay_obligations co
            INNER JOIN index_addresses ia1 ON ia1.id = co.payer_address_id
            INNER JOIN index_addresses ia2 ON ia2.id = co.payee_address_id
            INNER JOIN index_coins c1 ON c1.id = co.coin_id
            INNER JOIN coinpay_statuses cs ON cs.coinpay_action_index = co.action_index
            INNER JOIN index_statuses ist ON ist.id = cs.status_id
            WHERE cs.action_index = (SELECT MAX(cs2.action_index) FROM coinpay_statuses cs2 WHERE cs2.coinpay_action_index = co.action_index)
              AND `+w.join(" AND ");
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch (err) {
            console.error('Error with database query (coinpay_obligation):', err);
            return null
        } finally {
            await connection.release()
        }
    }

    // ── VM / Contract Methods ──

    async waitForContract(params, timeMax = 60000){ return this._waitFor(this.checkContract, params, timeMax) }

    async checkContract({source, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT c.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status
            FROM contracts c
            LEFT JOIN actions act ON act.action_index = c.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = c.source_id
            LEFT JOIN index_statuses ist ON ist.id = c.status_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForExecution(params, timeMax = 60000){ return this._waitFor(this.checkExecution, params, timeMax) }

    async checkExecution({contractIndex, caller, methodName, txHash, status}){
        let w = [], v = []
        if(contractIndex){ w.push("e.contract_index = ?"); v.push(contractIndex); }
        if(caller){ w.push("ia.address = ?"); v.push(caller); }
        if(methodName){ w.push("e.method_name = ?"); v.push(methodName); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT e.*, ia.address AS caller, itx.hash AS tx_hash, ist.status AS status
            FROM contract_executions e
            LEFT JOIN actions act ON act.action_index = e.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = e.caller_id
            LEFT JOIN index_statuses ist ON ist.id = e.status_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForDeposit(params, timeMax = 60000){ return this._waitFor(this.checkDeposit, params, timeMax) }

    async checkDeposit({source, contractIndex, tick, amount, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(contractIndex){ w.push("d.contract_index = ?"); v.push(contractIndex); }
        if(tick){ w.push("itick.tick = ?"); v.push(tick); }
        if(amount){ w.push("d.amount = ?"); v.push(amount); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT d.*, ia.address AS source, itick.tick AS tick, itx.hash AS tx_hash, ist.status AS status
            FROM deposits d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = d.source_id
            LEFT JOIN index_tickers itick ON itick.id = d.tick_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForWithdrawal(params, timeMax = 60000){ return this._waitFor(this.checkWithdrawal, params, timeMax) }

    async checkWithdrawal({source, contractIndex, tick, amount, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(contractIndex){ w.push("wd.contract_index = ?"); v.push(contractIndex); }
        if(tick){ w.push("itick.tick = ?"); v.push(tick); }
        if(amount){ w.push("wd.amount = ?"); v.push(amount); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT wd.*, ia.address AS source, itick.tick AS tick, itx.hash AS tx_hash, ist.status AS status
            FROM withdrawals wd
            LEFT JOIN actions act ON act.action_index = wd.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = wd.source_id
            LEFT JOIN index_tickers itick ON itick.id = wd.tick_id
            LEFT JOIN index_statuses ist ON ist.id = wd.status_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    // ── Staking Methods ──

    async waitForStake(params, timeMax = 60000){ return this._waitFor(this.checkStake, params, timeMax) }

    async checkStake({source, signingPubkey, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT s.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM stakes s
            LEFT JOIN actions act ON act.action_index = s.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = s.source_id
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = s.signing_pubkey_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    // Count currently-active, valid stakes (those still in the validator
    // snapshot, not deactivated). Used by the hub-federation tests to assert a
    // clean validator set before staking their own hubs: leftover stakes would
    // skew the deterministic responsible-set selection and make those tests
    // flaky. Zero on a freshly-reset regtest chain.
    async getActiveStakeCount(){
        let query = `SELECT COUNT(*) AS n
            FROM stakes s
            LEFT JOIN index_statuses ist ON ist.id = s.status_id
            WHERE ist.status = 'valid'
              AND (s.deactivation_block IS NULL OR s.deactivation_block = 0)`
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query)
            return rows.length > 0 ? Number(rows[0].n) : 0
        } finally { await connection.release() }
    }

    async waitForUnstake(params, timeMax = 60000){ return this._waitFor(this.checkUnstake, params, timeMax) }

    async checkUnstake({source, signingPubkey, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT u.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM unstakes u
            LEFT JOIN actions act ON act.action_index = u.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = u.source_id
            LEFT JOIN index_statuses ist ON ist.id = u.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = u.signing_pubkey_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    // ── Attestation Methods ──

    async waitForAttestationRequest(params, timeMax = 60000){ return this._waitFor(this.checkAttestationRequest, params, timeMax) }

    async checkAttestationRequest({requestId, txHash, requestStatus}){
        let w = [], v = []
        if(requestId){     w.push("ar.request_id = ?");      v.push(String(requestId).toLowerCase()); }
        if(txHash){        w.push("itx.hash = ?");           v.push(txHash); }
        if(requestStatus){ w.push("ar.request_status = ?");  v.push(requestStatus); }
        if(w.length === 0) return null
        // ATTEST request + response rows now share the consolidated `attests`
        // table, version-discriminated (0 = request, 1 = response).
        let query = `SELECT ar.*, itx.hash AS tx_hash
            FROM attests ar
            LEFT JOIN actions act ON act.action_index = ar.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            WHERE ar.version = 0 AND ` + w.join(" AND ") + `
            LIMIT 1`
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ this._warnOnSchemaError('checkAttestationRequest', err); return null } finally { await connection.release() }
    }

    async waitForAttestationResponse(params, timeMax = 60000){ return this._waitFor(this.checkAttestationResponse, params, timeMax) }

    async checkAttestationResponse({requestId, txHash, responseStatus, status}){
        let w = [], v = []
        if(requestId){       w.push("ar.request_id = ?");       v.push(String(requestId).toLowerCase()); }
        if(txHash){          w.push("itx.hash = ?");            v.push(txHash); }
        if(responseStatus){  w.push("ar.response_status = ?");  v.push(responseStatus); }
        if(status){          w.push("ist.status = ?");          v.push(status); }
        if(w.length === 0) return null
        // Response rows live in the consolidated `attests` table as version = 1.
        let query = `SELECT ar.*, itx.hash AS tx_hash, ist.status AS status
            FROM attests ar
            LEFT JOIN actions act ON act.action_index = ar.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_statuses ist ON ist.id = ar.status_id
            WHERE ar.version = 1 AND ` + w.join(" AND ") + `
            LIMIT 1`
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ this._warnOnSchemaError('checkAttestationResponse', err); return null } finally { await connection.release() }
    }

    async getAttestationValidatorSignatures(responseActionIndex){
        // Verified federation sigs are no longer a separate table; they're
        // inlined as a JSON array (`[{pubkey, sig}, ...]`) on the version = 1
        // response row. Parse + reshape to the prior {validator_pubkey, validator_sig} form.
        let query = `SELECT validator_signatures FROM attests WHERE action_index = ? AND version = 1 LIMIT 1`
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, [responseActionIndex])
            if(rows.length === 0 || !rows[0].validator_signatures) return []
            let parsed
            try { parsed = JSON.parse(rows[0].validator_signatures) } catch(e){ return [] }
            if(!Array.isArray(parsed)) return []
            return parsed.map(s => ({ validator_pubkey: s.pubkey, validator_sig: s.sig }))
        } catch(err){ this._warnOnSchemaError('getAttestationValidatorSignatures', err); return [] } finally { await connection.release() }
    }

    // Distinguish a schema drift (missing table / renamed column) from a normal
    // "no rows yet" poll. The attestation helpers above poll and legitimately
    // return null/[] while waiting, so a swallowed SQL error used to masquerade
    // as a benign timeout (this is exactly how the attestation_requests →
    // attests table consolidation slipped through). Surface those loudly.
    _warnOnSchemaError(where, err){
        if(err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR')){
            console.error('[db] ' + where + ': attestation schema drift: ' + err.message +
                ' (a query references a table/column that no longer exists)')
        }
    }

    async getContractState(contractIndex, stateKey){
        let query = `SELECT * FROM contract_state WHERE contract_index = ? AND state_key = ? ORDER BY block_index DESC, action_index DESC LIMIT 1`
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, [contractIndex, stateKey])
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForDelegation(params, timeMax = 60000){ return this._waitFor(this.checkDelegation, params, timeMax) }

    // `signingPubkey` and `deactivated` exist for the DEL-1 revoke shape :
    // at/after DELEGATE_REVOKE_NO_REINSERT (armed from genesis on regtest) a revoke
    // writes NO row of its own, it only stamps deactivation_block on the PARENT
    // delegation, so the only way to observe one is to look the parent up by
    // (source, pubkey) and read that column. A txHash filter can never see it: the
    // parent row carries the DELEGATE v0 transaction, not the revoke's.
    async checkDelegation({source, signingPubkey, txHash, status, deactivated}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(deactivated === true)  w.push("d.deactivation_block IS NOT NULL")
        if(deactivated === false) w.push("d.deactivation_block IS NULL")
        if(w.length === 0) return null
        let query = `SELECT d.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM delegations d
            LEFT JOIN actions act ON act.action_index = d.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = d.source_id
            LEFT JOIN index_statuses ist ON ist.id = d.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = d.signing_pubkey_id
            WHERE ` + w.join(" AND ") + ` ORDER BY d.action_index DESC`
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    // ── Stake-key revocations (DELEGATE v2 against the ORIGINAL stake key) ──
    // Stake-key-mode revokes write ONLY stake_key_revocations (a delegations
    // row would read as an active delegation and re-add the key to the
    // effective signer set), so they are invisible to checkDelegation.

    async waitForStakeKeyRevocation(params, timeMax = 60000){ return this._waitFor(this.checkStakeKeyRevocation, params, timeMax) }

    async checkStakeKeyRevocation({source, signingPubkey, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT r.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, ip.pubkey AS signing_pubkey
            FROM stake_key_revocations r
            LEFT JOIN actions act ON act.action_index = r.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = r.source_id
            LEFT JOIN index_statuses ist ON ist.id = r.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = r.signing_pubkey_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    // ── Contract-targeted staking (STAKE v3 / UNSTAKE v1 / DELEGATE v1) ──

    async waitForContractStake(params, timeMax = 60000){ return this._waitFor(this.checkContractStake, params, timeMax) }

    async checkContractStake({source, signingPubkey, contractIndex, tick, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source) }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()) }
        if(contractIndex !== undefined && contractIndex !== null){ w.push("cs.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash) }
        if(status){ w.push("ist.status = ?"); v.push(status) }
        if(w.length === 0) return null
        let query = `SELECT cs.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status,
                            ip.pubkey AS signing_pubkey, t.tick AS tick
            FROM contract_stakes cs
            LEFT JOIN actions act ON act.action_index = cs.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = cs.source_id
            LEFT JOIN index_statuses ist ON ist.id = cs.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = cs.signing_pubkey_id
            LEFT JOIN index_tickers t ON t.id = cs.tick_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForContractUnstake(params, timeMax = 60000){ return this._waitFor(this.checkContractUnstake, params, timeMax) }

    async checkContractUnstake({source, signingPubkey, contractIndex, tick, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source) }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()) }
        if(contractIndex !== undefined && contractIndex !== null){ w.push("cu.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash) }
        if(status){ w.push("ist.status = ?"); v.push(status) }
        if(w.length === 0) return null
        let query = `SELECT cu.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status,
                            ip.pubkey AS signing_pubkey, t.tick AS tick
            FROM contract_unstakes cu
            LEFT JOIN actions act ON act.action_index = cu.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = cu.source_id
            LEFT JOIN index_statuses ist ON ist.id = cu.status_id
            LEFT JOIN index_pubkeys ip ON ip.id = cu.signing_pubkey_id
            LEFT JOIN index_tickers t ON t.id = cu.tick_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForContractDelegation(params, timeMax = 60000){ return this._waitFor(this.checkContractDelegation, params, timeMax) }

    async checkContractDelegation({source, contractIndex, tick, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source) }
        if(contractIndex !== undefined && contractIndex !== null){ w.push("cd.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash) }
        if(status){ w.push("ist.status = ?"); v.push(status) }
        if(w.length === 0) return null
        let query = `SELECT cd.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status, t.tick AS tick
            FROM contract_delegations cd
            LEFT JOIN actions act ON act.action_index = cd.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = cd.source_id
            LEFT JOIN index_statuses ist ON ist.id = cd.status_id
            LEFT JOIN index_tickers t ON t.id = cd.tick_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForSlashEvent(params, timeMax = 60000){ return this._waitFor(this.checkSlashEvent, params, timeMax) }

    async checkSlashEvent({contractIndex, signingPubkey, tick, executionIndex}){
        let w = [], v = []
        if(contractIndex !== undefined && contractIndex !== null){ w.push("se.target_contract_index = ?"); v.push(Number(contractIndex)) }
        if(signingPubkey){ w.push("ip.pubkey = ?"); v.push(String(signingPubkey).toLowerCase()) }
        if(tick){ w.push("t.tick = ?"); v.push(tick) }
        if(executionIndex !== undefined && executionIndex !== null){ w.push("se.execution_index = ?"); v.push(Number(executionIndex)) }
        if(w.length === 0) return null
        let query = `SELECT se.*, ip.pubkey AS signing_pubkey, t.tick AS tick, ia.address AS destination_address
            FROM slash_events se
            LEFT JOIN index_pubkeys ip ON ip.id = se.signing_pubkey_id
            LEFT JOIN index_tickers t ON t.id = se.tick_id
            LEFT JOIN index_addresses ia ON ia.id = se.destination_id
            WHERE ` + w.join(" AND ") + ` ORDER BY se.id ASC LIMIT 1`
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }

    async waitForRewardClaim(params, timeMax = 60000){ return this._waitFor(this.checkRewardClaim, params, timeMax) }

    async checkRewardClaim({source, txHash, status}){
        let w = [], v = []
        if(source){ w.push("ia.address = ?"); v.push(source); }
        if(txHash){ w.push("itx.hash = ?"); v.push(txHash); }
        if(status){ w.push("ist.status = ?"); v.push(status); }
        if(w.length === 0) return null
        let query = `SELECT rc.*, ia.address AS source, itx.hash AS tx_hash, ist.status AS status
            FROM reward_claims rc
            LEFT JOIN actions act ON act.action_index = rc.action_index
            LEFT JOIN transactions tr ON act.tx_index = tr.tx_index
            LEFT JOIN index_transactions itx ON itx.id = tr.tx_hash_id
            LEFT JOIN index_addresses ia ON ia.id = rc.source_id
            LEFT JOIN index_statuses ist ON ist.id = rc.status_id
            WHERE ` + w.join(" AND ")
        let connection = await this.getConnection()
        try {
            const rows = await connection.query(query, v)
            return rows.length > 0 ? rows[0] : null
        } catch(err){ return null } finally { await connection.release() }
    }
}

module.exports = Database