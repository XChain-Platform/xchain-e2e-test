#!/usr/bin/env node
'use strict';

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
 * Offline preflight for the sibling repositories used by a rail drive.
 *
 *   node check-rail-sibling-links.js [--json] [directory]
 *
 * Exit 0 means the root is usable, 1 means its local paths refuse, and
 * 2 means the command line is invalid.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_RAIL_FILES = [
    'xchain-hub/src/api.js',
    'xchain-indexer/src/api.js',
];

function isDirectory(candidate) {
    return fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true;
}

function absoluteUsersPrefix(target) {
    return target.match(/^\/Users\/[^/]+/)?.[0] || null;
}

function inspectEntry(root, name) {
    const entryPath = path.join(root, name);
    const linkStat = fs.lstatSync(entryPath, { throwIfNoEntry: false });
    if (!linkStat) {
        return { name, path: entryPath, type: 'missing', resolves: false, isDirectory: false };
    }
    if (!linkStat.isSymbolicLink()) {
        const directory = isDirectory(entryPath);
        return {
            name,
            path: entryPath,
            type: directory ? 'directory' : 'not-directory',
            resolves: true,
            isDirectory: directory,
        };
    }

    const target = fs.readlinkSync(entryPath);
    const resolvedTarget = path.isAbsolute(target) ? path.normalize(target) : path.resolve(root, target);
    const resolvedStat = fs.statSync(entryPath, { throwIfNoEntry: false });
    return {
        name,
        path: entryPath,
        type: resolvedStat ? 'resolving-symlink' : 'dangling-symlink',
        target,
        resolvedTarget,
        resolves: Boolean(resolvedStat),
        isDirectory: resolvedStat?.isDirectory() === true,
        absoluteUsersPrefix: absoluteUsersPrefix(target),
    };
}

function inspectRailRoot(defaultRoot, environment = process.env) {
    const configured = String(environment.BRIDGE_RAIL_REPO_ROOT || '').trim();
    const repoRoot = configured ? path.resolve(configured) : defaultRoot;
    const required = REQUIRED_RAIL_FILES.map((relativePath) => {
        const wanted = path.join(repoRoot, relativePath);
        return {
            relativePath,
            wanted,
            exists: fs.statSync(wanted, { throwIfNoEntry: false })?.isFile() === true,
        };
    });
    return {
        source: configured ? 'environment' : 'default',
        path: repoRoot,
        resolves: isDirectory(repoRoot),
        required,
    };
}

function auditDirectory(requestedDirectory, environment = process.env) {
    const directory = path.resolve(requestedDirectory);
    const warnings = [];
    const refusals = [];

    if (!isDirectory(directory)) {
        refusals.push(`REFUSAL: ${directory} does not resolve to a directory; wanted a rail worktree directory.`);
        return { directory, entries: [], railRepoRoot: null, warnings, refusals, ok: false };
    }

    const names = fs.readdirSync(directory).filter((name) => name.startsWith('xchain-')).sort();
    const entries = names.map((name) => inspectEntry(directory, name));
    if (entries.length === 0) {
        refusals.push(`REFUSAL: ${directory} contains zero xchain-* entries; wanted at least one xchain-* sibling.`);
    }

    for (const entry of entries) {
        if (!entry.resolves) {
            refusals.push(`REFUSAL: ${entry.path} does not resolve; wanted ${entry.resolvedTarget || entry.path}.`);
        } else if (!entry.isDirectory) {
            refusals.push(`REFUSAL: ${entry.path} resolves, but not to a directory; wanted ${entry.resolvedTarget || entry.path}.`);
        }
        if (entry.absoluteUsersPrefix) {
            refusals.push(`REFUSAL: ${entry.path} points to ${entry.target}; prefix ${entry.absoluteUsersPrefix} must change for the runtime mount.`);
        }
    }

    const railRepoRoot = inspectRailRoot(directory, environment);
    if (railRepoRoot.source === 'default') {
        warnings.push(`WARNING: BRIDGE_RAIL_REPO_ROOT is unset; the venue default would be ${railRepoRoot.path}.`);
    }
    if (!railRepoRoot.resolves) {
        refusals.push(`REFUSAL: BRIDGE_RAIL_REPO_ROOT names ${railRepoRoot.path}, which does not resolve to a directory; wanted ${railRepoRoot.path}.`);
    } else {
        for (const required of railRepoRoot.required) {
            if (!required.exists) {
                refusals.push(`REFUSAL: rail repository root ${railRepoRoot.path} is incomplete; wanted ${required.wanted}.`);
            }
        }
    }

    return { directory, entries, railRepoRoot, warnings, refusals, ok: refusals.length === 0 };
}

function parseArgs(argv) {
    let json = false;
    let directory = null;
    for (const arg of argv) {
        if (arg === '--json') {
            json = true;
        } else if (arg.startsWith('-') || directory !== null) {
            return { error: `bad argument: ${arg}` };
        } else {
            directory = arg;
        }
    }
    return { json, directory: directory || process.cwd() };
}

function formatHuman(result) {
    const lines = [`check-rail-sibling-links: ${result.directory}`];
    for (const entry of result.entries) {
        lines.push(`  ${entry.name}: ${entry.type}${entry.target ? ` -> ${entry.target}` : ''}`);
    }
    if (result.railRepoRoot) {
        const setting = result.railRepoRoot.source === 'environment' ? 'set' : 'unset';
        const complete = result.railRepoRoot.required.every((required) => required.exists);
        lines.push(`  BRIDGE_RAIL_REPO_ROOT: ${setting}; effective path ${result.railRepoRoot.path}; `
            + `resolves ${result.railRepoRoot.resolves ? 'yes' : 'no'}; required siblings present `
            + `${complete ? 'yes' : 'no'}`);
    }
    lines.push(...result.warnings, ...result.refusals);
    if (result.ok) lines.push(`OK: ${result.directory} is fit to host a rail drive.`);
    return lines.join('\n');
}

function main(argv = process.argv.slice(2), environment = process.env) {
    const args = parseArgs(argv);
    if (args.error) {
        console.log(`check-rail-sibling-links: ${args.error}\n`
            + 'usage: node check-rail-sibling-links.js [--json] [directory]');
        return 2;
    }

    let result;
    try {
        result = auditDirectory(args.directory, environment);
    } catch (error) {
        const directory = path.resolve(args.directory);
        result = {
            directory,
            entries: [],
            railRepoRoot: null,
            warnings: [],
            refusals: [`REFUSAL: could not inspect ${directory}: ${error.message}`],
            ok: false,
        };
    }
    console.log(args.json ? JSON.stringify(result, null, 2) : formatHuman(result));
    return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = {
    REQUIRED_RAIL_FILES,
    isDirectory,
    absoluteUsersPrefix,
    inspectEntry,
    inspectRailRoot,
    auditDirectory,
    parseArgs,
    formatHuman,
    main,
};
