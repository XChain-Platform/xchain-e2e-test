/*********************************************************************
 *
 * XChain Platform E2E - SDK-driven token-ownership trading
 *
 * Recent feature: ORDER/SWAP/DISPENSER can trade a token's *ownership*
 * (issuer rights) via GIVE_OWNERSHIP / GET_OWNERSHIP. Here the issuer
 * lists its token's ownership for native coin through sdk.submitAction.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';
const expiry = () => Math.floor(Date.now() / 1000) + 90 * 86400;

describe('[sdk] token-ownership trading (ORDER GIVE_OWNERSHIP)', function () {
    this.timeout(0);

    let sdk, owner, tick;

    before(async function () {
        sdk = makeSdk();
        owner = await fundedGasAddress(sdk, 1);
        tick = uniqueTick('OWN');
        const res = await submit(sdk,
            { action: 'ISSUE', params: { tick, maxSupply: 1000, maxMint: 1000, decimals: 0, description: 'ownership', mintSupply: 10 } },
            { pubkey: owner.address, change: owner.address },
            submitOpts({ wif: owner.wif })
        );
        expect(res.indexed.status, 'ISSUE').to.equal('valid');
        console.log('    [sdk] owner=' + owner.address + ' tick=' + tick);
    });

    it('ORDER lists the token ownership for native coin', async function () {
        const res = await submit(sdk,
            {
                action: 'ORDER',
                params: {
                    giveCoin: COIN, giveTick: tick, giveOwnership: 1,
                    getCoin: COIN, getAmount: 100000,
                    getAddress: owner.address, expiration: expiry(),
                },
            },
            { pubkey: owner.address, change: owner.address },
            submitOpts({ wif: owner.wif })
        );
        console.log('    [sdk] OWNERSHIP ORDER encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });
});
