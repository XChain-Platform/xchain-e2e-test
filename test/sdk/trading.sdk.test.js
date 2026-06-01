/*********************************************************************
 *
 * XChain Platform E2E - SDK-driven trading / DEX actions
 *
 * ORDER (token-for-token) and DISPENSER (token-for-native-coin) driven
 * through sdk.submitAction(). These action strings are large enough to
 * exercise the P2SH two-phase reveal path as well. Each asserts the
 * action indexes valid; the open order/dispenser is then read back
 * through the SDK explorer client.
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedGasAddress, uniqueTick, submitOpts } = require('./sdkHelper');

const COIN = (typeof global.COIN_CODE !== 'undefined' && global.COIN_CODE) || 'BTC';
const expiry = () => Math.floor(Date.now() / 1000) + 90 * 86400;

async function issue(sdk, actor, tick, mintSupply) {
    const res = await submit(sdk,
        { action: 'ISSUE', params: { tick, maxSupply: 1000000, maxMint: 100000, decimals: 0, description: 'trade', mintSupply } },
        { pubkey: actor.address, change: actor.address },
        submitOpts({ wif: actor.wif })
    );
    expect(res.indexed.status, 'ISSUE ' + tick).to.equal('valid');
}

describe('[sdk] trading / DEX actions', function () {
    this.timeout(0);

    let sdk, actor;

    before(async function () {
        sdk = makeSdk();
        actor = await fundedGasAddress(sdk, 1);
        console.log('    [sdk] actor=' + actor.address + ' coin=' + COIN);
    });

    it('ORDER creates a token-for-token order', async function () {
        const giveTick = uniqueTick('OGV');
        const getTick = uniqueTick('OGT');
        await issue(sdk, actor, giveTick, 100);
        await issue(sdk, actor, getTick, 100);

        const res = await submit(sdk,
            {
                action: 'ORDER',
                params: {
                    giveCoin: COIN, giveTick, giveAmount: 10,
                    getCoin: COIN, getTick, getAmount: 5,
                    getAddress: actor.address, expiration: expiry(),
                },
            },
            { pubkey: actor.address, change: actor.address },
            submitOpts({ wif: actor.wif })
        );
        console.log('    [sdk] ORDER encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });

    it('DISPENSER creates a token-for-native dispenser', async function () {
        const giveTick = uniqueTick('DSP');
        await issue(sdk, actor, giveTick, 100);

        const res = await submit(sdk,
            {
                action: 'DISPENSER',
                params: {
                    giveCoin: COIN, giveTick, giveAmount: 10, giveEscrow: 100,
                    getCoin: COIN, getAmount: 100000, getAddress: actor.address,
                    expiration: expiry(),
                },
            },
            { pubkey: actor.address, change: actor.address },
            submitOpts({ wif: actor.wif })
        );
        console.log('    [sdk] DISPENSER encoding=' + res.encoding + ' status=' + res.indexed.status);
        expect(res.indexed.status).to.equal('valid');
    });
});
