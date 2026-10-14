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
 * Database core: constructor, connection handling and ping
 *
 ********************************************************************/

const { config, logger } = require('./shared')
const { mariadbDriver } = require('./driver')

const PERF_COLLECTOR_MODULE = '../../test/perf/perfCollector';

// Adaptive-wait tunables (see _waitFor). Extensions are bounded so a wedged
// stack still fails. The lag threshold is ZERO: these waits ask "has MY row
// been indexed", and any block the indexer has not reached may be the
// one holding it. A threshold of 2 made the wait give up precisely when
// it was nearly done (measured 2026-09-05: `GAVE UP ... last indexer lag
// 2 blocks` with two extensions unused, the row landing seconds later;
// the v0.15.0 rehearsal's bitcoin leg died the same way in before()).
// Parsed so an explicit 0 is honoured: `parseInt('0') || 2` is 2.
//
// The second progress signal: how often a long wait samples pipeline
// progress, and how recently action rows must have landed for the indexer to
// count as "still writing". The sample interval is floored so a wait cannot
// spend its budget probing, and the idle window is at least two intervals so
// two samples taken moments apart cannot read as a stall.
const WAIT_TUNABLES = [
    'WAIT_MAX_EXTENSIONS', 'WAIT_LAG_BLOCKS', 'WAIT_LAG_PROBE_MS', 'WAIT_MIN_FOR_EXTENSION',
    'WAIT_PROBE_INTERVAL_MS', 'WAIT_PROBE_MIN_MS', 'WAIT_WRITE_IDLE_MS'
]

// Connect-retry budget (see getConnection). Bounded by BOTH an attempt count
// and a wall-clock deadline, because the two failure shapes have wildly
// different per-attempt costs: a pool that rejects instantly burns attempts
// and no time, while an unreachable host burns the driver's acquire timeout
// (~10s) per attempt and no attempts worth counting. Either bound alone lets
// one shape run long. The budget is set so a dead venue gives up in roughly
// half a minute, well inside the one-minute ceiling a drill is judged by.
const CONNECT_TUNABLES = ['CONNECT_MAX_ATTEMPTS', 'CONNECT_BUDGET_MS', 'CONNECT_RETRY_MS']

function copyTunables(target, names){
    for (const name of names) target[name] = config[name]
}

function poolParams(connection){
    return {
        ...connection,
        connectionLimit:  10,
        //connectTimeout: 0,
        insertIdAsNumber: true,
        // BIGINT columns (action_index, tx_index, …) must deserialize as Number, not
        // BigInt: the consensus hash serializes a BigInt as a quoted string, so a pool
        // without this diverges from the indexer/sync prod pools (both set bigIntAsNumber);
        // it made consensusHashConformance falsely RED on every block with such columns.
        bigIntAsNumber:   true
    }
}

class DatabaseCore {
    constructor(host, port, dbName, user, pass){
        copyTunables(this, WAIT_TUNABLES)
        copyTunables(this, CONNECT_TUNABLES)
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;
        const connection = { host: host, user: user, password: pass, database: dbName, port: port }
        this.connectionParams = { ...connection };
        this.connectionPoolParams = poolParams(connection);
        this.pool = mariadbDriver().createPool(this.connectionPoolParams);
        this.transactionConnection = null;
    }

    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    isNullOrNullString(value){
        return value == null || value === "" || value === 0 || value === false
    }

    ['_recordPerfPoll'](method, startMs, polls, resolved) {
        try {
            const collector = require(PERF_COLLECTOR_MODULE)
            collector.recordPoll({ method, startMs, endMs: Date.now(), polls, resolved })
        } catch (e) {
            // perfCollector not loaded (unit tests, etc.); silently skip
        }
    }

    // A credential the venue no longer accepts is indistinguishable, from inside a
    // retry loop, from a database that is merely slow to come up. The old loop
    // retried forever and logged one anonymous line per attempt, so a stale indexer
    // DB password turned every drill into a run that never ended and never said
    // which database it could not reach: the operator saw a hung suite, not a
    // configuration fault, and had to go looking for the cause by hand.
    //
    // Two changes make the failure legible:
    //
    //   1. The retry budget is bounded (attempts AND wall clock), so an unreachable
    //      pool ends the run non-zero instead of hanging it. The thrown error names
    //      host, port, database and user, which is the whole diagnosis: a drill's
    //      last line now says exactly which venue credential to fix.
    //   2. An authentication or missing-database rejection is FATAL on the first
    //      attempt. Retrying cannot turn a wrong password into a right one, and the
    //      wait only delays the message that already contains the answer.
    //
    // Transient failures still retry, because a stack coming up behind the suite is
    // the ordinary case and was the reason this loop existed at all. The password is
    // never part of the message; it is the one field a stale-credential report does
    // not need and must not carry.
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        const startMs  = Date.now();
        const deadline = startMs + this.CONNECT_BUDGET_MS;
        let attempts   = 0;
        let lastError  = null;
        while(true){
            attempts++;
            try {
                return await this.pool.getConnection();
            } catch (e){
                lastError = e;
                const fatal   = this['_isFatalConnectError'](e);
                const spent   = attempts >= this.CONNECT_MAX_ATTEMPTS || Date.now() >= deadline;
                if (fatal || spent) break;
                logger.info("Can't connect to mariadb at " + this['_target']()
                    + " (attempt " + attempts + "/" + this.CONNECT_MAX_ATTEMPTS + "): "
                    + this['_errText'](lastError) + ". Trying again...");
                await this.sleep(this.CONNECT_RETRY_MS);
            }
        }
        const err = new Error("Can't connect to the indexer database at " + this['_target']()
            + " after " + attempts + " attempt" + (attempts === 1 ? "" : "s")
            + " (" + (Date.now() - startMs) + "ms): " + this['_errText'](lastError)
            + (this['_isFatalConnectError'](lastError)
                ? ". The venue rejected these credentials, so retrying cannot help."
                  + " A second-chain rail resolves this credential from <CODE>_INDEXER_DB_PASS"
                  + " in the environment, then INDEXER_DB_PASS in .env.<code>, then the hub's"
                  + " stored copy - so any ONE of those three being current is enough, and the"
                  + " hub's is the one that goes stale (it is written at install time, and a"
                  + " consensus-enabled hub cannot accept a corrected push without quorum)."
                : ". Check that the venue is up and that its indexer DB credentials are current"
                  + " in at least one of: <CODE>_INDEXER_DB_PASS in the environment,"
                  + " INDEXER_DB_PASS in .env.<code>, or the hub's stored copy."));
        err.code  = 'E2E_DB_UNREACHABLE';
        err.cause = lastError;
        throw err;
    }

    // host:port/database as user, for every message about reaching this pool.
    ['_target'](){
        return this.host + ":" + this.port + "/" + this.dbName + " as user '" + this.user + "'";
    }

    ['_errText'](err){
        if (!err) return 'unknown error';
        return err.message || String(err);
    }

    // Rejections no amount of waiting can fix: wrong user, wrong password, wrong or
    // absent database. Matched on the driver's own code/errno rather than message
    // text, which is localized and version-dependent.
    //
    // The chain is walked because the pool does not always hand the rejection up
    // unwrapped: a credential the server refuses can surface as the pool's own
    // ER_GET_CONNECTION_TIMEOUT with the real refusal hanging off `cause`, and
    // reading only the outer error would retry a password that will never work.
    ['_isFatalConnectError'](err){
        const FATAL_CODES  = ['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'];
        const FATAL_ERRNOS = [1044, 1045, 1049];
        let node = err;
        for (let depth = 0; node && depth < 5; depth++){
            if (node.code && FATAL_CODES.includes(node.code)) return true;
            if (node.errno !== undefined && FATAL_ERRNOS.includes(Number(node.errno))) return true;
            node = node.cause;
        }
        return false;
    }

    async ping(){
        const query = `
            SELECT 1 + 1;
        `

        const connection = await this.getConnection()

        try {
            const rows = await connection.query(query)
            if (rows.length > 0){
                return true
            } else {
                return false  
            }
        } catch (err) {
            logger.error('Error with database ping:', err);
            return false
        } finally {
            await connection.release()
        }
    }
}

module.exports = DatabaseCore
