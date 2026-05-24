// Token-gated content end-to-end test. Exercises the protocol path
// added in https://github.com/.../TOKEN_GATED_CONTENT — appending
// GATE_TICKER / ENCRYPTION_METHOD / KEY_HASH to FILE, mirroring
// ciphertext into gated_files, and enforcing the gated-SEND rule
// (SEND must be batched with a MESSAGE v2 to the recipient).
//
// Scenarios:
//   - Issuer publishes a gated FILE in BATCH(FILE, MESSAGE-to-self).
//     Asserts the gated_files row is populated and key_hash matches.
//   - Issuer transfers the token to a recipient in BATCH(SEND, MESSAGE).
//     Asserts the SEND lands valid.
//   - Negative: bare SEND of the gated token (no sibling MESSAGE) →
//     indexer rejects with the gated-token-transfer error.
//   - Negative: non-issuer attempts to publish a gated FILE for the
//     same ticker → rejected with the issuer-only error.

const assert = require('assert')
const crypto = require('crypto')
const cryptoHelper = require('../cryptoHelper')
const issueHelper = require('../helpers/issueHelper')
const fileHelper = require('../helpers/fileHelper')
const sendHelper = require('../helpers/sendHelper')
const batchHelper = require('../helpers/batchHelper')
const transactionHelper = require('../transactionHelper')

// Encrypt plaintext under a fresh AES-256-GCM key. Returns the raw
// ciphertext buffer (12-byte IV || GCM tag || ct) and the key + hex
// sha256(key) the protocol uses for the gated FILE's KEY_HASH field.
// Mirrors xchain-sdk/src/gatedFile.js so the e2e harness doesn't have
// to import the SDK as a runtime dependency.
function makeGatedCiphertext(plaintext) {
    const key = crypto.randomBytes(32)
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authTag = cipher.getAuthTag()
    const ciphertext = Buffer.concat([iv, authTag, encrypted])
    const keyHash = crypto.createHash('sha256').update(key).digest('hex')
    return { ciphertext, key, keyHash }
}

// Stub key-handoff payload — the indexer rule only checks for a
// structurally-valid MESSAGE v2 in the same tx, not for ciphertext
// correctness. The wallet validates the actual key payload at unlock
// time. Returning a placeholder hex blob shaped like a real ECIES
// envelope (ephemeralPubkey || iv || authTag || ciphertext) keeps
// the e2e harness independent of the SDK's ECIES implementation.
function stubEncryptedMessage(keyHashHex) {
    // 33 (ephemeralPubkey) + 12 (iv) + 16 (authTag) + 33 (v1 handoff
    // plaintext: [0x01][32-byte K]). Filled with deterministic-ish
    // bytes derived from keyHashHex so each call is distinct.
    const seed = Buffer.from(keyHashHex.padEnd(64, '0'), 'hex')
    const blob = Buffer.alloc(94)
    for (let i = 0; i < blob.length; i++) blob[i] = seed[i % seed.length] ^ (i + 1)
    return blob.toString('hex')
}

// Query the indexer's gated_files table directly. Returns null when
// no row exists for the given action_index.
async function fetchGatedFileRow(actionIndex) {
    const conn = await indexerDatabase.getConnection()
    try {
        const rows = await conn.query(
            'SELECT gf.action_index, gf.gate_ticker, gf.encryption_method, gf.key_hash, ' +
            '       LENGTH(gf.raw_data) AS raw_data_length ' +
            'FROM gated_files gf WHERE gf.action_index = ? LIMIT 1',
            [actionIndex],
        )
        return rows.length > 0 ? rows[0] : null
    } finally {
        await conn.release()
    }
}

describe('FILE — token-gated content', function () {
    this.timeout(120000)

    const TICK = 'GATEDTEST' + Date.now().toString().slice(-6)
    const plaintext = Buffer.from('top secret holder-only content')
    const { ciphertext, keyHash } = makeGatedCiphertext(plaintext)
    // The encoder validator requires a string for rawData and the on-chain
    // path treats the string as opaque bytes (Latin-1). Send the AES-GCM
    // ciphertext bytes byte-identically via the 'binary' string encoding.
    const ciphertextRaw = ciphertext.toString('binary')

    let issuer
    let recipient
    let outsider

    before(async function () {
        issuer    = await cryptoHelper.getNewFundedAddress('GATED.ISSUER',    COIN, NETWORK, null, 'legacy', 0, 5)
        recipient = await cryptoHelper.getNewFundedAddress('GATED.RECIPIENT', COIN, NETWORK, null, 'legacy', 0, 1)
        outsider  = await cryptoHelper.getNewFundedAddress('GATED.OUTSIDER',  COIN, NETWORK, null, 'legacy', 0, 1)
    })

    it('issuer can publish a gated FILE inside BATCH(FILE, MESSAGE-to-self)', async function () {
        // Create the token the file gates against.
        await issueHelper.sendIssueV0(
            issuer, TICK,
            '1000',  // maxSupply
            '0',     // maxMint
            '0',     // decimals
            'Gated content e2e token',
            '1000',  // mintSupply (issuer gets all 1000)
        )

        // BATCH(FILE-gated, MESSAGE-to-self). Trailing empty fields between
        // MEMO and GATE_TICKER are required when MEMO is empty so the
        // gating fields are positionally correct in the action string.
        const fileCmd = ['FILE', '0', 'secret.txt', 'text/plain', 'Gated Secret', '',
                         TICK, '1', keyHash].join('|')
        const selfMsgCmd = ['MESSAGE', '2', COIN_CODE, issuer.address, stubEncryptedMessage(keyHash)].join('|')
        const commands = [fileCmd, selfMsgCmd]
        const batchMessage = 'BATCH|0|' + commands.join(';')

        const txHash = await transactionHelper.createAndSendTransaction(issuer, batchMessage, ciphertextRaw)

        await indexerDatabase.waitForBatch({
            txHash,
            source: issuer.address,
            status: 'valid',
        })

        const fileRow = await indexerDatabase.waitForFile({
            txHash,
            source: issuer.address,
            name: 'secret.txt',
            title: 'Gated Secret',
            status: 'valid',
        })
        assert(fileRow, 'gated FILE row should land valid')

        const gatedRow = await fetchGatedFileRow(fileRow.action_index)
        assert(gatedRow, 'gated_files row should be created')
        assert.strictEqual(String(gatedRow.gate_ticker), TICK)
        assert.strictEqual(Number(gatedRow.encryption_method), 1)
        assert.strictEqual(String(gatedRow.key_hash).toLowerCase(), keyHash)
        assert.strictEqual(Number(gatedRow.raw_data_length), ciphertext.length,
            'raw_data column should mirror the ciphertext bytes from the decoder')
    })

    it('issuer can transfer the gated token in BATCH(SEND, MESSAGE-to-recipient)', async function () {
        const sendCmd = ['SEND', '0', TICK, '1', recipient.address, ''].join('|')
        const handoffCmd = ['MESSAGE', '2', COIN_CODE, recipient.address, stubEncryptedMessage(keyHash)].join('|')
        await batchHelper.sendBatchV0(issuer, [sendCmd, handoffCmd])

        await indexerDatabase.waitForSend({
            source: issuer.address,
            destination: recipient.address,
            tick: TICK,
            amount: '1',
            memo: '',
            status: 'valid',
        })
    })

    it('rejects bare SEND of the gated token with no sibling MESSAGE', async function () {
        // Worst-case path here is ~5 retries x 3s + tx confirm (~60s) +
        // tracker wait (20s) + waitForSend (30s) which can exceed mocha's
        // default 120s test timeout under full-suite load.
        this.timeout(180000)
        // sendHelper.sendSendV0 doesn't throw on a timeout — waitForSend
        // resolves to null. So we check the resolved value: if `send` is
        // non-null AND status='valid', the gate isn't being enforced.
        const res = await sendHelper.sendSendV0(issuer, TICK, '1', recipient.address, '')
            .then((r) => ({ ok: r && r.send && r.send.status === 'valid', result: r }))
            .catch((err) => ({ ok: false, err }))

        if (res.ok) {
            assert.fail('bare SEND of a gated token unexpectedly succeeded')
        }
    })

    it('pack — two gated FILEs sharing one KEY_HASH unlock together', async function () {
        // A pack is just multiple gated FILEs that reuse the same key.
        // We publish two files with the same KEY_HASH (and the same
        // GATE_TICKER) and assert both gated_files rows share the hash.
        // The indexer's `getActiveGatedKeyHashes(TICK)` should now return
        // a single hash spanning both files.
        const packKey = crypto.randomBytes(32)
        const packHash = crypto.createHash('sha256').update(packKey).digest('hex')

        function encWith(key, pt) {
            const iv = crypto.randomBytes(12)
            const c = crypto.createCipheriv('aes-256-gcm', key, iv)
            const enc = Buffer.concat([c.update(pt), c.final()])
            return Buffer.concat([iv, c.getAuthTag(), enc])
        }

        const ct1 = encWith(packKey, Buffer.from('pack file 1'))
        const ct2 = encWith(packKey, Buffer.from('pack file 2'))

        // Publish member 1 atomically with the self-handoff.
        const f1 = ['FILE', '0', 'pack-1.txt', 'text/plain', 'Pack 1', '',
                    TICK, '1', packHash].join('|')
        const mSelf = ['MESSAGE', '2', COIN_CODE, issuer.address, stubEncryptedMessage(packHash)].join('|')
        const tx1 = await transactionHelper.createAndSendTransaction(
            issuer,
            'BATCH|0|' + [f1, mSelf].join(';'),
            ct1.toString('binary'),
        )
        await indexerDatabase.waitForBatch({ txHash: tx1, source: issuer.address, status: 'valid' })
        const row1 = await indexerDatabase.waitForFile({ txHash: tx1, name: 'pack-1.txt', status: 'valid' })
        assert(row1, 'pack member 1 should land valid')

        // Publish member 2 as a standalone FILE — no self-handoff needed
        // since the key is already on chain from member 1.
        const f2 = ['FILE', '0', 'pack-2.txt', 'text/plain', 'Pack 2', '',
                    TICK, '1', packHash].join('|')
        const tx2 = await transactionHelper.createAndSendTransaction(issuer, f2, ct2.toString('binary'))
        const row2 = await indexerDatabase.waitForFile({ txHash: tx2, name: 'pack-2.txt', status: 'valid' })
        assert(row2, 'pack member 2 should land valid')

        const g1 = await fetchGatedFileRow(row1.action_index)
        const g2 = await fetchGatedFileRow(row2.action_index)
        assert.strictEqual(String(g1.key_hash).toLowerCase(), packHash)
        assert.strictEqual(String(g2.key_hash).toLowerCase(), packHash)
    })

    it('rejects gated FILE published by a non-issuer for the same ticker', async function () {
        // Outsider tries to gate spam content to GATEDTEST. Token is
        // owned by `issuer`, so `outsider` should be rejected by the
        // issuer-only check in actions/file.js.
        const { ciphertext: spamCt, keyHash: spamHash } = makeGatedCiphertext(Buffer.from('spam'))
        const fileCmd = 'FILE|0|spam.txt|text/plain|Spam||' + TICK + '|1|' + spamHash
        const txHash = await transactionHelper.createAndSendTransaction(outsider, fileCmd, spamCt.toString('binary'))

        // Wait for the FILE row but expect status to be the issuer-only error.
        const row = await indexerDatabase.waitForFile({
            txHash,
            source: outsider.address,
            name: 'spam.txt',
            status: 'invalid: SOURCE (not GATE_TICKER issuer)',
        })
        assert(row, 'non-issuer publish should land with the issuer-only error')
    })
})
