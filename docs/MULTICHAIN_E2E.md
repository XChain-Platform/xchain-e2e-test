# Multi-chain e2e (BTC / LTC / DOGE)

The full e2e suite is chain-parameterized and runs **one chain per process**. The platform
historically validated only bitcoin end-to-end; this doc covers running the same suite against
litecoin and dogecoin so per-chain behavior is exercised (fee-payment mode, capability-staking
being BTC-only, and chain-specific node quirks).

## How chain selection works

`test/initialCheck.test.js` resolves the target chain from the environment:

- `COIN` + `NETWORK` set explicitly (e.g. `COIN=litecoin NETWORK=regtest`), **or**
- `NETWORK` in `<coin>-<network>` form (e.g. `NETWORK=litecoin-regtest`) - when `COIN` is unset,
  it is split into `COIN` + `NETWORK`.

`xchain-node` provisions each stack with `NETWORK=<coin>-regtest` (see
`xchain-node/config/<coin>-regtest`) and leaves `COIN` unset, so the split path drives the suite.
`global.NETWORK_OBJECT` then comes from `CryptoNetworks.getBitcoinJsNetwork(COIN+"-"+NETWORK)`.

> Do **not** also inject `COIN` from xchain-node - with `COIN` set, the split is skipped and
> `NETWORK` stays in `<coin>-regtest` form, producing an invalid `getBitcoinJsNetwork()` lookup.

The per-coin regtest node configs already carry the needed tuning:
`xchain-node/crypto_nodes/dogecoin/dogecoin-regtest.conf` (mempool: `minrelaytxfee`,
`limitfreerelay`, `acceptnonstdtxn` - dogecoind v1.14 priority workaround) and
`crypto_nodes/litecoin/litecoin-regtest.conf` (MWEB BIP9 disabled).

## Running

Per chain (stack must be installed/running for that coin first):

```bash
xchain-node e2etest bitcoin
xchain-node e2etest litecoin
xchain-node e2etest dogecoin
```

All three with an aggregated pass/fail summary:

```bash
xchain-node/scripts/run-multichain-e2e.sh                # all three
xchain-node/scripts/run-multichain-e2e.sh litecoin dogecoin
```

Per-coin logs: `xchain-node/data/e2e-logs/<coin>-regtest-<timestamp>.log`.

### Exit code

`xchain-node e2etest` prints `E2E tests finished with exit code N` and the CLI process exits with
that same code (`src/cli.js` e2etest action calls `return process.exit(exitCode)`). CI and the
runner script can gate on `$?` natively; scraping the printed line is no longer necessary.

## CI matrix

Run one job per coin (they are independent full-stack runs; do not share a stack):

```yaml
# illustrative - no CI is wired in-repo yet
strategy:
  matrix:
    coin: [bitcoin, litecoin, dogecoin]
steps:
  - run: xchain-node install master node ${{ matrix.coin }} regtest   # bring up the stack
  - run: xchain-node e2etest ${{ matrix.coin }}
  # e2etest propagates the suite's real exit code, so a nonzero run fails the step via $?
```

## Prerequisites (local regtest)

- Start `xchain-node-database` before the first install.
- Use a native ext4 data dir via `XCHAIN_NODE_DATA_DIR` - the Parallels share is not safe for
  bitcoind/litecoind/dogecoind data files.
- `install` before `e2etest`; `docker rm -f` before reinstalling; remove stale `modules/<repo>`
  clones to refresh local source.
