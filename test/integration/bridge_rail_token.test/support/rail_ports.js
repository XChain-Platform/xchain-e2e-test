'use strict';

const net = require('net');

// A rebuilt regtest stack publishes the DOGE indexer on 3124 where the chainRail default
// (and a stack built before) uses 3004. An explicit DOGE_INDEXER_API_PORT always wins; with
// none set, the port that accepts a connection is the one the rail is built on, so a dead
// default no longer reads as a stalled miner.
const DOGE_INDEXER_CANDIDATE_PORTS = [3004, 3124];

/**
 * Choose the indexer port a rail should dial.
 *
 * @param {object} opts
 * @param {(string|number|undefined)} opts.configured the operator's explicit port, if any
 * @param {Array<number>} opts.candidates ports to try, in order
 * @param {function(number): Promise<boolean>} opts.accepts whether a port takes a connection
 * @returns {Promise<{port: (number|null), source: string}>}
 */
async function resolveIndexerPort(opts) {
    if (opts.configured) return { port: Number(opts.configured), source: 'env' };
    for (const port of opts.candidates) {
        if (await opts.accepts(port)) return { port, source: 'probe' };
    }
    return { port: null, source: 'none' };
}

function tcpAccepts(host, timeoutMs) {
    return (port) => new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

module.exports = { DOGE_INDEXER_CANDIDATE_PORTS, resolveIndexerPort, tcpAccepts };
