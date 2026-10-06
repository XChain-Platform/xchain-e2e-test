'use strict';

const { expect } = require('chai');
const { readTestnetTreasury, buildTestnetSdk } = require('../../drills/lib/testnetDrillEnv');

describe('testnetDrillEnv.readTestnetTreasury', () => {
    it('returns the wif and address when both keys are present', () => {
        const env = { TESTNET_TREASURY_WIF: 'wif-1', TESTNET_TREASURY_ADDRESS: 'addr-1' };
        expect(readTestnetTreasury(env)).to.deep.equal({ wif: 'wif-1', address: 'addr-1' });
    });

    it('throws naming TESTNET_TREASURY_WIF when the wif is missing', () => {
        const env = { TESTNET_TREASURY_ADDRESS: 'addr-1' };
        expect(() => readTestnetTreasury(env)).to.throw(Error, /TESTNET_TREASURY_WIF/);
    });

    it('throws naming TESTNET_TREASURY_ADDRESS when the address is blank', () => {
        const env = { TESTNET_TREASURY_WIF: 'wif-1', TESTNET_TREASURY_ADDRESS: '   ' };
        expect(() => readTestnetTreasury(env)).to.throw(Error, /TESTNET_TREASURY_ADDRESS/);
    });

    it('names both keys when both are missing', () => {
        expect(() => readTestnetTreasury({})).to.throw(Error, /TESTNET_TREASURY_WIF/);
        expect(() => readTestnetTreasury({})).to.throw(Error, /TESTNET_TREASURY_ADDRESS/);
    });

    it('never puts an env value in the error message', () => {
        const env = { TESTNET_TREASURY_WIF: 'cStubWifDoNotPrint' };
        try {
            readTestnetTreasury(env);
            throw new Error('expected readTestnetTreasury to throw');
        } catch (err) {
            expect(err.message).to.include('TESTNET_TREASURY_ADDRESS');
            expect(err.message).to.not.include('cStubWifDoNotPrint');
        }
    });
});

describe('testnetDrillEnv.buildTestnetSdk', () => {
    function StubSdk(opts) {
        this.opts = opts;
    }

    it('maps BTC to bitcoin-testnet', () => {
        const sdk = buildTestnetSdk(StubSdk, 'BTC', 'https://x.test');
        expect(sdk.opts.network).to.equal('bitcoin-testnet');
    });

    it('maps DOGE to dogecoin-testnet', () => {
        const sdk = buildTestnetSdk(StubSdk, 'DOGE', 'https://x.test');
        expect(sdk.opts.network).to.equal('dogecoin-testnet');
    });

    it('trims trailing slashes from the explorer url', () => {
        const sdk = buildTestnetSdk(StubSdk, 'BTC', 'https://x.test//');
        expect(sdk.opts.explorerUrl).to.equal('https://x.test');
    });

    it('throws naming the coin for an unknown ticker', () => {
        expect(() => buildTestnetSdk(StubSdk, 'LTCX', 'https://x.test')).to.throw(Error, /LTCX/);
    });

    it('throws for an empty explorer url', () => {
        expect(() => buildTestnetSdk(StubSdk, 'BTC', '')).to.throw(Error, /explorerUrl/);
    });
});
