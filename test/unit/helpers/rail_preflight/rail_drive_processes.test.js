'use strict'

const assert = require('assert')

const {
    RAIL_DRIVE_ARGS,
    ancestorPids,
    launchParentIsAttached,
    otherRailDrives,
} = require('../../../helpers/rail_preflight/rail_drive_processes')
const {
    planBootstrapFunding,
    recordedSignerSeeds,
} = require('../../../integration/bridge_rail_token.test/support/quorum_funding')

const {
    miningNodeTipReaders,
    readTipAdvance,
    minerStallReason,
} = require('../../../integration/bridge_rail_token.test/support/miner_liveness')

const {
    DOGE_INDEXER_CANDIDATE_PORTS,
    resolveIndexerPort,
} = require('../../../integration/bridge_rail_token.test/support/rail_ports')

describe('bridge rail drive process detection', function () {
    const psText = [
        '       1       0 /sbin/init',
        '     100       1 sshd: rail@notty',
        '     110     100 bash -c env NODE_PATH=/srv/platform ./node_modules/.bin/mocha --no-config test/integration/bridge_rail_token.test.js',
        '     120     110 npm exec mocha -- --no-config test/integration/bridge_rail_token.test.js',
        '     130     120 sh -c mocha --no-config test/integration/bridge_rail_token.test.js',
        '     140     130 node ./node_modules/.bin/mocha --no-config test/integration/bridge_rail_token.test.js',
        '     200     100 bash -c for w in $(seq 1 120); do pgrep -c -f "^node .*mocha.*bridge_rail_"; sleep 60; done',
        '     210     200 pgrep -c -f ^node .*mocha.*bridge_rail_',
        '     300     100 node ./node_modules/.bin/mocha --no-config test/integration/bridge_rail_policy.test.js',
        '     310     100 node ./node_modules/.bin/mocha --no-config test/federation/anchor_fold_acceptance.test.js',
        '     400     100 bash -c for w in $(seq 1 120); do pgrep -c -f "^node .*mocha.*anchor_fold"; sleep 60; done',
        '     410     400 pgrep -c -f ^node .*mocha.*anchor_fold',
    ].join('\n')

    it('matches only node processes whose executable is mocha and whose arguments name a rail drive', function () {
        assert.strictEqual(RAIL_DRIVE_ARGS.test(
            '/opt/node/bin/node ./node_modules/.bin/mocha ' +
            'test/integration/bridge_rail_token.test.js'), true)
        assert.strictEqual(RAIL_DRIVE_ARGS.test(
            'node ./node_modules/.bin/mocha test/federation/anchor_fold_acceptance.test.js'), true)
        assert.strictEqual(RAIL_DRIVE_ARGS.test(
            'bash -c node ./node_modules/.bin/mocha test/integration/bridge_rail_token.test.js'), false)
        assert.strictEqual(RAIL_DRIVE_ARGS.test(
            'bash -c node ./node_modules/.bin/mocha test/federation/anchor_fold_acceptance.test.js'), false)
    })

    it('returns the complete process ancestry of the running drive', function () {
        assert.deepStrictEqual(ancestorPids(psText, 140), [140, 130, 120, 110, 100, 1])
    })

    it('ignores the own tree and queued wrappers but finds genuine foreign shared-rail drives', function () {
        assert.deepStrictEqual(otherRailDrives(psText, ancestorPids(psText, 140)), [
            {
                pid: 300,
                args: 'node ./node_modules/.bin/mocha --no-config ' +
                    'test/integration/bridge_rail_policy.test.js',
            },
            {
                pid: 310,
                args: 'node ./node_modules/.bin/mocha --no-config ' +
                    'test/federation/anchor_fold_acceptance.test.js',
            },
        ])
    })

    it('keeps a drive attached only while its original launch parent remains its parent', function () {
        assert.strictEqual(launchParentIsAttached(psText, 140, 130), true)
        assert.strictEqual(launchParentIsAttached(psText.replace(
            '     140     130 node',
            '     140       1 node'
        ), 140, 130), false)
        assert.strictEqual(launchParentIsAttached(psText.replace(
            '     130     120 sh -c mocha --no-config test/integration/bridge_rail_token.test.js\n',
            ''
        ), 140, 130), false)
    })
})

describe('bridge rail quorum donor planning', function () {
    const requests = [
        { address: 'new-a', amount: '6000' },
        { address: 'new-b', amount: '4000' },
    ]
    const donors = [
        { address: 'old-a', balance: '5010' },
        { address: 'old-b', balance: '3010' },
        { address: 'empty', balance: '5' },
    ]

    it('leaves ten XCHAIN on donors and mints only the remaining shortfall', function () {
        assert.deepStrictEqual(planBootstrapFunding(requests, donors, {
            supply: '96000', maxSupply: '100000',
        }), {
            transfers: [
                { donorAddress: 'old-a', destination: 'new-a', amount: '5000' },
                { donorAddress: 'old-b', destination: 'new-a', amount: '1000' },
                { donorAddress: 'old-b', destination: 'new-b', amount: '2000' },
            ],
            mints: [{ address: 'new-b', amount: '2000' }],
            mintTotal: '2000',
            headroom: '4000',
        })
    })

    it('refuses a mint shortfall larger than the remaining supply headroom', function () {
        assert.throws(() => planBootstrapFunding(requests, donors, {
            supply: '99000', maxSupply: '100000',
        }), /supply headroom is 1000 but bootstrap funding still needs 2000/)
    })

    it('moves donor surplus to a new signer instead of leaving more than the reserve', function () {
        const plan = planBootstrapFunding([{ address: 'new-a', amount: '1000' }], [
            { address: 'old-a', balance: '1510' },
        ], { supply: '100000', maxSupply: '100000' })
        assert.deepStrictEqual(plan.transfers, [
            { donorAddress: 'old-a', destination: 'new-a', amount: '1500' },
        ])
        assert.deepStrictEqual(plan.mints, [])
    })

    it('floors fractional donor balances to whole XCHAIN and reads fractional supply', function () {
        const plan = planBootstrapFunding([{ address: 'new-a', amount: '100' }], [
            { address: 'old-a', balance: '60.99999999' },
            { address: 'old-b', balance: '70.5' },
        ], { supply: '999.5', maxSupply: '1000.00000000' })
        assert.deepStrictEqual(plan.transfers, [
            { donorAddress: 'old-b', destination: 'new-a', amount: '60' },
            { donorAddress: 'old-a', destination: 'new-a', amount: '50' },
        ])
        assert.deepStrictEqual(plan.mints, [])
    })

    it('drains the richest donors first and leaves later donors untouched once the request is met', function () {
        const plan = planBootstrapFunding([{ address: 'new-a', amount: '1000' }], [
            { address: 'small', balance: '210' },
            { address: 'large', balance: '5010' },
            { address: 'medium', balance: '900' },
        ], { supply: '100000', maxSupply: '100000' })
        assert.deepStrictEqual(plan.transfers, [
            { donorAddress: 'large', destination: 'new-a', amount: '5000' },
        ])
        assert.deepStrictEqual(plan.mints, [])
    })

    it('rejects a donor balance that is not an amount', function () {
        assert.throws(() => planBootstrapFunding([{ address: 'new-a', amount: '10' }], [
            { address: 'old-a', balance: 'n/a' },
        ], { supply: '0', maxSupply: '100' }), /donor balance is not an XCHAIN amount/)
    })
})

describe('bridge rail quorum recorded signer seeds', function () {
    const seedA = 'a'.repeat(64)
    const seedB = 'B'.repeat(64)
    const derive = (seed) => 'pub-' + seed.slice(0, 4)

    it('recognises a recorded signer by the pubkey its seed derives to', function () {
        const seeds = recordedSignerSeeds([
            { signingSeed: seedA, signingPubkey: 'pub-aaaa' },
            { signingSeed: seedB },
        ], derive)
        assert.deepStrictEqual([...seeds.keys()], ['pub-aaaa', 'pub-bbbb'])
        assert.strictEqual(seeds.get('pub-bbbb').seedHex, 'b'.repeat(64))
    })

    it('drops a record whose seed is malformed, whose pubkey disagrees, or whose derivation throws', function () {
        const seeds = recordedSignerSeeds([
            { signingSeed: 'short' },
            { signingSeed: seedA, signingPubkey: 'pub-other' },
            { address: 'no-seed' },
            null,
        ], derive)
        assert.strictEqual(seeds.size, 0)
        assert.strictEqual(recordedSignerSeeds([{ signingSeed: seedA }], () => { throw new Error('bad') }).size, 0)
        assert.strictEqual(recordedSignerSeeds(undefined, derive).size, 0)
    })
})

describe('bridge rail mining loop liveness', function () {
    function clock() {
        let t = 0
        return { now: () => t, sleep: async (ms) => { t += ms } }
    }

    it('reports every chain alive once each tip has risen, without waiting out the budget', async function () {
        const c = clock()
        const heights = { BTC: 100, DOGE: 200 }
        const reads = { BTC: 0, DOGE: 0 }
        const readers = ['BTC', 'DOGE'].reduce((all, chain) => Object.assign(all, {
            [chain]: async () => { reads[chain] += 1; return heights[chain] + (reads[chain] > 2 ? 1 : 0) },
        }), {})
        const out = await readTipAdvance({ readers, sleep: c.sleep, now: c.now, budgetMs: 90000, pollMs: 5000 })
        assert.deepStrictEqual(out, { alive: true, stalled: [] })
        assert.strictEqual(c.now(), 10000)
    })

    it('names only the chain whose tip stayed frozen for the whole budget', async function () {
        const c = clock()
        const readers = { BTC: async () => 41161, DOGE: async () => 23748 + c.now() / 5000 }
        const out = await readTipAdvance({ readers, sleep: c.sleep, now: c.now, budgetMs: 30000, pollMs: 5000 })
        assert.deepStrictEqual(out, { alive: false, stalled: [{ chain: 'BTC', height: 41161 }] })
        assert.strictEqual(c.now(), 30000)
    })

    it('waits for a chain whose indexer has no tip row yet instead of reading it as height zero', async function () {
        const c = clock()
        let doge = 0
        const readers = {
            BTC: async () => 100 + c.now() / 5000,
            DOGE: async () => { doge += 1; return doge < 3 ? null : 500 + c.now() / 5000 },
        }
        const out = await readTipAdvance({ readers, sleep: c.sleep, now: c.now, budgetMs: 90000, pollMs: 5000 })
        assert.deepStrictEqual(out, { alive: true, stalled: [] })
    })

    it('names a chain that never gets a tip row, with a null height and its own failure text', async function () {
        const c = clock()
        const readers = { BTC: async () => 100 + Math.floor(c.now() / 40000), DOGE: async () => null }
        const out = await readTipAdvance({ readers, sleep: c.sleep, now: c.now, budgetMs: 30000, pollMs: 5000 })
        assert.deepStrictEqual(out, { alive: false, stalled: [{ chain: 'DOGE', height: null }] })
        assert.match(minerStallReason(out.stalled, 30000, []), /DOGE has no tip row did not rise in 30s\./)
    })

    it('reads the readers in turn so the DOGE swap of globals never overlaps the BTC read', async function () {
        const c = clock()
        const order = []
        const readers = {
            BTC: async () => { order.push('BTC+'); await c.sleep(1); order.push('BTC-'); return 1 + c.now() },
            DOGE: async () => { order.push('DOGE+'); await c.sleep(1); order.push('DOGE-'); return 1 + c.now() },
        }
        await readTipAdvance({ readers, sleep: c.sleep, now: c.now, budgetMs: 10, pollMs: 1 })
        for (let i = 0; i < order.length; i += 2) assert.strictEqual(order[i].slice(0, -1), order[i + 1].slice(0, -1))
    })

    it('reads node heights without consulting a standing indexer that cannot settle bridges', async function () {
        const entered = []
        const dogeRail = {
            globals: {
                nodeConnector: { getBlockCount: async () => 202 },
                indexerConnector: { call: async () => { throw new Error('standing indexer is stalled') } },
            },
        }
        const readers = miningNodeTipReaders({
            btcNode: { getBlockCount: async () => 101 },
            dogeRail,
            withRail: async (rail, fn) => { entered.push(rail); return fn() },
        })
        assert.strictEqual(await readers.BTC(), 101)
        assert.strictEqual(await readers.DOGE(), 202)
        assert.deepStrictEqual(entered, [dogeRail])
    })

    it('tells a left-behind pause flag from a missing loop in the failure text', function () {
        const stalled = [{ chain: 'BTC', height: 41161 }]
        assert.match(minerStallReason(stalled, 90000, ['/run/rail/btc-loop.pause']),
            /BTC tip 41161 did not rise in 90s\. A mining pause flag exists: \/run\/rail\/btc-loop\.pause\./)
        assert.match(minerStallReason(stalled, 90000, []), /No pause flag exists, so the standing mining loop/)
    })
})

describe('bridge rail DOGE indexer port resolution', function () {
    const accepting = (open) => async (port) => open.includes(port)

    it('keeps an explicit port without probing', async function () {
        const probed = []
        const out = await resolveIndexerPort({
            configured: '3999',
            candidates: DOGE_INDEXER_CANDIDATE_PORTS,
            accepts: async (port) => { probed.push(port); return true },
        })
        assert.deepStrictEqual(out, { port: 3999, source: 'env' })
        assert.deepStrictEqual(probed, [])
    })

    it('picks the first candidate that accepts, so a rebuilt stack on 3124 is found', async function () {
        const out = await resolveIndexerPort({
            configured: undefined,
            candidates: DOGE_INDEXER_CANDIDATE_PORTS,
            accepts: accepting([3124]),
        })
        assert.deepStrictEqual(out, { port: 3124, source: 'probe' })
    })

    it('prefers the earlier candidate when both accept', async function () {
        const out = await resolveIndexerPort({
            configured: '',
            candidates: DOGE_INDEXER_CANDIDATE_PORTS,
            accepts: accepting([3004, 3124]),
        })
        assert.deepStrictEqual(out, { port: 3004, source: 'probe' })
    })

    it('reports no port when nothing accepts, leaving the chainRail default in force', async function () {
        const out = await resolveIndexerPort({
            configured: undefined,
            candidates: DOGE_INDEXER_CANDIDATE_PORTS,
            accepts: accepting([]),
        })
        assert.deepStrictEqual(out, { port: null, source: 'none' })
    })
})
