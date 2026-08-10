/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Guards for the XCALL quorum-drop planner .
 *
 * HERMETIC: pure arithmetic over fixture snapshots, no venue, no docker, no
 * database. It carries the .sdk.test.js name so the lane that runs the drills
 * this planner steers also runs its guards; it needs nothing that lane provides
 * and runs standalone just as well:
 *
 *   npx mocha --no-config --timeout 10000 test/sdk/xcallFederationPlan.sdk.test.js
 *
 * The failure this pins is the one  records: a drill that stops "the hub"
 * on a 3-hub federation leaves quorum intact, and nothing about the run says so.
 *
 ********************************************************************/

const { expect } = require('chai');
const plan = require('./xcallFederationPlan');

const PK = (n) => String(n).repeat(64).slice(0, 64);

// One source, one key, equal weights unless overridden.
function snapshot(specs) {
    return specs.map(s => ({ pubkey: s.pubkey, source: s.source || ('src-' + s.pubkey.slice(0, 8)), weight: s.weight || '5000.00000000' }));
}

describe('[sdk] XCALL federation quorum-drop planner ', function () {

    describe('count quorum mirrors the hub threshold', function () {
        it('is the majority floor, not bare 2f+1, at the sizes a drill sees', function () {
            // max(2*floor((n-1)/3)+1, ceil((n+1)/2)); bare 2f+1 degenerates to 1 at n=3.
            expect(plan.bftQuorum(2)).to.equal(2);
            expect(plan.bftQuorum(3)).to.equal(2);
            expect(plan.bftQuorum(4)).to.equal(3);
            expect(plan.bftQuorum(5)).to.equal(3);
            expect(plan.bftQuorum(7)).to.equal(5);
            expect(plan.bftQuorum(10)).to.equal(7);
        });

        it('treats a lone validator as its own quorum', function () {
            expect(plan.countQuorumFor(1)).to.equal(1);
            expect(plan.countQuorumFor(0)).to.equal(1);
        });
    });

    describe('the stake threshold is STRICT at exactly two thirds', function () {
        it('rejects a signer set holding exactly 2/3 of the stake', function () {
            const S = plan.toUnits('15000.00000000');
            expect(plan.meetsStakeThreshold(plan.toUnits('10000.00000000'), S)).to.equal(false);
            expect(plan.meetsStakeThreshold(plan.toUnits('10000.00000001'), S)).to.equal(true);
        });

        it('fails closed on a non-positive total', function () {
            expect(plan.meetsStakeThreshold(0n, 0n)).to.equal(false);
        });

        it('reads decimal weights exactly, never through a double', function () {
            expect(plan.toUnits('5000.00000000')).to.equal(5000n * 10n ** 18n);
            expect(plan.toUnits('0.00000001')).to.equal(10n ** 10n);
            expect(() => plan.toUnits('-1')).to.throw(/unreadable stake weight/);
            expect(() => plan.toUnits('')).to.throw(/unreadable stake weight/);
            expect(() => plan.toUnits(null)).to.throw(/unreadable stake weight/);
            expect(() => plan.toUnits('1e3')).to.throw(/unreadable stake weight/);
        });
    });

    describe('parseFederationSpec', function () {
        it('reads container=pubkey pairs off XCALL_HUB_CONTAINERS', function () {
            const spec = plan.parseFederationSpec({
                XCALL_HUB_CONTAINERS: 'hub-2=' + PK(1) + ', hub-3=' + PK(2) + ' , hub-4',
            });
            expect(spec.members).to.deep.equal([
                { container: 'hub-2', pubkey: PK(1) },
                { container: 'hub-3', pubkey: PK(2) },
                { container: 'hub-4', pubkey: null },
            ]);
        });

        it('pairs XCALL_HUB_PUBKEY with the legacy single container only when it IS the whole federation', function () {
            const solo = plan.parseFederationSpec({ XCALL_HUB_CONTAINER: 'xchain-node-xchain-hub', XCALL_HUB_PUBKEY: PK(7) });
            expect(solo.members).to.deep.equal([{ container: 'xchain-node-xchain-hub', pubkey: PK(7) }]);

            // With siblings declared, that pubkey is frequently hub 1 rather than
            // this container, so attributing it here would plan a WRONG drop.
            const fed = plan.parseFederationSpec({
                XCALL_HUB_CONTAINER: 'hub-1', XCALL_HUB_PUBKEY: PK(7),
                XCALL_HUB2_CONTAINER: 'hub-2', XCALL_HUB3_CONTAINER: 'hub-3',
            });
            expect(fed.members.map(m => m.container)).to.deep.equal(['hub-1', 'hub-2', 'hub-3']);
            expect(fed.members.every(m => m.pubkey === null)).to.equal(true);
        });

        it('refuses names and keys it would otherwise hand to docker', function () {
            expect(() => plan.parseFederationSpec({ XCALL_HUB_CONTAINERS: 'hub-2; rm -rf /' })).to.throw(/not a usable container name/);
            expect(() => plan.parseFederationSpec({ XCALL_HUB_CONTAINERS: 'hub-2=nothex' })).to.throw(/not a 64-hex validator pubkey/);
            expect(() => plan.parseFederationSpec({ XCALL_HUB_CONTAINERS: 'hub-2,hub-2' })).to.throw(/listed twice/);
        });
    });

    describe('planQuorumDrop on an N=3 equal-stake federation', function () {
        const snap = snapshot([{ pubkey: PK(1) }, { pubkey: PK(2) }, { pubkey: PK(3) }]);

        it('stops TWO of three, which is what the old single-container drill never did', function () {
            const out = plan.planQuorumDrop({
                snapshot: snap,
                stoppable: [
                    { container: 'hub-1', pubkey: PK(1) },
                    { container: 'hub-2', pubkey: PK(2) },
                    { container: 'hub-3', pubkey: PK(3) },
                ],
            });
            expect(out.n).to.equal(3);
            expect(out.countQuorum).to.equal(2);
            expect(out.stop).to.have.lengthOf(2);
            expect(out.survivingSources).to.equal(1);
            // A live-but-outvoted hub is left standing on purpose: the drill's
            // claim is about a federation that cannot agree, not a dead one.
            expect(out.witnesses).to.equal(1);
            expect(out.keepRunning).to.have.lengthOf(1);
        });

        it('leaves the surviving hub unable to clear EITHER half of the threshold', function () {
            const out = plan.planQuorumDrop({
                snapshot: snap,
                stoppable: [
                    { container: 'hub-1', pubkey: PK(1) },
                    { container: 'hub-2', pubkey: PK(2) },
                    { container: 'hub-3', pubkey: PK(3) },
                ],
            });
            const total = plan.toUnits('15000.00000000');
            expect(out.survivingSources).to.be.below(out.countQuorum);
            expect(plan.meetsStakeThreshold(plan.toUnits('5000.00000000'), total)).to.equal(false);
        });
    });

    describe('planQuorumDrop when part of the federation cannot be stopped', function () {
        // test-host's shape: relay hub 1 is a HOST process, hubs 2 and 3 are containers.
        const snap = snapshot([
            { pubkey: PK(1), weight: '3000.00000000' },
            { pubkey: PK(2), weight: '6000.00000000' },
            { pubkey: PK(3), weight: '6000.00000000' },
        ]);

        it('drops quorum by stopping only the containers, counting the host hub as a survivor', function () {
            const out = plan.planQuorumDrop({
                snapshot: snap,
                stoppable: [
                    { container: 'xchain-relay-hub-2', pubkey: PK(2) },
                    { container: 'xchain-relay-hub-3', pubkey: PK(3) },
                ],
            });
            expect(out.stop).to.deep.equal(['xchain-relay-hub-2', 'xchain-relay-hub-3']);
            expect(out.unstoppableSources).to.equal(1);
            expect(out.survivingSources).to.equal(1);
        });

        it('does the same with the equal stakes a plain 3-hub venue actually carries', function () {
            const equal = snapshot([{ pubkey: PK(1) }, { pubkey: PK(2) }, { pubkey: PK(3) }]);
            const out = plan.planQuorumDrop({
                snapshot: equal,
                stoppable: [
                    { container: 'xchain-relay-hub-2', pubkey: PK(2) },
                    { container: 'xchain-relay-hub-3', pubkey: PK(3) },
                ],
            });
            expect(out.stop).to.deep.equal(['xchain-relay-hub-2', 'xchain-relay-hub-3']);
            expect(out.survivingSources).to.equal(1);
            expect(out.countQuorum).to.equal(2);
        });

        it('refuses the run when the unstoppable remainder still holds quorum', function () {
            // Four validators, quorum 3, and only one is a container we can stop.
            const four = snapshot([{ pubkey: PK(1) }, { pubkey: PK(2) }, { pubkey: PK(3) }, { pubkey: PK(4) }]);
            expect(() => plan.planQuorumDrop({
                snapshot: four,
                stoppable: [{ container: 'hub-4', pubkey: PK(4) }],
            })).to.throw(/cannot drop this federation below quorum.*4 staked source\(s\), quorum 3/);
        });

        it('names the containers it could not attribute, so the fix is obvious', function () {
            expect(() => plan.planQuorumDrop({
                snapshot: snapshot([{ pubkey: PK(1) }, { pubkey: PK(2) }, { pubkey: PK(3) }]),
                stoppable: [{ container: 'hub-2' }, { container: 'hub-3' }],
            })).to.throw(/2 container\(s\) unattributed: hub-2, hub-3/);
        });
    });

    describe('planQuorumDrop refuses to plan off a snapshot it cannot trust', function () {
        it('rejects an empty validator set rather than reading it as "nobody can dispatch"', function () {
            expect(() => plan.planQuorumDrop({ snapshot: [], stoppable: [{ container: 'hub-1', pubkey: PK(1) }] }))
                .to.throw(/no active cross_chain validators/);
        });

        it('rejects a truncated snapshot', function () {
            const snap = snapshot([{ pubkey: PK(1) }]);
            snap.truncated = true;
            expect(() => plan.planQuorumDrop({ snapshot: snap, stoppable: [{ container: 'hub-1', pubkey: PK(1) }] }))
                .to.throw(/TRUNCATED/);
        });

        it('rejects a row with no staking source, which would collapse the stake bucket', function () {
            expect(() => plan.planQuorumDrop({
                snapshot: [{ pubkey: PK(1), source: '', weight: '5000.00000000' }],
                stoppable: [{ container: 'hub-1', pubkey: PK(1) }],
            })).to.throw(/no staking source/);
        });
    });

    describe('planQuorumDrop on the single-hub stack the drill started life on', function () {
        it('stops the only hub, and says so as a quorum drop of one', function () {
            const out = plan.planQuorumDrop({
                snapshot: snapshot([{ pubkey: PK(1) }]),
                stoppable: [{ container: 'xchain-node-xchain-hub', pubkey: PK(1) }],
            });
            expect(out.n).to.equal(1);
            expect(out.countQuorum).to.equal(1);
            expect(out.stop).to.deep.equal(['xchain-node-xchain-hub']);
            expect(out.survivingSources).to.equal(0);
        });
    });

    describe('a source with several delegated keys counts once', function () {
        it('dedupes by source, so extra keys neither inflate N nor S', function () {
            const shared = [
                { pubkey: PK(1), source: 'A', weight: '5000.00000000' },
                { pubkey: PK(2), source: 'A', weight: '5000.00000000' },
                { pubkey: PK(3), source: 'B', weight: '5000.00000000' },
            ];
            const view = plan.summarizeSnapshot(shared);
            expect(view.n).to.equal(2);
            expect(view.total).to.equal(plan.toUnits('10000.00000000'));
        });
    });
});
