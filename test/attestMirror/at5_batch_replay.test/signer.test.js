'use strict'

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
 **********************************************************************/

// The DOGE publisher's wallet and reference signer, staged by the drill itself.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { encode: wifEncode } = require('wif')

const chainRail = require('../../helpers/chainRail')
const cryptoHelper = require('../../helpers/core/cryptoHelper')
const { loadHubModule } = require('../../helpers/multiValidatorHubHelper')
const { withWedgeClear } = require('../helpers/mirrorDrillFixture')
const CryptoNetworks = require('../../../src/crypto_networks.js')
const { PUBLISHER_FUND_DOGE, PUBLISHER_FUND_OUTPUTS, DOGE_ENCODER_PORT } = require('./config.test.js')


/**
 * Fund a DOGE publisher wallet, stage the shipped signer module against it, and
 * return the hub environment that turns the batch publisher on.
 *
 * THIS WAS ONCE WRITTEN AS AN OPERATOR PRECONDITION AND THAT WAS WRONG. The
 * earlier version of this drill skipped unless four variables were already in the
 * environment, on the reasoning that a funded wallet on another chain is not a
 * test's to invent. Every part of that fell to measurement:
 *
 *   - FUNDING ON REGTEST IS A BLOCK, NOT MONEY: the publisher pays native fees
 *     only, so no bridged gas is seeded.
 *   - `HUB_SIGNER_MODULE` IS A PATH, and this venue spawns hubs as processes with
 *     an environment this file constructs, not as containers with a mounted
 *     operator directory. The module it points at is the one the hub repo SHIPS as
 *     its reference signer, copied into a temp directory with the two packages it
 *     requires symlinked in. `test/federation/anchorAcceptance.test.js` has staged
 *     it exactly this way for the ANCHOR rail all along.
 *   - `DOGE_ENCODER_URL` IS A VENUE COORDINATE, pinned at 3123 in `chainRail`.
 *
 * So the whole thing is arranged here, and the drill skips only if the DOGE rail
 * itself cannot be reached, which is a venue fault with a named cause rather than
 * a category of work belonging to someone else.
 *
 * THE KEY NEVER TOUCHES DISK. The staged signer reads its `.env` through dotenv,
 * which does not override variables already present, so the WIF is handed to the
 * hub child through its environment and no file is written with a key in it.
 */
async function stageDogeSigner (label, rail) {
    const funded = await fundPublisher(label, rail)
    const signerDir = stageSignerDir()
    const env = signerEnv(funded, signerDir)
    probeSignerLoad(env)
    console.log('AT5: staged the reference DOGE signer at ' + signerDir + ' for a funded publisher address')
    return { env: env, signerDir: signerDir, address: funded.address }
}

async function fundPublisher (label, rail) {
    // Funded ON the DOGE rail, which is the whole point: the publisher pays a real
    // fee on that chain for every window it broadcasts.
    const funded = await chainRail.withRail(rail, async () => {
        // WRAPPED for the same reason as the relayer in AT6: the funding call mints
        // gas internally, so it starves under the wedge, and it is keyed by label so
        // a retry re-funds one publisher rather than minting a second wallet.
        const addr = await withWedgeClear('funding the batch publisher on the other rail',
            () => cryptoHelper.getNewFundedAddress(
                label + '-batch-publisher', COIN, NETWORK, null, 'legacy', 0,
                PUBLISHER_FUND_DOGE, false))
        // The remaining outputs, each its own transaction from the miner's wallet
        // (see PUBLISHER_FUND_OUTPUTS). Idempotency is not needed here: a retry
        // that re-funds simply leaves the publisher richer.
        for (let i = 1; i < PUBLISHER_FUND_OUTPUTS; i++) {
            await regtestMinerConnector.sendFunds(addr.address, PUBLISHER_FUND_DOGE)
        }
        console.log('AT5: publisher ' + addr.address + ' funded with ' + PUBLISHER_FUND_OUTPUTS +
            ' outputs of ' + PUBLISHER_FUND_DOGE + ' DOGE')
        await regtestMinerConnector.generateBlocks(2)
        await utxoTrackerConnector.quiesce({
            timeoutMs: 60_000, pollMs: 250, regtestMiner: regtestMinerConnector,
        })
        return { address: addr.address, privateKey: addr.privateKey, publicKey: addr.publicKey,
                 coin: COIN, network: NETWORK }
    })
    assert.ok(funded && funded.address,
        'could not fund a DOGE publisher address, so the batch publisher would have nothing to pay with')
    return funded
}

function stageSignerDir () {
    // The reference signer, staged the way an operator installs it. os.tmpdir()
    // rather than the checkout, because the e2e tree can live on a share where
    // symlink creation is unreliable.
    const hubRoot = path.resolve(__dirname, '../../../../xchain-hub')
    const examplePath = path.join(hubRoot, 'examples', 'doge-signer.example.js')
    assert.ok(fs.existsSync(examplePath),
        'the hub ships no examples/doge-signer.example.js at ' + examplePath +
        ', so there is no reference signer to stage')
    const signerDir = path.join(os.tmpdir(),
        'xchain-attest-batch-signer-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'))
    fs.rmSync(signerDir, { recursive: true, force: true })
    fs.mkdirSync(path.join(signerDir, 'node_modules'), { recursive: true })
    fs.copyFileSync(examplePath, path.join(signerDir, 'signer.js'))
    for (const dep of ['xchain-sdk', 'dotenv']) {
        let target
        try { target = path.dirname(require.resolve(dep + '/package.json')) }
        catch (e) {
            target = path.resolve(__dirname, '../../../../', dep)
            assert.ok(fs.existsSync(target), 'cannot resolve ' + dep + ' for the staged signer')
        }
        fs.symlinkSync(target, path.join(signerDir, 'node_modules', dep), 'dir')
    }
    return signerDir
}

function signerEnv (funded, signerDir) {
    const netObj = CryptoNetworks.getBitcoinJsNetwork(funded.coin + '-' + funded.network)
    const host = process.env.DOGE_SERVICE_HOST || 'localhost'
    const port = process.env.DOGE_ENCODER_API_PORT || String(DOGE_ENCODER_PORT)
    const env = {
        HUB_SIGNER_MODULE: path.join(signerDir, 'signer.js'),
        DOGE_NETWORK:      funded.coin + '-' + funded.network,
        DOGE_ADDRESS:      funded.address,
        DOGE_WIF:          wifEncode(netObj.wif, Buffer.from(funded.privateKey), true),
        // Read by the publisher for election and low-balance warnings, separately
        // from the signer's own key material.
        DOGE_PUBKEY_HEX:   Buffer.from(funded.publicKey).toString('hex'),
        DOGE_ENCODER_URL:  'http://' + host + ':' + port,
        // Explicit, so this never depends on the default staying true.
        ATTEST_BATCH_PUBLISH_ENABLED: 'true',
    }
    if (process.env.DOGE_ENCODER_API_KEY) env.DOGE_ENCODER_API_KEY = String(process.env.DOGE_ENCODER_API_KEY)
    return env
}

function probeSignerLoad (env) {
    // PROVED IN-PROCESS BEFORE FIVE HUBS ARE SPAWNED, through the hub's own loader
    // rather than by inspection: a signer that cannot fulfil its contract throws at
    // load, and discovering that from five dead children four minutes later costs
    // the whole prologue.
    const { loadSignerHooks } = loadHubModule('src/lib/signer_loader.js')
    // THE SIGNER READS process.env, NOT THE OBJECT THE LOADER IS HANDED: the
    // loader uses its env argument only to find HUB_SIGNER_MODULE, then
    // `require`s it, and the module reads DOGE_WIF and friends off process.env
    // after a dotenv load of its own (empty) directory. Handed only the object,
    // the probe failed with `DOGE_WIF is not set in <dir>/.env` on 2026-09-05
    // while the hub children, which receive the same variables in THEIR
    // environment, would have loaded it fine. So the variables are placed in
    // this process's environment for the load and taken out again. Still
    // never on disk.
    const previous = {}
    for (const k of Object.keys(env)) { previous[k] = process.env[k]; process.env[k] = env[k] }
    let hooks
    try {
        hooks = loadSignerHooks(Object.assign({}, process.env, env))
    } finally {
        for (const k of Object.keys(env)) {
            if (previous[k] === undefined) delete process.env[k]
            else process.env[k] = previous[k]
        }
    }
    assert.ok(hooks && hooks.broadcastFn,
        'the hub signer loader did not wire a broadcast hook from the staged signer, so every window ' +
        'would defer with "no broadcast pipeline configured"')
}

module.exports = { stageDogeSigner }
