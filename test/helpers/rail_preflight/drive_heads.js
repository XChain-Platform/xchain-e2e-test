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

// Judge live heads against the pinned ones. A tree whose head was never captured at drive start
// is a failure (the drive cannot be judged without it); a pinned tree that now reads nothing, or
// reads a different commit, counts as moved.
function judgeDriveHeads(pinned, live){
    const moved = [];
    const missing = [];
    for(const name of HEAD_NAMES){
        const was = pinned && pinned[name];
        if(!was){ missing.push(name); continue; }
        const now = (live && live[name]) || null;
        if(now !== was) moved.push({ name, pinned: was, live: now });
    }
    const problems = missing.map(n => 'the ' + n + ' head was never captured at drive start')
        .concat(moved.map(m => 'the ' + m.name + ' head moved during the drive: pinned at ' +
            m.pinned + ', live now ' + (m.live || 'unreadable')));
    return { ok: moved.length === 0 && missing.length === 0, moved, missing, problems };
}

module.exports = { HEAD_NAMES, driveRoots, gitHead, captureDriveHeads, judgeDriveHeads };
