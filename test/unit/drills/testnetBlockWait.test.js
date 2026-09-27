'use strict';

const { expect } = require('chai');
const { waitForBlocks, DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS } = require('../../drills/lib/testnetBlockWait');

function harness(heights) {
    let clock = 0;
    const urls = [];
    let i = 0;
    return {
        urls,
        sleeps: [],
        now: () => clock,
        sleep(ms) { this.sleeps.push(ms); clock += ms; return Promise.resolve(); },
        fetchImpl: async (url) => {
            urls.push(url);
            const h = heights[Math.min(i++, heights.length - 1)];
            return { ok: true, status: 200, json: async () => ({ last_block: { TBTC: h, TLTC: 1 } }) };
        }
    };
}

function run(h, extra) {
    return waitForBlocks(Object.assign({
        explorerUrl: 'http://explorer.test', coin: 'TBTC', sinceHeight: 100, blocks: 2,
        timeoutMs: 1000, pollIntervalMs: 100,
        now: h.now, sleep: h.sleep.bind(h), fetchImpl: h.fetchImpl
    }, extra));
}

describe('waitForBlocks', () => {
    it('resolves once the tip reaches sinceHeight + blocks', async () => {
        const h = harness([100, 101, 102, 150]);
        const tip = await run(h);
        expect(tip).to.equal(102);
        expect(h.urls).to.have.length(3);
        expect(h.sleeps).to.deep.equal([100, 100]);
    });

    it('rejects naming the last observed height when the tip stalls', async () => {
        const h = harness([101]);
        let err;
        try { await run(h); } catch (e) { err = e; }
        expect(err, 'rejection').to.be.instanceOf(Error);
        expect(err.message).to.match(/last observed height 101/);
        expect(h.urls.length).to.be.greaterThan(1);
    });

    it('never calls mine, generateBlocks, or a miner RPC', async () => {
        const h = harness([100, 102]);
        const forbiddenCalls = [];
        await run(h, {
            mine() { forbiddenCalls.push('mine'); },
            generateBlocks() { forbiddenCalls.push('generateBlocks'); },
            minerRpc() { forbiddenCalls.push('minerRpc'); }
        });
        expect(forbiddenCalls).to.deep.equal([]);
        expect(h.urls.length).to.be.greaterThan(0);
        h.urls.forEach((u) => {
            expect(u).to.equal('http://explorer.test/TBTC/api/status');
        });
    });

    it('survives a failed poll and reports the poll error on timeout', async () => {
        const h = harness([100]);
        h.fetchImpl = async () => { throw new Error('socket hang up'); };
        let err;
        try { await run(h); } catch (e) { err = e; }
        expect(err.message).to.match(/last observed height null/);
        expect(err.message).to.match(/socket hang up/);
    });

    it('sizes its defaults for testnet inclusion latency', () => {
        expect(DEFAULT_TIMEOUT_MS).to.be.at.least(60 * 60 * 1000);
        expect(DEFAULT_POLL_INTERVAL_MS).to.be.at.least(10 * 1000);
    });
});
