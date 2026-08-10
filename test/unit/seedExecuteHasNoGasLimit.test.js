/*
 * seed-contract-state: EXECUTE has no GAS_LIMIT slot, and passing one is fatal.
 *
 * DEPLOY carries GAS_LIMIT in every one of its wire formats. EXECUTE carries it
 * in none: the single format is
 *
 *     VERSION|CONTRACT_ACTION_INDEX|METHOD|...PARAMS
 *
 * An unknown field is NOT dropped on the way to the wire. The SDK's format
 * selector looks for a version that can represent the whole populated field set,
 * finds none, and throws NO_MATCHING_FORMAT. So `gasLimit` on an EXECUTE is not
 * a harmless hint, it is an action that cannot be built at all.
 *
 * That is worth a test rather than a comment because of WHERE it fails. The seed
 * tool's EXECUTEs are step 6 and 7, behind a DEPLOY that costs real coin and a
 * confirmation wait measured in tens of minutes on testnet4. The first fill ever
 * to reach that line died there on BTC:testnet 2026-08-06, after the contract
 * had been deployed and paid for twice over.
 *
 * This pins the wire fact the tool depends on, in the SDK where it is defined,
 * so a format change that adds or removes the slot shows up here rather than
 * three steps into a live run.
 */

const assert = require('assert');
const path   = require('path');

// The SDK the way the tool itself resolves it: staged copies carry no
// node_modules link, so a bare require('xchain-sdk') is not enough.
function loadFormats() {
    for (const c of ['xchain-sdk/src/formats.js',
                     '../../xchain-sdk/src/formats.js',
                     '../../../xchain-sdk/src/formats.js']) {
        try {
            return c.startsWith('.') ? require(path.resolve(__dirname, c)) : require(c);
        } catch (e) { /* next */ }
    }
    return null;
}

const mod = loadFormats();
const FORMATS = mod && (mod.FORMATS || mod.formats || mod);

describe('seed-contract-state: the EXECUTE wire format carries no gas limit', function () {

    before(function () {
        if (!FORMATS || !FORMATS.EXECUTE) this.skip();
    });

    it('EXECUTE has no GAS_LIMIT field in ANY version', function () {
        for (const [version, spec] of Object.entries(FORMATS.EXECUTE)) {
            assert.ok(
                !String(spec).includes('GAS_LIMIT'),
                'EXECUTE v' + version + ' unexpectedly carries GAS_LIMIT: ' + spec
            );
        }
    });

    // The contrast is the point: the tool passes gasLimit to DEPLOY on purpose
    // and must NOT pass it to EXECUTE, so a test that only checked EXECUTE could
    // pass against a build where the field had been removed from both.
    //
    // Not "every DEPLOY version", which is what this test asserted first and was
    // right to fail on: v4 is the chunked-code CARRIER (
    // VERSION|CODE_HASH|CHUNK_INDEX|TOTAL_CHUNKS|CODE_PART), a fragment of source
    // rather than a deployment, and it has no gas to limit. The tool deploys
    // inline, so v0 is the format that matters here.
    it('DEPLOY v0, the inline format this tool uses, DOES carry GAS_LIMIT', function () {
        assert.ok(String(FORMATS.DEPLOY[0]).includes('GAS_LIMIT'),
            'DEPLOY v0 unexpectedly lacks GAS_LIMIT: ' + FORMATS.DEPLOY[0]);
        assert.ok(!String(FORMATS.DEPLOY[4] || '').includes('GAS_LIMIT'),
            'DEPLOY v4 is the chunk carrier and should have no GAS_LIMIT: ' + FORMATS.DEPLOY[4]);
    });

    it('EXECUTE v0 is exactly the four-slot form the tool builds against', function () {
        assert.strictEqual(FORMATS.EXECUTE[0], 'VERSION|CONTRACT_ACTION_INDEX|METHOD|...PARAMS');
    });

    // The tool must not reintroduce the field. Reading the source is crude, but
    // the alternative is a live broadcast, and this is the one guard that fails
    // in CI rather than three steps into a paid run.
    it('the seed tool passes no gasLimit to either of its EXECUTEs', function () {
        const fs  = require('fs');
        const src = fs.readFileSync(path.join(__dirname, '../../bin/seed-contract-state.js'), 'utf8');
        // Each EXECUTE submit block runs from "action: 'EXECUTE'" to the closing
        // "} }," of its params object.
        const blocks = src.split("action: 'EXECUTE'").slice(1);
        assert.strictEqual(blocks.length, 2, 'expected exactly two EXECUTE call sites');
        for (const b of blocks) {
            // Comments explaining WHY there is no gasLimit are not gasLimit.
            const head = b.slice(0, b.indexOf('} },')).replace(/\/\/[^\n]*/g, '');
            assert.ok(!/gasLimit\s*[:,}]/.test(head),
                'an EXECUTE call site passes gasLimit, which makes the action unencodable:\n' + head);
        }
    });
});
