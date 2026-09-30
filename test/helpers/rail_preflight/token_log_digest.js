'use strict';

const fs = require('fs');
const path = require('path');

const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const SPAWN_LINE = /^=== \S+ spawn \S+ pid \d+ ===$/;
const FINALIZED_LINE = /CrossChainBridge: finalized transfer [0-9a-fA-F]{16}\.\.\. ([^:\s]+):(\d+) -> (\S+) (\S+) (\S+) \((\d+) sigs\)/;
const ROUND_FAILED_LINE = /CrossChainBridge: transfer round failed for ([^:\s]+):(\d+):/;
const HELD_LINE = /CrossChainBridge: not proposing ([^:\s]+):(\d+) \((.*)\)\s*$/;
const ADOPTED_LINE = /CrossChainDexConsensus: adopted leader canonical for ([0-9a-fA-F]{16})\.\.\./;
const STALE_ROUND_LINE = /CrossChainDexConsensus: abandoned stale round ([0-9a-fA-F]{16})\.\.\. after (\d+)s unfinalized; engine will re-propose/;

function increment(map, key){
    map[key] = (map[key] || 0) + 1;
}

function parseFinalized(line, tick){
    const match = line.match(FINALIZED_LINE);
    if(!match) return null;
    const transfer = {
        src: match[1],
        index: Number(match[2]),
        dest: match[3],
        amount: match[4],
        tick: match[5],
        sigs: Number(match[6])
    };
    if(tick !== undefined && transfer.tick !== String(tick)) return null;
    return transfer;
}

function digestTokenLog(text, opts = {}){
    opts = opts || {};
    const result = {
        spawns: 0,
        finalized: [],
        finalizedSinceLastSpawn: [],
        writeFailed: 0,
        roundFailed: {},
        held: {},
        retractionErrors: 0,
        adopted: {},
        staleRounds: {}
    };

    for(const line of String(text).replace(ANSI_ESCAPE, '').split(/\r?\n/)){
        if(SPAWN_LINE.test(line)){
            result.spawns++;
            result.finalizedSinceLastSpawn = [];
            continue;
        }
        const transfer = parseFinalized(line, opts.tick);
        if(transfer){
            result.finalized.push(transfer);
            result.finalizedSinceLastSpawn.push(transfer);
        }
        if(line.includes('CrossChainBridge: finalized transfer write FAILED (fail-closed;') ||
            line.includes('CrossChainBridge: write finalized transfer error:')) result.writeFailed++;
        const roundFailed = line.match(ROUND_FAILED_LINE);
        if(roundFailed) increment(result.roundFailed, roundFailed[1] + ':' + roundFailed[2]);
        const held = line.match(HELD_LINE);
        if(held){
            const leg = held[1] + ':' + held[2];
            if(!result.held[leg]) result.held[leg] = {};
            increment(result.held[leg], held[3]);
        }
        if(line.includes('CrossChainBridge: retraction submit error:')) result.retractionErrors++;
        const adopted = line.match(ADOPTED_LINE);
        if(adopted) increment(result.adopted, adopted[1]);
        const staleRound = line.match(STALE_ROUND_LINE);
        if(staleRound){
            const round = staleRound[1];
            const ageS = Number(staleRound[2]);
            if(!result.staleRounds[round]) result.staleRounds[round] = { count: 0, maxAgeS: 0 };
            result.staleRounds[round].count++;
            result.staleRounds[round].maxAgeS = Math.max(result.staleRounds[round].maxAgeS, ageS);
        }
    }
    return result;
}

function parseCliArgs(args){
    if(args.length < 1 || args[0].startsWith('-')) return null;
    const parsed = { directory: args[0], tick: undefined };
    for(let i = 1; i < args.length; i++){
        if(args[i] !== '--tick' || parsed.tick !== undefined ||
            i + 1 >= args.length || args[i + 1].startsWith('--')) return null;
        parsed.tick = args[++i];
    }
    return parsed;
}

function listOrNone(values){
    return values.length ? values.join(',') : 'none';
}

function formatTransfer(transfer){
    return transfer.src + ':' + transfer.index + '/' + transfer.dest + ':' + transfer.tick;
}

function formatDigest(file, digest){
    const finalized = digest.finalized.map(formatTransfer);
    const sinceSpawn = digest.finalizedSinceLastSpawn.map(formatTransfer);
    const roundFailed = Object.values(digest.roundFailed).reduce((sum, count) => sum + count, 0);
    const adopted = Object.values(digest.adopted).reduce((sum, count) => sum + count, 0);
    const staleRounds = Object.values(digest.staleRounds).reduce((sum, round) => sum + round.count, 0);
    return 'LOG ' + file +
        ' spawns=' + digest.spawns +
        ' finalized=' + listOrNone(finalized) +
        ' since_spawn=' + listOrNone(sinceSpawn) +
        ' write_failed=' + digest.writeFailed +
        ' round_failed=' + roundFailed +
        ' held=' + listOrNone(Object.keys(digest.held)) +
        ' retraction_errors=' + digest.retractionErrors +
        ' adopted=' + adopted +
        ' stale_rounds=' + staleRounds;
}

function runCli(args){
    const parsed = parseCliArgs(args);
    if(!parsed){
        process.stderr.write('usage: token_log_digest.js <journal-dir> [--tick <TICK>]\n');
        return 2;
    }
    try {
        const entries = fs.readdirSync(parsed.directory, { withFileTypes: true });
        const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.log'))
            .map(entry => entry.name).sort();
        for(const file of files){
            const text = fs.readFileSync(path.join(parsed.directory, file), 'utf8');
            const digest = digestTokenLog(text, { tick: parsed.tick });
            process.stdout.write(formatDigest(file, digest) + '\n');
        }
        return 0;
    } catch(error) {
        process.stderr.write('unable to read journal directory\n');
        return 2;
    }
}

module.exports = { digestTokenLog };

if(require.main === module) process.exitCode = runCli(process.argv.slice(2));
