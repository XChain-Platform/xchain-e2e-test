# Lane report: cx-xc-4755

Row: XC-4755 (split the 146-line describe callback in
test/integration/parity/anchor_bundle_wire_parity.test.js into named registrars, titles unchanged).

## Files touched

- test/integration/parity/anchor_bundle_wire_parity.test.js

The describe callback now calls five top-level registrars, in the original test order:
registerHubProducerTests (2 tests), registerIndexerReadbackTest (1), registerSdkReadbackTest (1),
registerCrossParserTests (2), registerSnapshotBlockTest (1). Test bodies, comments and titles are
moved verbatim with their indentation unchanged.

## Checks run in this lane

- `node --check test/integration/parity/anchor_bundle_wire_parity.test.js`: pass.
- Physical lines: 273 (limit 400).
- Function lengths (awk over top-level functions): hubBuild 4, indexerParse 28,
  registerHubProducerTests 18, registerIndexerReadbackTest 41, registerSdkReadbackTest 29,
  registerCrossParserTests 36, registerSnapshotBlockTest 25; describe callback 7. None over 60.
- Static title hash (describe title + " " + it title, joined by newline, sha256 first 16 hex):
  7 titles, b790d387ead4d119, identical before and after, matching the pinned value.

## Not run here (orchestrator should run the Verify command)

- The mocha run (pinned 7 passes, 0 failures) was NOT executed: this hosted container holds only
  xchain-e2e-test, and the suite requires sibling checkouts at ../ (xchain-documentation,
  xchain-hub, xchain-indexer, xchain-sdk). node_modules is also absent.
- claude/bin/check-code-structure.js lives outside this repository and was not available, so the
  overLimitFunctions count and the repo-wide structure check were not run with the real tool.
- eslint was not run (no node_modules).

RUN-COMPLETE 457a61f2617110df3e524e9f8fcf5c46
