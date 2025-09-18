FROM node:latest

RUN mkdir /XChainE2ETest/
COPY ./package.json /XChainE2ETest/package.json
WORKDIR /XChainE2ETest
RUN npm install

COPY ./src /XChainE2ETest/src
COPY ./test /XChainE2ETest/test
COPY ./.en[v] /XChainE2ETest/.env

CMD ["npm", "test"]