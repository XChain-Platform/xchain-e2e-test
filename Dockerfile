FROM node:latest

RUN mkdir /XChainE2ETest/
# xchain-hub is staged into the build context by xchain-node's install
# path (LIBRARY_BUNDLES). multiValidatorHubHelper requires its source
# directly; the file: link in package.json pulls in xchain-hub's
# transitive npm deps (express, cors, ws, etc.) into the e2e image.
# Must precede the package.json COPY so npm ci can resolve the
# file:./xchain-hub dep.
COPY ./xchain-hub /XChainE2ETest/xchain-hub
COPY ./package.json /XChainE2ETest/package.json
COPY ./package-lock.json /XChainE2ETest/package-lock.json
WORKDIR /XChainE2ETest
RUN npm ci

COPY ./src /XChainE2ETest/src
COPY ./test /XChainE2ETest/test

# .env is NOT copied into the image to avoid baking credentials into layers.
# Pass credentials via docker run --env-file or environment variables at runtime.

CMD ["npm", "test"]