#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Pins the byte identity of the coin registry and every vendored twin.
 *
 * USAGE
 *   node bin/pin-identity.js
 *   node bin/pin-identity.js --out <file>
 *   node bin/pin-identity.js --compare <pin>
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SUITE_TITLE_PIN = 'bin/pins/at1-suite-titles.json';
const COIN_FILES = [
    'src/coins/BTC.js',
    'src/coins/DOGE.js',
    'src/coins/LTC.js',
    'src/coins/consensus_pin.js',
    'src/coins/index.js',
];
const VENDORED_TWIN_FILES = COIN_FILES.slice();

function sha256File(relativePath) {
    const bytes = fs.readFileSync(path.join(REPO_ROOT, relativePath));
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFiles(files) {
    const hashes = {};
    for (const relativePath of files.slice().sort()) hashes[relativePath] = sha256File(relativePath);
    return hashes;
}

function buildIdentity() {
    const coinsDirectory = path.join(REPO_ROOT, 'src', 'coins');
    const coinsPresent = fs.existsSync(coinsDirectory) && fs.statSync(coinsDirectory).isDirectory();
    const suiteTitlePin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, SUITE_TITLE_PIN), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const expectedScripts = Object.keys(pkg.scripts || {}).filter((name) => name.startsWith('test'));
    const { validatePin } = require('./suite-title-map');
    const suiteProblems = validatePin(suiteTitlePin, expectedScripts);
    if (suiteProblems.length) throw new Error(`invalid suite-title pin: ${suiteProblems.join('; ')}`);
    return {
        algorithm: 'sha256',
        coins: coinsPresent ? hashFiles(COIN_FILES) : { none: 'repository has no src/coins directory' },
        vendoredTwins: VENDORED_TWIN_FILES.length
            ? hashFiles(VENDORED_TWIN_FILES)
            : { none: 'repository carries no vendored twin files' },
        suiteTitleMap: {
            path: SUITE_TITLE_PIN,
            sha256: sha256File(SUITE_TITLE_PIN),
            scripts: Object.keys(suiteTitlePin.scripts).length,
            titleSets: Object.keys(suiteTitlePin.titleSets).length,
        },
    };
}

function compare(pin, fresh) {
    const differences = [];
    for (const section of ['algorithm', 'coins', 'vendoredTwins', 'suiteTitleMap']) {
        if (JSON.stringify(pin[section]) !== JSON.stringify(fresh[section])) differences.push(section);
    }
    for (const section of Object.keys(pin)) {
        if (!Object.prototype.hasOwnProperty.call(fresh, section)) differences.push(section);
    }
    for (const section of Object.keys(fresh)) {
        if (!Object.prototype.hasOwnProperty.call(pin, section)) differences.push(section);
    }
    return Array.from(new Set(differences)).sort();
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--out') {
            options.out = path.resolve(argv[i + 1]);
            i += 1;
        } else if (argv[i] === '--compare') {
            options.compare = path.resolve(argv[i + 1]);
            i += 1;
        } else if (argv[i] === '--help' || argv[i] === '-h') {
            options.help = true;
        } else {
            throw new Error(`unknown argument: ${argv[i]}`);
        }
    }
    return options;
}

function serialize(identity) {
    return `${JSON.stringify(identity, null, 2)}\n`;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }

    const identity = buildIdentity();
    if (options.compare) {
        const pin = JSON.parse(fs.readFileSync(options.compare, 'utf8'));
        const differences = compare(pin, identity);
        if (!differences.length) {
            console.log(`identity holds against ${path.relative(REPO_ROOT, options.compare)}`);
            return;
        }
        console.error(`identity mismatch in: ${differences.join(', ')}`);
        process.exitCode = 1;
        return;
    }

    const text = serialize(identity);
    if (options.out) {
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, text);
        console.log(`written to ${path.relative(REPO_ROOT, options.out)}`);
        return;
    }
    process.stdout.write(text);
}

if (require.main === module) main();

module.exports = { buildIdentity, compare, hashFiles, serialize };
