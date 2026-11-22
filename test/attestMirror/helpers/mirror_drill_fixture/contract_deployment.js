'use strict'

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 **********************************************************************/

const assert = require('assert')

const cryptoHelper = require('../../../helpers/core/cryptoHelper')
const gasHelper = require('../../../helpers/gasHelper')
const vmHelper = require('../../../helpers/vmHelper')
const { mineWhile, settleStack } = require('./stack_settlement')
const { withWedgeClear } = require('./wedge_clearing')

async function deployRequestContract (o, label, beforeDeploy) {
    assert.ok(o.code, 'mirrorDrillFixture: deployRequestContract needs contract source')

    const owner = await withWedgeClear('funding and gas seed for ' + label + '-owner',
        () => mineWhile(() => cryptoHelper.getNewFundedAddress(
            label + '-owner', COIN, NETWORK, null, 'legacy', 0, 0.02)))
    await regtestMinerConnector.generateBlocks(2)
    await settleStack()
    await withWedgeClear('gas mint for ' + label + '-owner',
        () => mineWhile(() => gasHelper.ensureGasBalance(owner, '5000')))

    await beforeDeploy()
    const deploy = await mineWhile(() => vmHelper.sendDeployV0(owner, o.code, Number(o.gas || 500000)))
    assert.strictEqual(deploy.contract.status, 'valid',
        'mirrorDrillFixture: deploy for ' + label + ' came back ' + deploy.contract.status)

    return { owner, contractIndex: deploy.contract.action_index }
}

module.exports = { deployRequestContract }
