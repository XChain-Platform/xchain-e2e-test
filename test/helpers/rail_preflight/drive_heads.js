'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const HEAD_NAMES = ['platform', 'e2e', 'indexer'];

// Roots of the three trees a drive is judged against. The indexer sits under the platform root.
function driveRoots(e2eRoot, platformRoot){
    return {
        platform: platformRoot,
        e2e: e2eRoot,
        indexer: path.join(platformRoot, 'xchain-indexer')
    };
}

function gitHead(dir, spawn = spawnSync){
    const res = spawn('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    const head = res && res.status === 0 ? String(res.stdout || '').trim() : '';
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

// Read every head once. `readHead(dir)` returns a commit id or null.
function captureDriveHeads(roots, readHead = gitHead){
    const heads = {};
    for(const name of HEAD_NAMES) heads[name] = readHead(roots[name]) || null;
    return heads;
}

// Platform paths that hold only build records: the uppercase ledger and board files at the top of
// claude/, the specs and reports under it, and tmp/. A platform commit touching nothing else does not
// change any code a drive runs, so the drive's record still describes the tree that ran.
const LEDGER_PATTERNS = [
    /^claude\/[A-Z][A-Z0-9_-]*\.md$/,
    /^claude\/specs\//,
    /^claude\/reports\//,
    /^tmp\//
];

function isLedgerPath(file){
    const p = String(file || '');
    return LEDGER_PATTERNS.some(re => re.test(p));
}

// Paths changed between two commits of one tree, or null when git cannot say.
function changedPaths(dir, from, to, spawn = spawnSync){
    const res = spawn('git', ['-C', dir, 'diff', '--name-only', from, to], { encoding: 'utf8' });
    if(!res || res.status !== 0) return null;
    return String(res.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
}

// A diffPaths(name, from, to) reader over the drive's own roots.
function rootDiff(roots, spawn = spawnSync){
    return (name, from, to) => (roots && roots[name] ? changedPaths(roots[name], from, to, spawn) : null);
}

// Judge live heads against the pinned ones. A tree whose head was never captured at drive start
// is a failure (the drive cannot be judged without it); a pinned tree that now reads nothing, or
// reads a different commit, counts as moved. The one exception is a platform head that advanced over
// commits touching only ledger paths: when `diffPaths(name, from, to)` lists the changed paths and
// every one is a ledger path, the move is listed under ledgerOnly instead of moved.
function judgeDriveHeads(pinned, live, diffPaths){
    const moved = [];
    const missing = [];
    const ledgerOnly = [];
    for(const name of HEAD_NAMES){
        const was = pinned && pinned[name];
        if(!was){ missing.push(name); continue; }
        const now = (live && live[name]) || null;
        if(now === was) continue;
        const files = name === 'platform' && now && diffPaths ? diffPaths(name, was, now) : null;
        if(Array.isArray(files) && files.length > 0 && files.every(isLedgerPath)){
            ledgerOnly.push({ name, pinned: was, live: now, files: files.length });
            continue;
        }
        moved.push({ name, pinned: was, live: now });
    }
    const problems = missing.map(n => 'the ' + n + ' head was never captured at drive start')
        .concat(moved.map(m => 'the ' + m.name + ' head moved during the drive: pinned at ' +
            m.pinned + ', live now ' + (m.live || 'unreadable')));
    return { ok: moved.length === 0 && missing.length === 0, moved, missing, problems, ledgerOnly };
}

module.exports = {
    HEAD_NAMES, driveRoots, gitHead, captureDriveHeads, isLedgerPath, changedPaths, rootDiff, judgeDriveHeads
};
