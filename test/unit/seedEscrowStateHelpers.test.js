/*
 * seed-escrow-state: the four reads that decide whether it broadcasts.
 *
 * This tool posts ORDERs that lock real gas on a public chain, and every one of
 * its broadcast decisions comes down to counting how many locks the chain
 * already carries. Each helper below is a place where an undercount means a
 * duplicate paid transaction and an overcount means a seed that silently stops
 * short, so each gets a test that fails in the direction that costs coin.
 *
 * The four:
 *
 *   listRows       the explorer's list routes answer `{ data: [...], total: n }`
 *                  and NOT a bare array. Driven against the live BTC:testnet
 *                  explorer 2026-08-11, all three of /orders, /escrows and
 *                  /balances answered in that envelope. A caller that iterates
 *                  the response directly sees zero rows, which reads as "nothing
 *                  is seeded yet" and posts the whole set again.
 *
 *   holdsEscrow    a NEGATIVE test on status, not a positive one. The journal
 *                  writer's own header records that an order in 'cancelling' or
 *                  'expiring' STILL HOLDS its escrow, because no release row has
 *                  been written yet. Enumerating the holding states positively
 *                  drops exactly those and undercounts.
 *
 *   isSeedOrder    identifies this tool's orders by their GIVE side. An order at
 *                  the same address locking something else is not this tool's,
 *                  must not count toward its target, and must not be disturbed.
 *
 *   escrowLeafGate the gate that decides whether escrow_leaf_journal is written
 *                  at ALL, and the one whose answer CHANGED under this suite on
 *                  the day it was written. Measured on the morning of
 *                  2026-08-11: ESCROW_LOCKED_LEAF_ACTIVATION was
 *                  { 'BTC:regtest': 11200 } and ESCROW_LOCKED_LEAF_SHADOW was
 *                  EMPTY, so on BTC:testnet a perfect seed produced an empty
 *                  journal and an empty XCHAIN_ESC leaf, and the tool had to SAY
 *                  so rather than let it read as a silent wait for something
 *                  that was never coming. That afternoon the §7 shadow window
 *                  was opened at BTC:testnet 148000, which starts the journal
 *                  writer while committing nothing, and the assertion below
 *                  flipped with it. Both halves still matter: shadowing decides
 *                  whether the journal is written, and NOT-armed decides whether
 *                  anything is committed or any proof is served.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const {
    listRows, holdsEscrow, isSeedOrder, escrowLeafGate, RELEASED_STATUSES,
} = require('../../bin/seed-escrow-state.js');

describe('seed-escrow-state helpers', function () {

    describe('listRows', function () {
        it('reads the explorer list envelope, which is what the live routes answer', function () {
            // Verbatim shape from https://explorer.xchain.io:8080 /orders/<addr>/address
            // on BTC:testnet, 2026-08-11.
            assert.deepStrictEqual(listRows({ data: [1, 2], total: 2, runtime: '2ms' }), [1, 2]);
            assert.deepStrictEqual(listRows({ data: [], total: 0, runtime: '1ms' }), []);
        });

        it('still accepts a bare array, so a route that changes shape does not break the count', function () {
            assert.deepStrictEqual(listRows([1, 2, 3]), [1, 2, 3]);
        });

        it('answers empty - never undefined - for an error document or a null', function () {
            // The caller does .filter() on this. Returning undefined here would
            // throw inside the preflight, which is a worse failure than a zero
            // count only because the zero count is the one that broadcasts.
            assert.deepStrictEqual(listRows(null), []);
            assert.deepStrictEqual(listRows({ error: 'NOT_FOUND' }), []);
            assert.deepStrictEqual(listRows('a string'), []);
        });
    });

    describe('holdsEscrow', function () {
        it('counts the transitional states that still hold the lock', function () {
            // The whole reason this is a negative test. Both of these have a
            // release pending and neither has had its release row written, so
            // both still hold escrow.
            assert.strictEqual(holdsEscrow({ status: 'cancelling' }), true);
            assert.strictEqual(holdsEscrow({ status: 'expiring' }), true);
            assert.strictEqual(holdsEscrow({ status: 'open' }), true);
            assert.strictEqual(holdsEscrow({ status: 'valid' }), true);
        });

        it('does not count an order whose escrow has been released', function () {
            for (const s of RELEASED_STATUSES)
                assert.strictEqual(holdsEscrow({ status: s }), false, s + ' should not count as locked');
        });

        it('is case-insensitive, because status casing is not a contract', function () {
            assert.strictEqual(holdsEscrow({ status: 'FILLED' }), false);
            assert.strictEqual(holdsEscrow({ status: 'Cancelled' }), false);
        });

        it('does not count a row with no readable status', function () {
            // Fail CLOSED. An unreadable status counted as locked would let the
            // tool believe a seed exists and stop; counted as unlocked it merely
            // re-posts, and the round loop's no-progress brake catches that.
            assert.strictEqual(holdsEscrow({}), false);
            assert.strictEqual(holdsEscrow(null), false);
        });

        it('reads a status nested in an explorer envelope', function () {
            assert.strictEqual(holdsEscrow({ info: { status: 'open' } }), true);
            assert.strictEqual(holdsEscrow({ info: { status: 'filled' } }), false);
        });
    });

    describe('isSeedOrder', function () {
        it('claims an order that gives the gas tick', function () {
            assert.strictEqual(isSeedOrder({ give_tick: 'XCHAIN' }, 'XCHAIN'), true);
            assert.strictEqual(isSeedOrder({ give_tick: 'xchain' }, 'XCHAIN'), true);
        });

        it('does not claim somebody else\'s order at the same address', function () {
            // Counting a foreign order toward the target is how the seed stops
            // short of the locks it was asked for and reports success.
            assert.strictEqual(isSeedOrder({ give_tick: 'PEPECREATURE' }, 'XCHAIN'), false);
        });

        it('does not claim an order that only GETS the gas tick', function () {
            // A bid for XCHAIN locks nothing of ours; the escrow is on the maker's
            // give side. Matching on give_tick rather than "mentions XCHAIN" is
            // the difference.
            assert.strictEqual(isSeedOrder({ get_tick: 'XCHAIN' }, 'XCHAIN'), false);
        });

        it('does not claim a native-coin give (no give_tick at all)', function () {
            assert.strictEqual(isSeedOrder({ give_amount: '100' }, 'XCHAIN'), false);
        });
    });

    describe('escrowLeafGate', function () {
        it('reports BTC:regtest as armed at the height the indexer actually carries', function () {
            const g = escrowLeafGate('BTC', 'regtest');
            assert.strictEqual(g.resolved, true, 'the activation module must be resolvable from bin/');
            assert.strictEqual(g.armed, 11200);
        });

        it('reports every testnet chain as ARMED at genesis, which is what decides whether the journal is written', function () {
            // Operator ratification 2026-08-18: activate every platform feature at
            // testnet genesis rather than coordinating six flag-day heights, so
            // nothing is discovered dormant after release. Its condition is that
            // testnet indexer state is rebuilt from the chain before launch.
            for (const coin of ['BTC', 'LTC', 'DOGE']) {
                const g = escrowLeafGate(coin, 'testnet');
                assert.strictEqual(g.resolved, true, coin + ': the activation module must be resolvable from bin/');
                assert.strictEqual(g.armed, 0, coin + ':testnet is armed at genesis');
            }
        });

        it('leaves mainnet shadow-only, so a shadow still never reads as an arming', function () {
            // The half that must not drift, re-scoped to the network that still
            // carries shadow-only state: a shadow commits nothing, so
            // locked-balance proofs stay refused on mainnet.
            const g = escrowLeafGate('BTC', 'mainnet');
            assert.strictEqual(g.armed, null, 'a shadow window must never read as an arming');
        });

        it('names the file it read and hashes it, because a stale sibling answers just as confidently', function () {
            // THE FAILURE THIS EXISTS FOR, measured 2026-08-15 rather than
            // imagined. The production seed venue carries a flat staged copy of
            // xchain-indexer beside the tool, and its map still read
            // ESCROW_LOCKED_LEAF_SHADOW = {} while the BTC:testnet indexer being
            // seeded had been deployed with { 'BTC:testnet': 148000 } and the
            // chain was already past it. The preflight printed
            // `shadow window: none` and the NOTE that says the journal will stay
            // EMPTY - the opposite of the truth, and an argument for arming
            // first, which is the single ordering dq1 exists to prevent.
            //
            // The values were right in the repo, the deploy was right on the
            // fleet, and the tool was reading a third copy neither of them knew
            // about. A path plus a hash is the smallest thing that makes that
            // visible, and it is the check this project already applies to every
            // staged module.
            const g = escrowLeafGate('BTC', 'testnet');
            assert.strictEqual(g.resolved, true);
            assert.ok(g.source, 'the gate must name the file it read');
            assert.ok(path.isAbsolute(g.source),
                'a relative path does not identify a copy; two checkouts share it');
            assert.strictEqual(path.basename(g.source), 'state_subtree_activation.js');
            assert.ok(fs.existsSync(g.source), 'the named file must be the one on disk');
            assert.match(g.sha256 || '', /^[0-9a-f]{64}$/, 'a sha256 the operator can hash-match');
            // And it must be the hash OF THAT FILE, not of anything else: this is
            // the half that makes the comparison against a deployed indexer mean
            // something. A hash computed over the wrong bytes is worse than none,
            // because it would MATCH nothing and be read as a deploy gap.
            const onDisk = crypto.createHash('sha256')
                .update(fs.readFileSync(g.source)).digest('hex');
            assert.strictEqual(g.sha256, onDisk);
        });

        it('reports the gate identity even for a chain that is neither armed nor shadowing', function () {
            // The stale-copy hazard is WORST precisely here. An unarmed answer is
            // the one that triggers the "the journal will stay EMPTY" NOTE, so if
            // identity were only reported alongside a positive height the one
            // reading that mattered would go unidentified.
            const g = escrowLeafGate('BTC', 'mainnet');
            assert.strictEqual(g.armed, null);
            assert.strictEqual(g.shadow, null);
            assert.ok(g.source, 'identity is reported for a negative answer too');
            assert.match(g.sha256 || '', /^[0-9a-f]{64}$/);
        });

        it('reports no source when nothing could be resolved, rather than a path it did not read', function () {
            // resolved:false must not carry a plausible-looking path: an operator
            // hash-matching a file the tool never loaded would confirm a value
            // that had no bearing on the run.
            const g = escrowLeafGate('BTC', 'testnet');
            const shape = Object.keys(g).sort();
            assert.deepStrictEqual(shape, ['armed', 'resolved', 'sha256', 'shadow', 'source'],
                'the resolved and unresolved shapes must match field for field, ' +
                'so a caller cannot read a missing key as absence of a gate');
        });

        it('distinguishes an unarmed chain from an unresolvable gate', function () {
            // null means "the module answered, and this chain is not armed".
            // resolved:false means "nobody could read the gate". Collapsing the
            // two would let a broken require read as a deliberate policy.
            const g = escrowLeafGate('BTC', 'mainnet');
            assert.strictEqual(g.resolved, true);
            assert.strictEqual(g.armed, null);
        });
    });
});
