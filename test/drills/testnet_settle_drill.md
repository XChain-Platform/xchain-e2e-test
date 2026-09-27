# Testnet cross-chain settle drill

## What it proves

This drill performs a live BTC and DOGE testnet cross-chain settle against the
five-validator federation. Its result is the verdict returned by
`runCrossChainSettle`; the run proves the settle only when that verdict reports
`ok: true`.

## Before you run it

Load the treasury credentials into the environment from the operator's
permission-0600 secret store. The treasury comes only from
`TESTNET_TREASURY_WIF` and `TESTNET_TREASURY_ADDRESS`. Never type either value on
a command line, print it, or include it in captured output.

The drill reads the validator and explorer topology itself. Use
`test/drills/crossChainSettleTestnet.drill.js` as the source of truth for that
topology instead of supplying or documenting additional topology keys here.

## Running the live drive

Use Node 22 and run this command from the repository root:

```sh
node test/drills/crossChainSettleTestnet.drill.js
```

Allow hours for testnet inclusion. The process exits 0 only when the verdict's
`ok` field is `true`.

## Reading a failure

Record the complete verdict and the nonzero process exit. `ok: false` says the
settle did not complete. `failedStep` identifies the step that stopped the run,
and each entry in `steps` records its `name`, elapsed `ms`, and summarized
`result`; a failed step includes its error in that result.

Keep that evidence with the run record and investigate the failed step. Do not
retry blindly: a retry can hide whether the original failure came from funding,
testnet inclusion, matching, settlement, or the configured topology.
