'use strict'

const assert = require('assert')

const {
    composeHubsReading,
    readHubsReading,
} = require('../../attestMirror/helpers/hubsReading')

describe('hubs reading', function () {
    const hubs = [
        { index: 2, apiUrl: 'http://hub-2.test' },
        { index: 7, apiUrl: 'http://hub-7.test' },
    ]

    it('composes venue-ordered hubs with split markers and both health shapes', function () {
        const firstStats = { chainReconcileLandedWindows: 3, windowsPublished: 1 }
        const secondStats = { chainReconcileLandedWindows: 0 }
        const result = composeHubsReading(hubs, [
            { hub: '7', window_start: '200', status: 'landed', ignored: true },
            { hub: '2', window_start: '100', status: 'sent' },
            { hub: '7', window_start: 300, status: 4 },
        ], {
            2: { result: { attest_batch: firstStats } },
            7: { attest_batch: secondStats },
        })

        assert.deepStrictEqual(result, [
            {
                hub: 'hub-2',
                stats: firstStats,
                markers: [{ window_start: 100, status: 'sent' }],
            },
            {
                hub: 'hub-7',
                stats: secondStats,
                markers: [
                    { window_start: 200, status: 'landed' },
                    { window_start: 300, status: '4' },
                ],
            },
        ])
        assert.strictEqual(result[0].stats.chainReconcileLandedWindows, 3)
    })

    it('uses empty stats when attest_batch is absent', function () {
        const result = composeHubsReading(hubs, [], new Map([
            [2, { result: { healthy: true } }],
            [7, null],
        ]))

        assert.deepStrictEqual(result.map((entry) => entry.stats), [{}, {}])
    })

    it('posts health exactly once per hub and contains a thrown call', async function () {
        const calls = []
        const result = await readHubsReading(hubs, [
            { hub: 2, window_start: '100', status: 'landed' },
        ], {
            post: async (url, body) => {
                calls.push({ url, body })
                if (url === hubs[1].apiUrl) throw new Error('offline')
                return { data: { result: { attest_batch: { chainReconcileLandedWindows: 2 } } } }
            },
        })

        assert.deepStrictEqual(calls, [
            {
                url: hubs[0].apiUrl,
                body: { jsonrpc: '2.0', id: 1, method: 'health', params: {} },
            },
            {
                url: hubs[1].apiUrl,
                body: { jsonrpc: '2.0', id: 1, method: 'health', params: {} },
            },
        ])
        assert.deepStrictEqual(result, [
            {
                hub: 'hub-2',
                stats: { chainReconcileLandedWindows: 2 },
                markers: [{ window_start: 100, status: 'landed' }],
            },
            { hub: 'hub-7', stats: {}, markers: [] },
        ])
    })
})
