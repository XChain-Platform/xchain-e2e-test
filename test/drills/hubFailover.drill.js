'use strict'

const path = require('path')
const { HubFailoverProcessDriver, parseArgs } = require('./lib/hubFailoverProcessDriver')
const { optionsFromEnv, runHubFailoverDrill } = require('./lib/hubFailoverDrill')

describe('two-hub indexer failover drill', function () {
    this.timeout(0)

    it('moves all indexers, observes caught_up recovery, fans out the report, and preserves BTC parity', async function () {
        const command = process.env.XCHAIN_HUB_FAILOVER_DRIVER
        if (!command) {
            console.log('Skipping hub failover drill: set XCHAIN_HUB_FAILOVER_DRIVER (see test/drills/README.md)')
            this.skip()
        }
        const driver = new HubFailoverProcessDriver(command,
            parseArgs(process.env.XCHAIN_HUB_FAILOVER_DRIVER_ARGS), {
                cwd: path.resolve(__dirname, '../..'),
                env: process.env,
                timeoutMs: Number(process.env.XCHAIN_HUB_FAILOVER_DRIVER_TIMEOUT_MS) || 180000,
            })
        const evidence = await runHubFailoverDrill(driver, optionsFromEnv(process.env))
        console.log('HUB_FAILOVER_EVIDENCE ' + JSON.stringify(evidence))
    })
})
