/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * Reads one sibling service module's SOURCE TEXT the way the platform lays it out.
 *
 * WHY. A service splits a long module without moving its require path. The
 * entry stays at `<name>.js` and its body moves into parts under a sibling
 * directory `<name>/`; a directory module keeps `<dir>/index.js` and puts its
 * parts beside it. A check that reads the entry alone goes red when the text it
 * wants moved into a part, and goes BLIND when it asserts the text is ABSENT,
 * because what it must not find now sits in a file it never opens.
 *
 * The convention is the platform's, not one repo's: xchain-indexer split this
 * way first and xchain-hub now does too, so anything reading either service's
 * source text reads it through here. Reading a hub entry directly is how the
 * EQUIV gate-input parity suite went red when the hub moved four gate call
 * sites into same-stem part files while every entry path still resolved.
 *
 * WHAT. The entry followed by every `.js` file under its part directory, at any
 * depth, in sorted order. Only a directory spelled exactly as the entry's own
 * name, in the entry's own directory, counts, so a look-alike or a same-named
 * directory elsewhere is never read. On a tree where the module was never split
 * that directory does not exist and the read is the entry alone, unchanged.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Every `.js` file under `dir` at any depth, sorted, without `skip`. */
function jsFilesUnder(dir, skip) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...jsFilesUnder(p, skip));
        else if (e.name.endsWith('.js') && p !== skip) out.push(p);
    }
    return out.sort();
}

/**
 * The entry as the sibling checkout actually spells it.
 *
 * A split leaves `<name>.js` in place while the parts move under `<name>/`, but the
 * split can go one step further and take the entry into the directory as well (the
 * indexer's action handlers and db mixins did, so `actions/slash.js` became
 * `actions/slash/index.js`). A caller naming the flat path then names a file that
 * is not there, so it is followed to `<name>/index.js`. The flat path wins whenever
 * it exists, so nothing changes on a tree that still has it. Neither spelling
 * present is a THROW naming both, never a silent skip: this suite's assertions
 * anchor on real production code, and a sibling that cannot be found must read as
 * a failure to look, not as a passing comparison against nothing.
 *
 * @param {string} entry absolute path of `<name>.js` or `<dir>/index.js`
 * @returns {string} the spelling that exists
 */
function moduleEntry(entry) {
    if (fs.existsSync(entry)) return entry;
    const inDirectory = path.join(entry.replace(/\.js$/, ''), 'index.js');
    if (inDirectory !== entry && fs.existsSync(inDirectory)) return inDirectory;
    throw new Error(`sibling module not found at either spelling: ${entry} or ${inDirectory}`);
}

/**
 * The files one module is made of: the entry first, then its parts.
 *
 * @param {string} entry absolute path of `<name>.js` or `<dir>/index.js`
 * @returns {string[]} the entry, then every part in sorted order
 */
function modulePaths(entryPath) {
    const entry = moduleEntry(entryPath);
    const dir = path.basename(entry) === 'index.js' ? path.dirname(entry) : entry.replace(/\.js$/, '');
    if (dir === entry) return [entry];
    // Exact spelling, checked by listing the parent: a case-insensitive
    // filesystem would otherwise let `Consensus.js` claim a `consensus/` directory.
    const parent = path.dirname(dir);
    const named = fs.existsSync(parent) && fs.readdirSync(parent, { withFileTypes: true })
        .some((e) => e.isDirectory() && e.name === path.basename(dir));
    return named ? [entry, ...jsFilesUnder(dir, entry)] : [entry];
}

/** The module's text, entry then parts, newline-joined. Throws naming both spellings when the entry is at neither. */
function readModuleSource(entry) {
    return modulePaths(entry).map((p) => fs.readFileSync(p, 'utf8')).join('\n');
}

module.exports = { moduleEntry, modulePaths, readModuleSource };
