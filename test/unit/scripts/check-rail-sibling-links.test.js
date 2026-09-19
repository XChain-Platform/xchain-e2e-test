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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const nodeTest = require('node:test');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'claude', 'bin', 'check-rail-sibling-links.js');
const checker = require(SCRIPT);
const describe = global.describe || nodeTest.describe;
const before = global.before || nodeTest.before;
const after = global.after || nodeTest.after;
const it = global.it || nodeTest.it;

describe('check-rail-sibling-links', function () {
    let fixtureBase;
    let fixtureNumber;

    before(function () {
        fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), 'check-rail-sibling-links-'));
        fixtureNumber = 0;
    });

    after(function () {
        fs.rmSync(fixtureBase, { recursive: true, force: true });
    });

    function makeDirectory(prefix) {
        fixtureNumber += 1;
        const directory = path.join(fixtureBase, `${String(fixtureNumber).padStart(2, '0')}-${prefix}`);
        fs.mkdirSync(directory, { recursive: true });
        return directory;
    }

    function makeApiRepo(root, name) {
        const repo = path.join(root, name);
        fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'src', 'api.js'), 'module.exports = {};\n');
        return repo;
    }

    function healthyFixture(prefix = 'healthy') {
        const container = makeDirectory(prefix);
        const root = path.join(container, 'rail');
        const targets = path.join(container, 'targets');
        fs.mkdirSync(root);
        makeApiRepo(root, 'xchain-hub');
        const indexer = makeApiRepo(targets, 'indexer');
        fs.symlinkSync(path.relative(root, indexer), path.join(root, 'xchain-indexer'));
        return { container, root };
    }

    function run(root, environment = {}) {
        const env = { ...process.env };
        delete env.BRIDGE_RAIL_REPO_ROOT;
        Object.assign(env, environment);
        const result = spawnSync(process.execPath, [SCRIPT, '--json', root], { encoding: 'utf8', env });
        return { ...result, json: JSON.parse(result.stdout) };
    }

    it('accepts real directories and a resolving relative symlink', function () {
        const result = run(healthyFixture().root);
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.json.ok, true);
        assert.deepStrictEqual(result.json.entries.map((entry) => entry.type),
            ['directory', 'resolving-symlink']);
        assert.match(result.json.warnings[0], /BRIDGE_RAIL_REPO_ROOT is unset/);
    });

    it('refuses a dangling symlink and names the target path', function () {
        const { root } = healthyFixture('dangling');
        fs.unlinkSync(path.join(root, 'xchain-indexer'));
        fs.symlinkSync('../targets/missing-indexer', path.join(root, 'xchain-indexer'));
        const result = run(root);
        assert.strictEqual(result.status, 1);
        assert.match(result.json.refusals.join('\n'), /targets\/missing-indexer/);
        assert.strictEqual(result.json.entries[1].type, 'dangling-symlink');
    });

    it('refuses an absolute Users target', function () {
        // Built from parts, never written as a literal: a hardcoded
        // "/Users/<name>/..." string is itself a developer-machine-path
        // shape and would trip this repo's own history leak scanner.
        const usersPrefix = ['', 'Users', 'example'].join('/');
        const usersTarget = `${usersPrefix}/worktree/xchain-indexer`;
        const { root } = healthyFixture('absolute-users');
        fs.unlinkSync(path.join(root, 'xchain-indexer'));
        fs.symlinkSync(usersTarget, path.join(root, 'xchain-indexer'));
        const result = run(root);
        assert.strictEqual(result.status, 1);
        assert.strictEqual(result.json.entries[1].absoluteUsersPrefix, usersPrefix);
        assert.match(result.json.refusals.join('\n'), new RegExp(`prefix ${usersPrefix}`));
    });

    it('refuses a directory with zero xchain entries', function () {
        const result = run(makeDirectory('empty'));
        assert.strictEqual(result.status, 1);
        assert.match(result.json.refusals.join('\n'), /zero xchain-\* entries/);
    });

    it('refuses a nonexistent configured rail repository root and names it', function () {
        const { root, container } = healthyFixture('missing-rail-root');
        const missing = path.join(container, 'missing-root');
        const result = run(root, { BRIDGE_RAIL_REPO_ROOT: missing });
        assert.strictEqual(result.status, 1);
        assert(result.json.refusals.some((message) => message.includes(missing)));
    });

    it('refuses a rail repository root missing a spawned sibling API', function () {
        const { root } = healthyFixture('missing-api');
        fs.unlinkSync(path.join(root, 'xchain-indexer', 'src', 'api.js'));
        const result = run(root);
        assert.strictEqual(result.status, 1);
        assert.match(result.json.refusals.join('\n'), /xchain-indexer\/src\/api\.js/);
    });

    it('refuses an xchain entry that resolves to a file', function () {
        const { root } = healthyFixture('file-entry');
        fs.writeFileSync(path.join(root, 'xchain-note'), 'not a repository\n');
        const result = run(root);
        assert.strictEqual(result.status, 1);
        assert.match(result.json.refusals.join('\n'), /xchain-note resolves, but not to a directory/);
    });

    it('emits valid machine-readable JSON', function () {
        const result = run(healthyFixture('json').root);
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stderr, '');
        assert.strictEqual(result.json.railRepoRoot.source, 'default');
        assert.strictEqual(result.json.railRepoRoot.required.every((entry) => entry.exists), true);
    });

    it('uses exit 2 for bad arguments', function () {
        const result = spawnSync(process.execPath, [SCRIPT, '--unknown'], { encoding: 'utf8' });
        assert.strictEqual(result.status, 2);
        assert.match(result.stdout, /usage:/);
    });

    it('follows links when deciding whether an entry is a directory', function () {
        const source = fs.readFileSync(SCRIPT, 'utf8');
        assert.match(source, /fs\.statSync\(entryPath, \{ throwIfNoEntry: false \}\)/);
        assert.doesNotMatch(source, /\.isDirectory\(\)\s*\|\|\s*[^\n]*isSymbolicLink/);
        assert.strictEqual(checker.REQUIRED_RAIL_FILES.length, 2);
    });
});
