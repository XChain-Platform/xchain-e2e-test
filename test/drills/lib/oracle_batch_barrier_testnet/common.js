'use strict';

const PRICE_WATERMARK_GRACE_S = 4800;
const POLL_MS = 15_000;
const CATCHUP_LEG_MS = 600_000;
const DEFAULT_MAX_BLOCK_AGE_S = 120;
const DEFAULT_CATCHUP_SLACK_BLOCKS = 2;
const DEFAULT_CATCHUP_TOLERANCE_S = 600;
const DEFAULT_ORIGIN_ACTION_PAGE = 200;
const EXPLORER_COIN = 'TDOGE';
const COIN = 'dogecoin';
const NETWORK = 'testnet';
const SAFE_IDENT = /^[A-Za-z0-9_]+$/;

function ident(name, what) {
    if (!SAFE_IDENT.test(String(name || ''))) {
        throw new Error('oracleBatchBarrierTestnet: refusing to interpolate an unsafe ' + what + ': ' + name);
    }
    return String(name);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function nowS() { return Math.floor(Date.now() / 1000); }
function iso(sec) { return new Date(sec * 1000).toISOString(); }
function num(v) { return v === null || v === undefined ? null : Number(v); }

function finite(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

module.exports = {
    PRICE_WATERMARK_GRACE_S,
    POLL_MS,
    CATCHUP_LEG_MS,
    DEFAULT_MAX_BLOCK_AGE_S,
    DEFAULT_CATCHUP_SLACK_BLOCKS,
    DEFAULT_CATCHUP_TOLERANCE_S,
    DEFAULT_ORIGIN_ACTION_PAGE,
    EXPLORER_COIN,
    COIN,
    NETWORK,
    ident,
    sleep,
    nowS,
    iso,
    num,
    finite
};
