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

        it('reports BTC:testnet as SHADOWING but NOT armed, which is what decides whether the journal is written', function () {
            // This assertion is the opposite of what it was when first written,
            // and the change is the point rather than a correction: on
            // 2026-08-11 this chain had neither an armed height nor a window, so
            // seeding escrows produced an empty journal, and the tool said so.
            // The §7 shadow window was then opened at 148000, which is what
            // starts the journal writer without committing anything.
            const g = escrowLeafGate('BTC', 'testnet');
            assert.strictEqual(g.resolved, true);
            assert.strictEqual(g.shadow, 148000, 'the §7 shadow window opened on this chain');
            // Still NOT armed, and that is the half that must not drift: a shadow
            // commits nothing, so locked-balance proofs stay refused here.
            assert.strictEqual(g.armed, null, 'a shadow window must never read as an arming');
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
