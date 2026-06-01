/*********************************************************************
 *
 * XChain Platform E2E - SDK-driven token lifecycle
 *
 * Proves the core developer/wallet path end-to-end through the SDK:
 *   ISSUE (mint supply to issuer) -> SEND (transfer to a recipient)
 * Every step goes through sdk.submitAction(): action-string build,
 * format selection, encoder call, PSBT sign, broadcast, and indexer
 * confirmation. Reads are then verified back through the SDK explorer
 * client (the same client the wallet uses).
 *
 ********************************************************************/

const { expect } = require('chai');
const { makeSdk, submit, fundedSdkAddress, fundedGasAddress, mine, uniqueTick, submitOpts } = require('./sdkHelper');

// Pull an amount for a tick out of whatever shape getBalances returns.
// Logged shapes the first time so we can tighten assertions later.
function balanceFor(balances, tick) {
    if (!balances) return null;
    let list = Array.isArray(balances) ? balances
        : Array.isArray(balances.data) ? balances.data
        : Array.isArray(balances.balances) ? balances.balances
        : null;
    if (!list) return null;
    const row = list.find(b => (b.tick || b.TICK || b.ticker) === tick);
    if (!row) return null;
    return Number(row.quantity ?? row.amount ?? row.balance ?? row.value);
}

describe('[sdk] token lifecycle: ISSUE -> SEND', function () {
    this.timeout(0);

    let sdk, issuer, recipient, tick;

    before(async function () {
        sdk = makeSdk();
        // Issuer needs native coin (tx fees) AND XCHAIN gas (protocol ISSUE fee).
        issuer = await fundedGasAddress(sdk, 1);
        tick = uniqueTick();
        console.log('    [sdk] issuer=' + issuer.address + ' tick=' + tick);
    });

    it('ISSUE creates the token and mints supply to the issuer', async function () {
        const res = await submit(sdk,
            {
                action: 'ISSUE',
                params: {
                    tick,
                    maxSupply:   1000000000,
                    maxMint:     1000000,
                    decimals:    0,
                    description: 'SDK harness token',
                    mintSupply:  1000000,
                },
            },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );

        console.log('    [sdk] ISSUE encoding=' + res.encoding + ' txid=' + res.txid);
        expect(res.txid, 'txid').to.be.a('string');
        expect(res.action).to.equal('ISSUE');
        expect(res.indexed, 'indexed action').to.be.an('object');
        expect(res.indexed.status).to.equal('valid');
    });

    it('issuer balance reflects the minted supply (SDK explorer read)', async function () {
        await mine(1);
        const balances = await sdk.getBalances(issuer.address);
        console.log('    [sdk] issuer balances: ' + JSON.stringify(balances));
        const amt = balanceFor(balances, tick);
        expect(amt, 'minted balance for ' + tick).to.equal(1000000);
    });

    it('SEND transfers tokens to a recipient', async function () {
        recipient = await fundedSdkAddress(sdk, 1);
        const res = await submit(sdk,
            {
                action: 'SEND',
                params: { tick, amount: 1000, destination: recipient.address },
            },
            { pubkey: issuer.address, change: issuer.address },
            submitOpts({ wif: issuer.wif })
        );

        console.log('    [sdk] SEND encoding=' + res.encoding + ' txid=' + res.txid);
        expect(res.txid, 'txid').to.be.a('string');
        expect(res.indexed, 'indexed action').to.be.an('object');
        expect(res.indexed.status).to.equal('valid');
    });

    it('recipient balance reflects the transfer (SDK explorer read)', async function () {
        await mine(1);
        const balances = await sdk.getBalances(recipient.address);
        console.log('    [sdk] recipient balances: ' + JSON.stringify(balances));
        const amt = balanceFor(balances, tick);
        expect(amt, 'received balance for ' + tick).to.equal(1000);
    });
});
