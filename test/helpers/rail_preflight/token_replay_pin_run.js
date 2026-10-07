'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPLAY_PIN_FILES = [
    'test/unit/chain/genesis_bridge_replay_pin.test.js',
    'test/unit/bridge/issue_bridge_optin.test/policy_guards.test.js',
    'test/unit/bridge/issue_bridge_namespace.test.js'
];

// A pin that was renamed or deleted must fail the run, not shrink it to a smaller green one.
const REQUIRED_CASES = [
    '_injectGasToken synthesizes the pre-refactor transaction byte for byte on BTC',
    'the genesis call site and the bridge call site agree byte for byte on DOGE',
    'the genesis pass reads no database at all, exactly as before the refactor',
    'is case-folded, so a lower-case coin root is refused',
    'refuses it case-folded, so the lower-case spelling cannot take the row'
];

function replayPinMochaPath(indexerRoot){
    return path.join(indexerRoot, 'node_modules', 'mocha', 'bin', 'mocha.js');
}

function replayPinArgs(indexerRoot, reportFile){
    return [replayPinMochaPath(indexerRoot), '--no-config', '--no-package',
        '--require', './test/helpers/setup.js', '--timeout', '30000', '--exit',
        '--reporter', 'json', '--reporter-option', 'output=' + reportFile, ...REPLAY_PIN_FILES];
}

function judgeReplayPinReport(report){
    const problems = [];
    if(!report || !report.stats || !Array.isArray(report.passes)){
        return { ok: false, counts: null, missing: [], problems: ['the replay pin run wrote no mocha report'] };
    }
    const counts = { passing: report.stats.passes, failing: report.stats.failures, pending: report.stats.pending };
    if(counts.failing !== 0){
        const titles = (report.failures || []).map(test => test.fullTitle);
        problems.push('replay pin failures: ' + JSON.stringify(titles));
    }
    if(counts.pending !== 0){
        const titles = (report.pending || []).map(test => test.fullTitle);
        problems.push('replay pin cases skipped, so they compared nothing: ' + JSON.stringify(titles));
    }
    if(!(counts.passing > 0)) problems.push('the replay pin run passed no case');
    const passed = new Set(report.passes.map(test => test.title));
    const missing = REQUIRED_CASES.filter(title => !passed.has(title));
    for(const title of missing) problems.push('the replay pin run never passed "' + title + '"');
    return { ok: problems.length === 0, counts, missing, problems };
}

function runReplayPin(indexerRoot, env, spawn = spawnSync){
    const report = path.join(os.tmpdir(), 'at9-replay-pin-' + process.pid + '-' + Date.now() + '.json');
    const res = spawn(process.execPath, replayPinArgs(indexerRoot, report),
        { cwd: indexerRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let json = null;
    try { json = JSON.parse(fs.readFileSync(report, 'utf8')); } catch(error) { json = null; }
    try { fs.unlinkSync(report); } catch(error) {}
    const out = String(res.stdout || '') + String(res.stderr || '');
    const verdict = judgeReplayPinReport(json);
    if(res.status !== 0) verdict.problems.unshift('the replay pin run exited ' + res.status +
        (res.signal ? ' on signal ' + res.signal : '') + ':\n' + out.split('\n').slice(-60).join('\n'));
    return Object.assign(verdict, { ok: verdict.ok && res.status === 0, exit: res.status,
        files: REPLAY_PIN_FILES, cwd: indexerRoot });
}

module.exports = { REPLAY_PIN_FILES, REQUIRED_CASES, replayPinArgs, judgeReplayPinReport, runReplayPin };
