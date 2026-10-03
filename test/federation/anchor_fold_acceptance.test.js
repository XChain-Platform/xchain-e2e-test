'use strict'

// Copyright (c) 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const FOLD_ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION'
const priorFoldEnv = process.env[FOLD_ENV]

function restoreFoldEnv(){
    if(priorFoldEnv === undefined) delete process.env[FOLD_ENV]
    else process.env[FOLD_ENV] = priorFoldEnv
}

function armFold(){
    process.env[FOLD_ENV] = '0'
}

function unarmFold(){
    delete process.env[FOLD_ENV]
}

// A rehearsal arms the fold on the standing DOGE indexer at a mid-chain height (the drive
// passes it in this variable), while the in-process hubs below fold from genesis. Their v3
// anchors only read as folds on the standing indexer at or past that height, so the run
// mines DOGE up to it first. Without a height, or outside a venue run, this does nothing.
const foldArmHeight = /^\d+$/.test(String(priorFoldEnv || '').trim()) ? Number(priorFoldEnv) : 0

async function mineDogeToFoldArm(){
    if(!(foldArmHeight > 0)) return
    if(typeof indexerConnector === 'undefined'){
        // A seeded federation run must cross the arm here; skipping it silently would
        // repeat R-3 attempt 4, where the fold anchors mined below the arm.
        if(process.env.E2E_REQUIRE_FEDERATION === '1')
            throw new Error('no venue indexer connector to mine DOGE to the fold arm height ' + foldArmHeight)
        return
    }
    const latest = await indexerConnector.call('getlatestblock', {})
    const tip = Number(latest && latest.block_index)
    if(!Number.isSafeInteger(tip)) throw new Error('the DOGE indexer reported no tip before the fold suites')
    if(tip < foldArmHeight){
        await regtestMinerConnector.generateBlocks(foldArmHeight - tip)
        await utxoTrackerConnector.quiesce({ timeoutMs: 60000, pollMs: 250, regtestMiner: regtestMinerConnector })
    }
    if(!(await indexerConnector.waitForIndexedBlock(foldArmHeight, 120000)))
        throw new Error('the DOGE indexer did not reach the fold arm height ' + foldArmHeight)
}

armFold()
describe('fold activation: AF1', function(){
    before(armFold)
    before(mineDogeToFoldArm)
    require('./anchor_fold/af1_one_transaction.test.js')
    after(restoreFoldEnv)
})
restoreFoldEnv()
armFold()
describe('fold activation: AF2', function(){
    before(armFold)
    require('./anchor_fold/af2_archive_silenced.test.js')
    after(restoreFoldEnv)
})
restoreFoldEnv()
armFold()
describe('fold activation: AF3', function(){
    before(armFold)
    require('./anchor_fold/af3_late_crc_scope.test.js')
    after(restoreFoldEnv)
})
restoreFoldEnv()
unarmFold()
describe('fold activation: AF4', function(){
    before(unarmFold)
    require('./anchor_fold/af4_unarmed_replay.test.js')
    after(restoreFoldEnv)
})
restoreFoldEnv()
armFold()
describe('fold activation: AF5', function(){
    before(armFold)
    require('./anchor_fold/af5_follower_recompute.test.js')
    after(restoreFoldEnv)
})
restoreFoldEnv()
