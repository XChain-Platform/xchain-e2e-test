/*
 * Phase 1a — Codec carrier round-trip (cross-component property test).
 *
 * Property under test: the on-chain CARRIER is losslessly reversible. Anything
 * the encoder embeds (XChainEncoder.obfuscate + prepareData chunking) must be
 * recovered byte-for-byte by the decoder's read path (removeObfuscation + magic
 * strip + chunk reassembly). This is the foundation the whole ledger rests on:
 * if the carrier ever drops or mutates a byte, every downstream ACTION is
 * silently corrupt.
 *
 * This is the CARRIER layer only — pure, in-process, NO coin node / NO DB.
 * It imports the real XChainEncoder and XChainDecoder and crosses the
 * component boundary (encoder writes, decoder reads), exactly mirroring the
 * encode/decode paths verified in source:
 *   - OP_RETURN : XChainEncoder.createTransaction L332-339  ↔  XChainDecoder L344-389
 *   - MULTISIGN : XChainEncoder.createTransaction L466-468  ↔  XChainDecoder L399-435
 *
 * Remaining Phase 1a work (separate slices, see handover §4-P1a):
 *   - P2SH / P2WSH redeem-script carrier round-trip
 *   - field-format layer: per ACTION×version fields ↔ pipe-delimited string ↔
 *     indexer action parser, with committed golden vectors
 */
'use strict';

const assert = require('assert');
const path = require('path');

// --- Resolve sibling encoder/decoder (monorepo host-run). Skip cleanly if a
//     standalone checkout doesn't have the siblings present. ---
function tryRequire(rel) {
    try { return require(rel); } catch (_) { return null; }
}
const XChainEncoder =
    tryRequire(path.resolve(__dirname, '../../../xchain-encoder/src/XChainEncoder.js'));
const XChainDecoder =
    tryRequire(path.resolve(__dirname, '../../../xchain-decoder/src/XChainDecoder.js'));

const NETWORK = 'bitcoin-regtest';
const MAGIC = Buffer.from('XCHN', 'utf8');
const OP_RETURN_SIZE = 80;          // XChainEncoder OP_RETURN_SIZE
const OP_RETURN_CHUNK = OP_RETURN_SIZE - MAGIC.length;   // 76 data bytes / chunk
const MULTISIGN_CHUNK = 60;         // MULTISIGN_SIZE(69) - magic(4) - 5 script overhead
const MULTISIGN_SLOT = 64;          // two 32-byte pubkey halves

// --- Deterministic PRNG so failures are reproducible (no Math.random). ---
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randBytes(rng, n) {
    const b = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
    return b;
}
function randTxid(rng) {
    // A txid is 64 hex chars; the carrier uses chars [0,16) as AES key, [16,32) as IV.
    let s = '';
    const hex = '0123456789abcdef';
    for (let i = 0; i < 64; i++) s += hex[Math.floor(rng() * 16)];
    return s;
}

// Build encoder/decoder with dummy connection args — the carrier methods
// (obfuscate / removeObfuscation / prepareData / dataToPubkey) never touch the
// node or DB.
function makeCodec() {
    const enc = new XChainEncoder(NETWORK, 'localhost', 0, 'u', 'p', 'localhost', 0);
    const dec = new XChainDecoder(NETWORK, 'localhost', 0, 'db', 'u', 'p', 'localhost', 0, 'u', 'p', false);
    return { enc, dec };
}

// --- Faithful re-implementations of the decoder READ path for each carrier,
//     using the decoder's OWN removeObfuscation (the only crypto involved). ---

// OP_RETURN: each output push = obfuscate(magic+chunk); reader deobfuscates,
// asserts the magic prefix, strips it, and concatenates. (Decoder L344-389.)
async function roundtripOpReturn(enc, dec, payload, txid) {
    const prepared = enc.prepareData(payload, 'OP_RETURN', null);
    const out = [];
    for (const chunkBuf of prepared.dataBufferArray) {
        const onChain = await enc.obfuscate(chunkBuf, txid);     // encode
        const recovered = await dec.removeObfuscation(onChain, txid); // decode
        assert.ok(recovered, 'removeObfuscation returned null');
        assert.ok(recovered.subarray(0, MAGIC.length).equals(MAGIC), 'magic word missing');
        out.push(recovered.subarray(MAGIC.length));
    }
    return Buffer.concat(out);
}

// MULTISIGN: obfuscate(64-byte slot), split into two 32-byte pubkey halves via
// dataToPubkey (0x02 + 32). Reader drops the 0x02, concatenates the halves,
// deobfuscates, strips magic. The final chunk is zero-padded, so the recovered
// stream matches the payload as a PREFIX. (Encoder L466-468 ↔ Decoder L399-435.)
async function roundtripMultisign(enc, dec, payload, txid) {
    const prepared = enc.prepareData(payload, 'MULTISIGN', null);
    const out = [];
    for (const slotBuf of prepared.dataBufferArray) {
        assert.strictEqual(slotBuf.length, MULTISIGN_SLOT, 'slot not zero-padded to 64');
        const obf = await enc.obfuscate(slotBuf, txid);
        const pub1 = await enc.dataToPubkey(obf.slice(0, 32));
        const pub2 = await enc.dataToPubkey(obf.slice(32, obf.length));
        // decoder: strip the leading 0x02 marker from each pubkey half
        const reassembled = Buffer.concat([pub1.subarray(1), pub2.subarray(1)]);
        const recovered = await dec.removeObfuscation(reassembled, txid);
        assert.ok(recovered, 'removeObfuscation returned null');
        assert.ok(recovered.subarray(0, MAGIC.length).equals(MAGIC), 'magic word missing');
        out.push(recovered.subarray(MAGIC.length));
    }
    return Buffer.concat(out);
}

(XChainEncoder && XChainDecoder ? describe : describe.skip)
('Phase 1a — codec carrier round-trip', function () {
    this.timeout(0);

    let enc, dec;
    before(function () {
        if (!XChainEncoder || !XChainDecoder) this.skip();
        ({ enc, dec } = makeCodec());
    });

    describe('obfuscation layer (AES-128-CTR, symmetric)', function () {
        it('removeObfuscation(obfuscate(d, txid), txid) === d for fuzzed sizes', async function () {
            const rng = mulberry32(0xC0DEC);
            for (let i = 0; i < 400; i++) {
                const n = Math.floor(rng() * 4097);        // 0 .. 4096 bytes
                const d = randBytes(rng, n);
                const txid = randTxid(rng);
                const back = await dec.removeObfuscation(await enc.obfuscate(d, txid), txid);
                assert.ok(back.equals(d), `size ${n} txid ${txid.slice(0, 8)} mismatch`);
            }
        });

        it('a different txid does NOT recover the payload (key actually matters)', async function () {
            const rng = mulberry32(7);
            const d = randBytes(rng, 256);
            const obf = await enc.obfuscate(d, randTxid(rng));
            const back = await dec.removeObfuscation(obf, randTxid(rng)); // wrong key/iv
            assert.strictEqual(back.length, d.length);
            assert.ok(!back.equals(d), 'wrong txid still recovered payload — cipher not keyed');
        });
    });

    describe('OP_RETURN carrier (chunk + magic + obfuscate, multi-output)', function () {
        it('round-trips exactly across single- and multi-chunk payloads', async function () {
            const rng = mulberry32(42);
            const sizes = [1, 16, 75, 76, 77, 152, 200, 500, 1024,
                           OP_RETURN_CHUNK * 3, OP_RETURN_CHUNK * 3 + 1];
            for (const n of sizes) {
                const payload = randBytes(rng, n);
                const back = await roundtripOpReturn(enc, dec, payload, randTxid(rng));
                assert.ok(back.equals(payload), `OP_RETURN round-trip failed at ${n} bytes`);
            }
        });

        it('round-trips realistic pipe-delimited ACTION strings', async function () {
            const rng = mulberry32(99);
            const actions = [
                'SEND|1|XCP|1.00000000|bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxx',
                'ISSUE|2|MYTOKEN|1000000.00000000|1|0|A divisible token',
                'ORDER|1|XCP|10.00000000|BTC|0.00010000|100',
                'DISPENSER|1|XCP|1.00000000|0.00010000|100.00000000|0',
            ];
            for (const a of actions) {
                const payload = Buffer.from(a, 'utf8');
                const back = await roundtripOpReturn(enc, dec, payload, randTxid(rng));
                assert.ok(back.equals(payload), `ACTION round-trip failed: ${a.slice(0, 24)}`);
            }
        });
    });

    describe('MULTISIGN carrier (pubkey-packed, zero-padded slots)', function () {
        it('recovers the payload as a prefix (trailing pad is keystream, discarded downstream)', async function () {
            const rng = mulberry32(2024);
            const sizes = [1, 16, 59, 60, 61, 120, 121, 240, MULTISIGN_CHUNK * 4 + 3];
            for (const n of sizes) {
                const payload = randBytes(rng, n);
                const back = await roundtripMultisign(enc, dec, payload, randTxid(rng));
                assert.ok(back.length >= payload.length, `recovered shorter than payload at ${n}`);
                assert.ok(back.subarray(0, payload.length).equals(payload),
                    `MULTISIGN prefix mismatch at ${n} bytes`);
                // tail past the payload is zero-pad (the only loss is known padding)
                assert.ok(back.subarray(payload.length).every((b) => b === 0),
                    `MULTISIGN tail not zero-pad at ${n} bytes`);
            }
        });
    });

    describe('golden wire-format vector (pins cipher + key derivation)', function () {
        // Independently captured: payload "XCHNhello-xchain-roundtrip" under txid
        // 00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff.
        // If this changes, the on-chain obfuscation format changed — a breaking
        // wire-format change that must be intentional.
        const TXID = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
        const PAYLOAD = Buffer.from('XCHNhello-xchain-roundtrip', 'utf8');
        const GOLDEN = '0491b6f4c0ba8ff44866cf0f75a82d6cda098a3ee877aa420344';

        it('obfuscate produces the pinned ciphertext', async function () {
            const obf = await enc.obfuscate(PAYLOAD, TXID);
            assert.strictEqual(obf.toString('hex'), GOLDEN);
        });
        it('decoder recovers the pinned ciphertext', async function () {
            const back = await dec.removeObfuscation(Buffer.from(GOLDEN, 'hex'), TXID);
            assert.ok(back.equals(PAYLOAD));
        });
    });
});
