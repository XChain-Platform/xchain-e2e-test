'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { fundedGasAddress, GAS_TICK } = require('../../drills/lib/testnetGasFunding');

const SRC = path.join(__dirname, '../../drills/lib/testnetGasFunding.js');

function makeSdk() {
    return {
        generateKeyPair: () => ({ publicKey: 'pub-fresh', wif: 'wif-fresh' }),
        deriveAddress: (pk) => 'addr-of-' + pk,
    };
}

describe('testnetGasFunding.fundedGasAddress', () => {
    const treasury = { address: 'addr-treasury', wif: 'wif-treasury' };
    let calls;
    const submitFn = async (...args) => { calls.push(args); return { txid: 'tx-stub' }; };

    beforeEach(() => { calls = []; });

    it('composes a SEND of the GAS ticker, never a MINT', async () => {
        await fundedGasAddress({ sdk: makeSdk(), treasury, amount: 5, submitFn });
        expect(calls).to.have.length(1);
        const action = calls[0][1];
        expect(action.action).to.equal('SEND');
        expect(action.params.tick).to.equal(GAS_TICK);
        expect(action.params.amount).to.equal(5);
        expect(action.params.destination).to.equal('addr-of-pub-fresh');
        expect(JSON.stringify(calls)).to.not.include('MINT');
    });

    it('signs with the treasury keys, not the fresh address', async () => {
        await fundedGasAddress({ sdk: makeSdk(), treasury, amount: 5, submitFn });
        const [, , encoderOpts, opts] = calls[0];
        expect(opts.wif).to.equal('wif-treasury');
        expect(encoderOpts.pubkey).to.equal('addr-treasury');
        expect(encoderOpts.change).to.equal('addr-treasury');
        expect(JSON.stringify([encoderOpts, opts])).to.not.include('wif-fresh');
    });

    it('returns the fresh address, its wif and the submit txid', async () => {
        const out = await fundedGasAddress({ sdk: makeSdk(), treasury, amount: 5, submitFn });
        expect(out).to.deep.equal({ address: 'addr-of-pub-fresh', wif: 'wif-fresh', txid: 'tx-stub' });
    });

    it('makes no network call and reads no env var itself', () => {
        const src = fs.readFileSync(SRC, 'utf8');
        expect(src).to.not.match(/process\.env/);
        expect(src).to.not.match(/require\(['"](fs|http|https|net|child_process)['"]\)/);
        expect(src).to.not.match(/\bfetch\(|readFileSync|stdin/);
    });

    it('does not log the treasury wif', async () => {
        const lines = [];
        await fundedGasAddress({ sdk: makeSdk(), treasury, amount: 5, submitFn, log: (l) => lines.push(l) });
        expect(lines.join('\n')).to.not.include('wif-');
    });
});
