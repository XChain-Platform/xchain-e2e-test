# Lane report: cx-xc-4772

## Files touched

- None in this round. The split already landed in the base commit
  d9ee754 ("Split check_request_row_wait describe callbacks into named
  registrars"), which touches only
  test/unit/scripts/check_request_row_wait.test.js.
- RESULT.md (this report, its own commit).

## Checks run on the base commit

- node --check test/unit/scripts/check_request_row_wait.test.js: ok
- npx mocha --no-config --timeout 30000 --exit --reporter json
  test/unit/scripts/check_request_row_wait.test.js: 14 passes, 0 failures,
  titles-sha256 69fc3ae41be2390f (matches pinned 14 0 69fc3ae41be2390f)
- Longest function in the file, measured with acorn: 42 lines (limit 60).
  Physical lines: 228 (limit 400).
- claude/bin/check-code-structure.js is not present in this hosted
  checkout, so the structure checker itself was not run here.

## Why attempt 2 failed (reason is outside the surface)

The failing step was `git diff --exit-code HEAD`, and the diff it printed
is in package-lock.json, not in the test file. The added lines
("@modelcontextprotocol/sdk": "^1.31.0", "supertest": "^7.3.1") belong to
the "xchain-sdk" entry of the lockfile. package.json pulls that package in
as "file:./xchain-sdk", a sibling snapshot, and the committed lockfile
still records "@modelcontextprotocol/sdk": "^1.29.0" and no supertest. So
an npm install in the orchestrator worktree, against a newer xchain-sdk
snapshot, rewrote package-lock.json. That is lockfile drift from a
re-staged sibling snapshot, unrelated to this row.

Fixing it needs a package-lock.json refresh (or re-staging the sdk
snapshot to match the lock), which is outside the writable surface, so no
edit was made. Suggested follow-up: a separate row that regenerates
package-lock.json with npm after the current xchain-sdk snapshot, or run
the verify in a worktree where npm install has not been run, or restore
package-lock.json (git checkout -- package-lock.json) before verify.

## Branch note

The session's designated push branch is claude/run-847904044c4d-3ml1cj;
the result was pushed there, built directly on base commit d9ee754.

RUN-COMPLETE 8a497eb05fc6cb8fb93142e9406be51b
