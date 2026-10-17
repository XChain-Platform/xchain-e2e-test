'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const loadRailGateContract = require('../integration/lib/rail_gate_contract');
const fixture = require('../fixtures/rail/ci_gate_contract.json');

function dispatcherWith(exit95 = 95) {
    return `while :; do
    case $rc in
      99) continue ;;
      97) continue ;;
      ${exit95}) exit $rc ;;
      94) exit $rc ;;
      93) exit $rc ;;
      92) exit $rc ;;
      2) exit $rc ;;
      255) exit $rc ;;
      *) exit $rc ;;
    esac
  if [ $now -ge $deadline ]; then
    exit 3
  fi
done
`;
}

describe('rail gate contract loader', function () {
    let scratch;
    let originalHome;

    beforeEach(function () {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rail-gate-contract-'));
        originalHome = process.env.HOME;
        process.env.HOME = scratch;
    });

    afterEach(function () {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('returns and names the checked-in fixture when HOME has no host tooling', function () {
        const lines = [];
        const actual = loadRailGateContract({ log: (line) => lines.push(line) });

        assert.deepStrictEqual(actual, fixture);
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].includes(loadRailGateContract.FIXTURE_PATH), lines[0]);
    });

    it('resolves the dispatcher path under HOME', function () {
        assert.strictEqual(loadRailGateContract.dispatcherPath({ home: scratch }),
            path.join(scratch, '.claude', 'bin', 'ci-dispatch.sh'));
    });

    it('honors an explicit dispatcher path', function () {
        const explicitPath = path.join(scratch, 'dispatcher.sh');
        assert.strictEqual(loadRailGateContract.dispatcherPath({ dispatcherPath: explicitPath }),
            explicitPath);
    });

    it('pins the gate-did-not-run exits consumed by AT9', function () {
        assert.deepStrictEqual(fixture.gateDidNotRunExits, [2, 3, 94, 95, 97, 99, 255]);
    });

    it('accepts a host dispatcher whose exit table matches the fixture', function () {
        const dispatcher = path.join(scratch, '.claude', 'bin', 'ci-dispatch.sh');
        fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
        fs.writeFileSync(dispatcher, dispatcherWith());

        assert.deepStrictEqual(loadRailGateContract(), fixture);
    });

    it('rejects exit-table drift and names both copies', function () {
        const dispatcher = path.join(scratch, '.claude', 'bin', 'ci-dispatch.sh');
        fs.mkdirSync(path.dirname(dispatcher), { recursive: true });
        fs.writeFileSync(dispatcher, dispatcherWith(96));

        assert.throws(() => loadRailGateContract(), (error) => {
            assert.ok(error.message.includes(loadRailGateContract.FIXTURE_PATH), error.message);
            assert.ok(error.message.includes(dispatcher), error.message);
            return true;
        });
    });
});

describe('directGateTarget', function () {
    const { directGateTarget } = loadRailGateContract;

    it('stays on the drive host when CI_VENUES is unset', function () {
        const target = directGateTarget('', { hostname: 'drive' });
        assert.deepStrictEqual(target, { venue: 'drive', transport: 'direct', remote: false, tried: [] });
    });

    it('picks the first reachable venue, skipping unreachable ones', function () {
        const target = directGateTarget('a:1 b:2 c', { hostname: 'drive', probe: (h) => h !== 'a' });
        assert.strictEqual(target.venue, 'b');
        assert.strictEqual(target.remote, true);
        assert.deepStrictEqual(target.tried, ['a', 'b']);
    });

    it('never falls back to the drive host when no venue is reachable', function () {
        assert.throws(() => directGateTarget('a b', { hostname: 'drive', probe: () => false }),
            /no CI venue is reachable.*a, b/);
    });
});

describe('directGateFailureMessage', function () {
    const { directGateFailureMessage } = loadRailGateContract;

    it('names the red ci:full tier and every mocha failure before the stderr tail', function () {
        const message = directGateFailureMessage({
            status: 1,
            signal: null,
            error: null,
            stdout: [
                'ci:full ----- unit FAIL (3s)',
                'ci:full ----- integration FAIL (12s)',
                '  2 failing',
                '',
                '  1) Suite A',
                '       does b:',
                '     AssertionError: x',
                '',
                '  2) Suite C',
                '       does d:',
                '     Error: y',
                'ci:full: RED tiers: [unit integration]',
            ].join('\n'),
            tail: 'stderr-only tail',
        }, 'ci-one');

        assert.match(message, /ci:full FAIL tier: unit/);
        assert.match(message, /ci:full FAIL tier: integration/);
        assert.match(message, /ci:full: RED tiers: \[unit integration\]/);
        assert.match(message, /mocha failing title: Suite A does b:/);
        assert.match(message, /mocha failing title: Suite C does d:/);
        assert.ok(message.indexOf('mocha failing title: Suite C does d:') <
            message.indexOf('stderr-only tail'));
    });
});

describe('venueWorktreeScript', function () {
    const { venueWorktreeScript } = loadRailGateContract;
    const { spawnSync } = require('child_process');

    it('runs the gate in a scratch worktree named xchain-e2e-test with cached siblings', function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-wt-'));
        try {
            const git = (cwd, ...args) => {
                const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
                assert.strictEqual(r.status, 0, r.stderr);
            };
            const tree = path.join(root, 'xchain-e2e-test');
            fs.mkdirSync(path.join(tree, 'node_modules'), { recursive: true });
            fs.mkdirSync(path.join(root, 'xchain-hub'));
            fs.mkdirSync(path.join(root, 'coin-registry'));
            fs.writeFileSync(path.join(tree, 'old.txt'), 'old');
            git(tree, 'init', '-q');
            git(tree, 'add', 'old.txt');
            git(tree, 'commit', '-qm', 'cached');
            const head = path.join(root, 'head');
            fs.mkdirSync(head);
            fs.writeFileSync(path.join(head, 'new.txt'), 'new');
            const tar = spawnSync('tar', ['-c', '-C', head, '.']);
            assert.strictEqual(tar.status, 0);

            const gate = 'sh -c \'echo "tier=$CI_TIER enc=$ENC name=$(basename "$PWD") ' +
                'nm=$(test -d node_modules && echo y) hub=$(test -L ../xchain-hub && echo y) ' +
                'coins=$(test -L ../coin-registry && echo y) old=$(test -e old.txt && echo y) ' +
                'new=$(test -e new.txt && echo y)"\'';
            const script = venueWorktreeScript({ tree, command: gate, enclosingEnv: 'ENC' });
            const res = spawnSync('bash', ['-c', script], { input: tar.stdout, encoding: 'utf8' });
            assert.strictEqual(res.status, 0, res.stderr);
            assert.match(res.stdout,
                /tier=full enc=\S+ name=xchain-e2e-test nm=y hub=y coins=y old= new=y/);
            assert.ok(!fs.existsSync(path.join(tree, 'new.txt')));
            assert.deepStrictEqual(fs.readdirSync(root).filter((n) => n.startsWith('.at9-wt')), []);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('pins each cached sibling and refuses a dirty sibling', function () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venue-pins-'));
        try {
            const git = (cwd, ...args) => {
                const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
                    { cwd, encoding: 'utf8' });
                assert.strictEqual(r.status, 0, r.stderr);
                return r.stdout.trim();
            };
            const tree = path.join(root, 'xchain-e2e-test');
            const sibling = path.join(root, 'xchain-hub');
            for (const repo of [tree, sibling]) {
                fs.mkdirSync(repo);
                git(repo, 'init', '-q');
                fs.writeFileSync(path.join(repo, 'tracked.txt'), 'clean\n');
                git(repo, 'add', 'tracked.txt');
                git(repo, 'commit', '-qm', 'cached');
            }
            const siblingHead = git(sibling, 'rev-parse', 'HEAD');
            const helperPath = path.resolve(__dirname, '../helpers/sibling_checkout.js');
            const head = path.join(root, 'head');
            fs.mkdirSync(head);
            fs.writeFileSync(path.join(head, 'check.js'), [
                `'use strict';`,
                `const path = require('path');`,
                `const { siblingCheckout } = require(${JSON.stringify(helperPath)});`,
                `const verdict = siblingCheckout(path.join(process.cwd(), 'test', 'unit'),`,
                `    '../../../xchain-hub', { ownRoot: process.cwd() });`,
                `process.stdout.write(JSON.stringify({ pins: JSON.parse(process.env.XCHAIN_SIBLING_COMMITS), verdict }));`,
                `if (!verdict.usable) process.exit(42);`,
            ].join('\n'));
            const tar = spawnSync('tar', ['-c', '-C', head, '.']);
            assert.strictEqual(tar.status, 0, tar.stderr);

            const script = venueWorktreeScript({ tree, command: 'node check.js', enclosingEnv: 'ENC' });
            const clean = spawnSync('bash', ['-c', script], { input: tar.stdout, encoding: 'utf8' });
            assert.strictEqual(clean.status, 0, clean.stderr);
            const cleanResult = JSON.parse(clean.stdout);
            assert.strictEqual(cleanResult.pins['xchain-hub'], siblingHead);
            assert.strictEqual(cleanResult.verdict.usable, true);

            fs.writeFileSync(path.join(sibling, 'tracked.txt'), 'dirty\n');
            const dirty = spawnSync('bash', ['-c', script], { input: tar.stdout, encoding: 'utf8' });
            assert.strictEqual(dirty.status, 42, dirty.stderr);
            const dirtyResult = JSON.parse(dirty.stdout);
            assert.strictEqual(dirtyResult.pins['xchain-hub'], siblingHead);
            assert.strictEqual(dirtyResult.verdict.usable, false);
            assert.match(dirtyResult.verdict.reason, /which no commit pins/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('fails without running the gate when the cached tree is absent', function () {
        const script = venueWorktreeScript({ tree: path.join(os.tmpdir(), 'no-such-tree'), command: 'echo ran', enclosingEnv: 'ENC' });
        const res = spawnSync('bash', ['-c', script], { input: '', encoding: 'utf8' });
        assert.strictEqual(res.status, 1);
        assert.ok(!res.stdout.includes('ran'));
    });
});
