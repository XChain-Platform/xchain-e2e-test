# Lane report: cx-xc-4755

Row: XC-4755 (split the 146-line describe callback in
test/integration/parity/anchor_bundle_wire_parity.test.js into named registrars,
titles unchanged).

## Files touched

- test/integration/parity/anchor_bundle_wire_parity.test.js

The describe callback now only calls five named registrars, in the original
test order:

- registerHubProducerTests (2 tests)
- registerIndexerReadbackTests (1 test)
- registerSdkReadbackTests (1 test)
- registerParserAgreementTests (2 tests)
- registerSnapshotBlockTests (1 test)

Test bodies are moved verbatim. No assertion, helper or title changed.
File is 273 physical lines (limit 400).

## Checks run in this session

- `node --check test/integration/parity/anchor_bundle_wire_parity.test.js`: pass.
- Function length, measured with acorn over every function node: longest is
  41 lines (registerIndexerReadbackTests), so 0 functions over 60 lines.
- Titles: loaded the old and new file under a stubbed require with
  collecting describe/it globals. Both yield the same 7 full titles in the same
  order; sha256 of the newline-joined titles, first 16 hex chars:
  b790d387ead4d119, which matches the pinned value.

## Not run here (orchestrator should know)

- The mocha run in the Verify command (expected 7 passes, 0 failures) was NOT
  run. The suite requires sibling checkouts at ../ (xchain-documentation,
  xchain-hub, xchain-indexer, xchain-sdk), and this hosted container has only
  xchain-e2e-test. node_modules is also absent.
- claude/bin/check-code-structure.js lives outside this repository, so its
  overLimitFunctions / repo-wide check was not run; the acorn measurement above
  stands in for it.
- The session harness designated branch claude/split-anchor-bundle-parity-n3po6u;
  per the lane contract, only claude/run-f64b46bb8f06 was pushed.

RUN-COMPLETE 60999c0c501437421126c28f584fdeff
