FROM node:latest

RUN mkdir /XChainE2ETest/
COPY ./package.json /XChainE2ETest/package.json
WORKDIR /XChainE2ETest
RUN npm install

COPY ./src /XChainE2ETest/src
COPY ./test /XChainE2ETest/test

# .env is NOT copied into the image to avoid baking credentials into layers.
# Pass credentials via docker run --env-file or environment variables at runtime.

CMD ["npm", "test"]