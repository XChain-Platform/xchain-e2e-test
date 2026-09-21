#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Records the set of full Mocha titles collected by each npm test script.
 * Live-rail and non-Mocha scripts stay visible with a not-run reason. Eligible
 * scripts run with their original arguments plus Mocha's JSON reporter.
 *
 * Titles are stored as SHA-256 digests. The invariant is set membership, and
 * digests keep product names in test prose out of the committed public pin.
 * Wall times and result counts are written separately from the stable map.
 *
 * USAGE
 *   node bin/suite-title-map.js
 *   node bin/suite-title-map.js --json
 *   node bin/suite-title-map.js --out <file>
 *   node bin/suite-title-map.js --timings <file>
 *   node bin/suite-title-map.js --script test:unit
 *   node bin/suite-title-map.js --compare <pin> [--rename-map <file>]
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const MOCHA_BIN = process.env.MOCHA_BIN
    ? path.resolve(process.env.MOCHA_BIN)
    : path.join(REPO_ROOT, 'node_modules', '.bin', 'mocha');
const LIVE_RAIL_WITHOUT_INITIAL_CHECK = new Set([
    'test:attest-mirror',
    'test:federation:dex',
    'test:integration',
    'test:integration:live',
    'test:integration:stubbed',
    'test:parity',
]);

function splitCommand(script) {
    const tokens = [];
    let current = '';
    let quote = null;
    let started = false;
    let quoted = false;
    const push = () => {
        tokens.push({ value: current, quoted });
        current = '';
        started = false;
        quoted = false;
    };
    for (const ch of script) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            quoted = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (started || current) push();
            continue;
        }
        current += ch;
        started = true;
    }
    if (started || current) push();
    return tokens;
}

const SHELL_OPERATOR = /^(?:&&|\|\||[|;]|[<>]+)$/;

function mochaArgsFor(script) {
    const tokens = splitCommand(script);
    if (tokens.some((token) => !token.quoted && SHELL_OPERATOR.test(token.value))) {
        return { notRun: 'shell composition is not a single Mocha invocation' };
    }
    const env = {};
    let i = 0;
    while (i < tokens.length && !tokens[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].value)) {
        const equal = tokens[i].value.indexOf('=');
        env[tokens[i].value.slice(0, equal)] = tokens[i].value.slice(equal + 1);
        i += 1;
    }
    if (!tokens[i] || tokens[i].value !== 'mocha') {
        return { notRun: `not a Mocha command (runs ${tokens[i] ? tokens[i].value : 'nothing'})` };
    }
    return { args: tokens.slice(i + 1).map((token) => token.value), env };
}

function notRunReason(name, script) {
    if (script.includes('./test/initialCheck.test.js') || LIVE_RAIL_WITHOUT_INITIAL_CHECK.has(name)) {
        return 'drives a live rail';
    }
    return null;
}

function collect(scriptName, script) {
    const policyReason = notRunReason(scriptName, script);
    if (policyReason) return { notRun: policyReason };
    const parsed = mochaArgsFor(script);
    if (parsed.notRun) return { notRun: parsed.notRun };

    const startedAt = new Date();
    const result = spawnSync(MOCHA_BIN, [...parsed.args, '--reporter', 'json'], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...parsed.env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
    });
    const finishedAt = new Date();
    const timing = {
        command: `npm run ${scriptName}`,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        wallTimeSeconds: Number(((finishedAt - startedAt) / 1000).toFixed(3)),
    };
    if (result.error) return { error: result.error.message, timing };

    let report;
    try {
        const start = result.stdout.indexOf('{\n  "stats"');
        report = JSON.parse(start === -1 ? result.stdout : result.stdout.slice(start));
    } catch (error) {
        return {
            error: `unparseable Mocha JSON (exit ${result.status}): ${result.stderr.slice(0, 400)}`,
            timing,
        };
    }

    const files = {};
    for (const test of report.tests || []) {
        const relative = test.file ? path.relative(REPO_ROOT, test.file) : '(no file)';
        if (!files[relative]) files[relative] = [];
        files[relative].push(test.fullTitle);
    }
    const sorted = {};
    let titleCount = 0;
    for (const relative of Object.keys(files).sort()) {
        sorted[relative] = files[relative].slice().sort();
        titleCount += sorted[relative].length;
    }
    const counts = {
        passCount: (report.passes || []).length,
        pendingCount: (report.pending || []).length,
        failureCount: (report.failures || []).length,
    };
    if (result.status !== 0) {
        return {
            error: `Mocha exited ${result.status} with ${counts.failureCount} failure(s)`,
            fileCount: Object.keys(sorted).length,
            titleCount,
            files: sorted,
            ...counts,
            timing,
        };
    }
    return {
        fileCount: Object.keys(sorted).length,
        titleCount,
        files: sorted,
        ...counts,
        timing,
    };
}

function setKey(titles) {
    return crypto.createHash('sha256').update(titles.join('\n')).digest('hex').slice(0, 16);
}

function buildMap(only) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const names = Object.keys(pkg.scripts || {}).filter((name) => name.startsWith('test')).sort();
    const titleSets = {};
    const scripts = {};
    for (const name of names) {
        if (only && name !== only) continue;
        const result = collect(name, pkg.scripts[name]);
        if (result.files) {
            const files = {};
            for (const relative of Object.keys(result.files)) {
                const key = setKey(result.files[relative]);
                titleSets[key] = result.files[relative];
                files[relative] = key;
            }
            result.files = files;
        }
        scripts[name] = result;
    }
    const sortedSets = {};
    for (const key of Object.keys(titleSets).sort()) sortedSets[key] = titleSets[key];
    return { titleSets: sortedSets, scripts };
}

function titleDigest(title) {
    return crypto.createHash('sha256').update(title).digest('hex');
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePin(pin, expectedScripts) {
    const problems = [];
    if (!isRecord(pin)) return ['top level must be an object'];
    if (pin.titleEncoding !== 'sha256') problems.push('titleEncoding must be sha256');
    if (!isRecord(pin.titleSets) || Object.keys(pin.titleSets).length === 0) {
        problems.push('titleSets must be a nonempty object');
    }
    if (!isRecord(pin.scripts) || Object.keys(pin.scripts).length === 0) {
        problems.push('scripts must be a nonempty object');
    }
    if (problems.length) return problems;

    const referencedSets = new Set();
    for (const [key, titles] of Object.entries(pin.titleSets)) {
        if (!/^[a-f0-9]{16}$/.test(key)) problems.push(`invalid title-set key: ${key}`);
        if (!Array.isArray(titles) || titles.length === 0) {
            problems.push(`title set ${key} must be a nonempty array`);
            continue;
        }
        if (titles.some((title) => typeof title !== 'string' || !/^[a-f0-9]{64}$/.test(title))) {
            problems.push(`title set ${key} contains a non-sha256 title`);
        }
        if (new Set(titles).size !== titles.length) problems.push(`title set ${key} contains duplicates`);
    }

    let runnableScripts = 0;
    for (const [name, entry] of Object.entries(pin.scripts)) {
        if (!isRecord(entry)) {
            problems.push(`${name} must be an object`);
            continue;
        }
        const hasFiles = isRecord(entry.files);
        const hasNotRun = typeof entry.notRun === 'string' && entry.notRun.length > 0;
        if (Number(hasFiles) + Number(hasNotRun) !== 1) {
            problems.push(`${name} must contain exactly one of files or notRun`);
            continue;
        }
        if (hasNotRun) {
            if (Object.keys(entry).length !== 1) problems.push(`${name} has fields beside notRun`);
            continue;
        }

        runnableScripts += 1;
        const fileNames = Object.keys(entry.files);
        let titleCount = 0;
        for (const [relative, key] of Object.entries(entry.files)) {
            if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(pin.titleSets, key)) {
                problems.push(`${name} references missing title set ${String(key)} for ${relative}`);
                continue;
            }
            referencedSets.add(key);
            titleCount += pin.titleSets[key].length;
        }
        if (entry.fileCount !== fileNames.length) problems.push(`${name} fileCount does not match files`);
        if (entry.titleCount !== titleCount) problems.push(`${name} titleCount does not match title sets`);
        const fields = Object.keys(entry).sort().join(',');
        const expectedFields = typeof entry.error === 'string'
            ? 'error,fileCount,files,titleCount'
            : 'fileCount,files,titleCount';
        if (fields !== expectedFields) problems.push(`${name} has unexpected fields`);
    }
    if (runnableScripts === 0) problems.push('scripts has no collected test suite');
    for (const key of Object.keys(pin.titleSets)) {
        if (!referencedSets.has(key)) problems.push(`unreferenced title set: ${key}`);
    }

    if (expectedScripts) {
        const pinnedNames = Object.keys(pin.scripts).sort();
        const expectedNames = expectedScripts.slice().sort();
        if (JSON.stringify(pinnedNames) !== JSON.stringify(expectedNames)) {
            problems.push('scripts do not match package.json test scripts');
        }
    }
    return problems;
}

function withoutMeasurements(map) {
    const scripts = {};
    for (const name of Object.keys(map.scripts)) {
        const {
            timing, passCount, pendingCount, failureCount, ...stable
        } = map.scripts[name];
        scripts[name] = stable;
    }
    return { titleSets: map.titleSets, scripts };
}

function toPin(map) {
    if (map.titleEncoding === 'sha256') return map;
    const titleSets = {};
    for (const key of Object.keys(map.titleSets)) titleSets[key] = map.titleSets[key].map(titleDigest);
    return { titleEncoding: 'sha256', titleSets, scripts: map.scripts };
}

function timingRecord(map) {
    const scripts = {};
    for (const name of Object.keys(map.scripts)) {
        const entry = map.scripts[name];
        scripts[name] = entry.timing ? {
            ...entry.timing,
            files: entry.fileCount,
            titles: entry.titleCount,
            passing: entry.passCount,
            pending: entry.pendingCount,
            failing: entry.failureCount,
        } : { command: `npm run ${name}`, notRun: entry.notRun || entry.error || 'not run' };
    }
    return {
        timingMethod: 'UTC timestamps captured around each Mocha process',
        node: process.version,
        scripts,
    };
}

function expand(map, scriptName) {
    const script = map.scripts[scriptName];
    if (!script || !script.files) return null;
    const expanded = {};
    for (const relative of Object.keys(script.files).sort()) {
        expanded[relative] = map.titleSets[script.files[relative]] || [];
    }
    return expanded;
}

function titleIndex(map, titles) {
    const hashed = map.titleEncoding === 'sha256';
    return new Map(titles.map((title) => [hashed ? title : titleDigest(title), title]));
}

function compare(pin, fresh, renames, only) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const expectedScripts = Object.keys(pkg.scripts || {}).filter((name) => name.startsWith('test'));
    const differences = validatePin(pin, only ? undefined : expectedScripts)
        .map((detail) => ({ script: only || 'pin', kind: 'invalid_pin', detail }));
    if (differences.length) return differences;
    const names = Array.from(new Set(Object.keys(pin.scripts).concat(Object.keys(fresh.scripts))))
        .filter((name) => !only || name === only)
        .sort();
    for (const name of names) {
        const before = expand(pin, name);
        const after = expand(fresh, name);
        if (!before && !after) {
            if (JSON.stringify(pin.scripts[name]) !== JSON.stringify(fresh.scripts[name])) {
                differences.push({ script: name, kind: 'not_run', detail: 'not-run reason changed' });
            }
            continue;
        }
        if (!before || !after) {
            differences.push({ script: name, kind: 'script', detail: before ? 'script removed' : 'script added' });
            continue;
        }
        const mapped = {};
        for (const relative of Object.keys(before)) mapped[renames[relative] || relative] = before[relative];
        const files = Array.from(new Set(Object.keys(mapped).concat(Object.keys(after)))).sort();
        for (const relative of files) {
            if (!mapped[relative]) {
                differences.push({ script: name, kind: 'file_added', file: relative });
                continue;
            }
            if (!after[relative]) {
                differences.push({ script: name, kind: 'file_dropped', file: relative });
                continue;
            }
            const beforeTitles = titleIndex(pin, mapped[relative]);
            const afterTitles = titleIndex(fresh, after[relative]);
            for (const [digest, title] of beforeTitles) {
                if (!afterTitles.has(digest)) differences.push({ script: name, kind: 'title_dropped', file: relative, title });
            }
            for (const [digest, title] of afterTitles) {
                if (!beforeTitles.has(digest)) differences.push({ script: name, kind: 'title_added', file: relative, title });
            }
        }
    }
    return differences;
}

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') options.json = true;
        else if (argv[i] === '--out') { options.out = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--timings') { options.timings = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--script') { options.script = argv[i + 1]; i += 1; }
        else if (argv[i] === '--compare') { options.compare = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--rename-map') { options.renameMap = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--help' || argv[i] === '-h') options.help = true;
        else throw new Error(`unknown argument: ${argv[i]}`);
    }
    return options;
}

function serialize(value) {
    return `${JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }
    const measured = buildMap(options.script);
    const stable = withoutMeasurements(measured);
    const pin = toPin(stable);

    if (options.timings) {
        fs.mkdirSync(path.dirname(options.timings), { recursive: true });
        fs.writeFileSync(options.timings, serialize(timingRecord(measured)));
    }
    if (options.compare) {
        const expected = JSON.parse(fs.readFileSync(options.compare, 'utf8'));
        const renames = options.renameMap ? JSON.parse(fs.readFileSync(options.renameMap, 'utf8')) : {};
        const differences = compare(expected, stable, renames, options.script);
        if (!differences.length) {
            console.log(`suite identity holds against ${path.relative(REPO_ROOT, options.compare)}`);
            return;
        }
        console.log(`${differences.length} difference(s) against ${path.relative(REPO_ROOT, options.compare)}:`);
        for (const difference of differences.slice(0, 200)) {
            console.log(`  [${difference.script}] ${difference.kind} ${difference.file || ''}`
                + `${difference.title ? ` :: ${difference.title}` : ` ${difference.detail || ''}`}`);
        }
        if (differences.length > 200) console.log(`  ... and ${differences.length - 200} more`);
        process.exitCode = 1;
        return;
    }

    if (options.out) {
        fs.mkdirSync(path.dirname(options.out), { recursive: true });
        fs.writeFileSync(options.out, serialize(pin));
    }
    if (options.json) {
        process.stdout.write(serialize(pin));
        return;
    }
    let failed = 0;
    for (const name of Object.keys(measured.scripts)) {
        const result = measured.scripts[name];
        if (result.notRun) {
            console.log(`${name.padEnd(32)} not run: ${result.notRun}`);
            continue;
        }
        if (result.error) {
            console.log(`${name.padEnd(32)} ERROR: ${result.error}`);
            failed += 1;
            continue;
        }
        console.log(`${name.padEnd(32)} ${String(result.fileCount).padStart(4)} files  `
            + `${String(result.titleCount).padStart(5)} titles  ${String(result.passCount).padStart(5)} passing`);
    }
    if (options.out) console.log(`\nwritten to ${path.relative(REPO_ROOT, options.out)}`);
    if (options.timings) console.log(`timings written to ${path.relative(REPO_ROOT, options.timings)}`);
    if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
    buildMap,
    collect,
    compare,
    expand,
    mochaArgsFor,
    notRunReason,
    serialize,
    splitCommand,
    timingRecord,
    toPin,
    validatePin,
    withoutMeasurements,
};
