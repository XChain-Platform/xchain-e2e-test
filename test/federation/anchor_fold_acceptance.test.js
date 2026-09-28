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

armFold()
describe('fold activation: AF1', function(){
    before(armFold)
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
describe.skip('fold activation: AF3', function(){
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
