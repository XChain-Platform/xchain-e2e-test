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
 **********************************************************************/

'use strict';

// Single source of truth for what counts as a leaked developer-machine path.
//
// Two consumers read this file and they MUST agree, or the scrub silently
// half-works: scan-history.js (the detector, which decides whether the repo is
// clean) and the filter-repo-*.txt spec files (the rewriter, which decides what
// actually gets replaced). A pattern that only the detector knows about reports
// a leak the rewrite never fixes; a pattern only the rewriter knows about
// mangles content nothing was watching. history-path-leak.test.js asserts the
// two stay in sync, so the .txt files are generated artifacts in spirit: edit
// here, then re-run `node scripts/history-scrub/leak-patterns.js --emit` and
// commit the regenerated spec files.
//
// The patterns are deliberately USERNAME-FREE. This repo is public at flip, so
// a spec file spelling out the operator's home directory would re-leak in the
// very commit that scrubs the leak. Matching the SHAPE of a developer path
// rather than one literal instance also means the detector keeps working after
// the machine, the user, or the mount point changes.

// Path-segment charset. Excludes quotes, angle brackets, brackets, parens,
// whitespace and backslash so a match stops at the end of the path rather than
// swallowing the rest of a line of HTML or JSON.
const SEG = '[A-Za-z0-9_.@%+-]+';

// A trailing run of "/segment". Written without a capture group so the emitted
// Python regex and the JS regex behave identically under alternation.
const TAIL = `(?:/${SEG})*`;

// Right-hand boundary for a fixed prefix: the prefix must not be the head of a
// longer word, so the Parallels share matches with and without a sub-path, but
// a longer mount name that merely starts the same way does not.
const WORDEND = '(?![A-Za-z0-9_-])';

// The Parallels host share, written so that this file does not contain the
// string it matches. `[f]` is a one-character class: it matches exactly `f`, so
// the pattern behaves identically, while the source text reads "/media/ps[f]"
// and therefore does not match itself.
//
// Not a stylistic tic. A leak detector has to name what it hunts, and the
// obvious spelling makes this file, and the .txt specs generated from it, blobs
// that the detector reports as leaks the moment they are committed. That breaks
// two things at once: the standing "no new leaks" gate goes permanently red,
// and --replace-text rewrites the spec files' own contents during the very run
// that uses them, so the scrubbed history carries a pattern spec with its
// patterns redacted out. Sidestepping the self-match removes both, and it is
// the reason no comment in this directory spells the share out either.
const PSF_SHARE = '/media/ps[f]';

// Left-hand boundary. Without it every pattern also fires on the path component
// of a URL: an https://host.example/home/<page> link contains a home-shaped
// substring, and the rewriter would replace it, corrupting a link to prove a
// point.
//
// Blocking a preceding word character, dot or hyphen kills the URL case (the
// slash there follows a hostname character) and the relative-path case
// (../home/<x>), while a leading `:` is deliberately NOT blocked, because
// host:/home/<user> is an rsync or scp target and is a real leak.
const LEFT = '(?<![A-Za-z0-9_.-])';

// A username segment: at least one char, and it may not start with a dot (so
// /home/.cache-style shared paths are not read as a user directory).
const USER = '[A-Za-z0-9_][A-Za-z0-9_.-]*';

const PATTERNS = [
    {
        id: 'parallels-share',
        // The Parallels host share on the Ubuntu runtime VM. The bare mount
        // point leaks the Mac-plus-VM topology on its own, so it is matched
        // with or without a sub-path.
        source: `${LEFT}${PSF_SHARE}${WORDEND}${TAIL}`
    },
    {
        id: 'linux-home',
        source: `${LEFT}/home/${USER}${TAIL}`
    },
    {
        id: 'macos-home',
        source: `${LEFT}/Users/${USER}${TAIL}`
    }
];

// What a matched path becomes after the rewrite. Every leak this repo carries
// sits in a comment or in generated report text, so a single opaque token is
// enough: nothing in history needs to stay runnable after replacement, and a
// token that is obviously a redaction beats a plausible-looking fake path that
// a later reader might try to use.
const REPLACEMENT = 'REDACTED-LOCAL-PATH';

/** Fresh RegExp objects. New each call: /g regexes carry lastIndex state. */
function regexes(flags = 'g') {
    return PATTERNS.map((p) => ({ id: p.id, re: new RegExp(p.source, flags) }));
}

/**
 * Every leak match in a string, as {id, text, index}.
 * Callers pass blob content decoded as latin1 so byte offsets stay meaningful
 * and invalid UTF-8 in a binary blob cannot throw.
 */
function findMatches(text) {
    const out = [];
    for (const { id, re } of regexes('g')) {
        let m;
        while ((m = re.exec(text)) !== null) {
            out.push({ id, text: m[0], index: m.index });
            // A zero-length match would spin forever. None of the patterns can
            // produce one today, but the guard costs nothing and the failure
            // mode is a hung CI job rather than a visible error.
            if (m[0].length === 0) re.lastIndex++;
        }
    }
    return out.sort((a, b) => a.index - b.index);
}

/** True if the string carries at least one leak. Cheaper than findMatches. */
function hasLeak(text) {
    return regexes('').some(({ re }) => re.test(text));
}

/**
 * The `--replace-text` / `--replace-message` spec body for git-filter-repo.
 * filter-repo reads one expression per line as `regex:<pattern>==>replacement`
 * and applies them in order. The patterns share no `==>` sequence, so no
 * escaping is needed.
 */
function emitFilterRepoSpec(header) {
    const lines = header.map((h) => `# ${h}`);
    lines.push('');
    for (const p of PATTERNS) {
        lines.push(`# ${p.id}`);
        lines.push(`regex:${p.source}==>${REPLACEMENT}`);
    }
    return lines.join('\n') + '\n';
}

/** The regex lines of a spec file, ignoring comments and blanks. */
function parseFilterRepoSpec(body) {
    return body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
}

// The two generated spec files, keyed by filename, with the header each one
// carries. Kept here rather than in the emitter CLI so the sync test can assert
// against exactly what `--emit` would write.
const SPEC_FILES = {
    'filter-repo-replace-text.txt': [
        'GENERATED by scripts/history-scrub/leak-patterns.js --emit. Do not hand-edit.',
        'Passed to git-filter-repo as --replace-text: rewrites BLOB CONTENT across',
        'all refs. See scripts/history-scrub/rewrite-history.sh.'
    ],
    'filter-repo-replace-message.txt': [
        'GENERATED by scripts/history-scrub/leak-patterns.js --emit. Do not hand-edit.',
        'Passed to git-filter-repo as --replace-message: rewrites COMMIT AND TAG',
        'MESSAGES across all refs. Same patterns as the blob spec, because a path',
        'leaked in a commit message is exactly as public as one leaked in a file.'
    ]
};

module.exports = {
    PATTERNS,
    REPLACEMENT,
    SPEC_FILES,
    regexes,
    findMatches,
    hasLeak,
    emitFilterRepoSpec,
    parseFilterRepoSpec
};

if (require.main === module) {
    if (process.argv[2] !== '--emit') {
        process.stderr.write('usage: node leak-patterns.js --emit\n');
        process.exit(2);
    }
    const fs   = require('fs');
    const path = require('path');
    for (const [name, header] of Object.entries(SPEC_FILES)) {
        const dest = path.join(__dirname, name);
        fs.writeFileSync(dest, emitFilterRepoSpec(header));
        process.stdout.write(`wrote ${dest}\n`);
    }
}
