FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2 AS base
WORKDIR /app
RUN apk add --no-cache libqrencode-tools \
    'ca-certificates>=20261020-r0' 'ca-certificates-bundle>=20261020-r0' && \
    update-ca-certificates
FROM base AS test
COPY package.json yarn.lock tsconfig.json ./
RUN yarn install --frozen-lockfile --non-interactive
COPY src ./src
COPY test ./test
RUN yarn build && yarn test
FROM base
COPY --from=test /app/dist/src ./src
RUN chmod +x /app/src/executables/getWireguardCredentials.js && \
    ln -s /app/src/executables/getWireguardCredentials.js /usr/local/bin/getWireguardCredentials
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||80)+'/-/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "src/index.js"]
