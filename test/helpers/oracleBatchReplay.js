'use strict'

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const mariadb = require('mariadb')

const { startDisposableHubDb } = require('./disposableHubDb')
const { waitFor } = require('./consensusWait')
const { loadHubModule } = require('./multiValidatorHubHelper')
const XChainHubConnector = require('../../src/XChainHubConnector.js')
const XChainIndexerConnector = require('../../src/XChainIndexerConnector.js')
const venue = require('./oracleBatchVenue')
const naming = require('./oracle_batch_replay/replay_naming')
const coinConfiguration = require('./oracle_batch_replay/coin_configuration')
const ports = require('./oracle_batch_replay/port_allocation')
const reads = require('./oracle_batch_replay/database_reads')
const comparison = require('./oracle_batch_replay/snapshot_comparison')

const BOOT_WAIT_MS = 180_000
const DEFAULT_BTC_INDEXER_API_PORT = 3024
const REPLAY_WAIT_MS = 30 * 60 * 1000
const LOG_TAIL_LINES = 200
const helperDir = __dirname

const deps = {
    fs, os, path, spawn, mariadb, startDisposableHubDb, waitFor, loadHubModule,
    XChainHubConnector, XChainIndexerConnector, BOOT_WAIT_MS,
    DEFAULT_BTC_INDEXER_API_PORT, REPLAY_WAIT_MS, LOG_TAIL_LINES, helperDir,
    ...venue, ...naming, ...coinConfiguration, ...ports, ...reads, ...comparison
}

const OracleBatchReplayNode = require('./oracle_batch_replay/replay_node')(deps)

module.exports = {
    OracleBatchReplayNode,
    replayDbNames: naming.replayDbNames,
    watermarkGraceEnv: naming.watermarkGraceEnv,
    SNAPSHOT_COMPARE_KEYS: naming.SNAPSHOT_COMPARE_KEYS,
    readPriceSnapshots: reads.readPriceSnapshots,
    readPriceActions: reads.readPriceActions,
    readActionVerdicts: reads.readActionVerdicts,
    readFeeCoordinates: reads.readFeeCoordinates,
    readChainHeight: reads.readChainHeight,
    verdictTables: reads.verdictTables,
    diffSnapshots: comparison.diffSnapshots,
    diffVerdicts: comparison.diffVerdicts,
    connectTo: reads.connectTo,
    pickFreePorts: ports.pickFreePorts,
    processListening: ports.processListening,
    readHubConfigTree: coinConfiguration.readHubConfigTree,
    resolveServiceCredential: coinConfiguration.resolveServiceCredential,
    resolveCoinConfigSidecar: coinConfiguration.resolveCoinConfigSidecar,
    envDescribesCoin: coinConfiguration.envDescribesCoin,
    HUB_CONFIG_REDACTION: coinConfiguration.HUB_CONFIG_REDACTION
}
