# Pin Node 22 (bookworm, not alpine): the platform requires Node 22 exactly.
# node:latest resolves to Node 24+, which can't build isolated-vm, and alpine's
# musl breaks native addon builds. Matches xchain-indexer's base image.
FROM node:22-bookworm

RUN mkdir /XChainE2ETest/
# xchain-hub is staged into the build context by xchain-node's install
# path (LIBRARY_BUNDLES). multiValidatorHubHelper requires its source
# directly; the file: link in package.json pulls in xchain-hub's
# transitive npm deps (express, cors, ws, etc.) into the e2e image.
# Must precede the package.json COPY so npm ci can resolve the
# file:./xchain-hub dep.
COPY ./xchain-hub /XChainE2ETest/xchain-hub
# xchain-sdk is staged the same way (LIBRARY_BUNDLES) so the test:sdk
# suites can resolve it via the file: dep inside the image.
COPY ./xchain-sdk /XChainE2ETest/xchain-sdk
COPY ./package.json /XChainE2ETest/package.json
COPY ./package-lock.json /XChainE2ETest/package-lock.json
WORKDIR /XChainE2ETest
RUN npm ci

COPY ./src /XChainE2ETest/src
COPY ./test /XChainE2ETest/test

# xchain-contracts is staged into the build context by xchain-node's install
# path (LIBRARY_BUNDLES), same as xchain-hub/xchain-sdk above. It is plain
# contract-template source (no npm deps), so it lands after npm ci to avoid
# invalidating the dependency cache layer. The template suites resolve it via
# XCHAIN_CONTRACTS_DIR=/XChainE2ETest/xchain-contracts (set by ConfigService);
# at runtime a missing checkout makes those suites skip rather than abort the run.
COPY ./xchain-contracts /XChainE2ETest/xchain-contracts

# .env is NOT copied into the image to avoid baking credentials into layers.
# Pass credentials via docker run --env-file or environment variables at runtime.

CMD ["npm", "test"]