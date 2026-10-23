FROM node:24.22.1-alpine3.23@sha256:0468540aa58203ff9e40c2aab3907c52644ab818af6176b1c70a026137dc92a2 AS base
RUN apk add --no-cache \
    'ca-certificates>=20261020-r0' \
    'ca-certificates-bundle>=20261020-r0' && \
    update-ca-certificates

FROM base AS builder
WORKDIR /app
COPY . .
RUN yarn --frozen-lockfile
RUN yarn build && yarn test

RUN rm -rf node_modules && yarn --production --frozen-lockfile


# Our Second stage, that creates an image for production
FROM base
WORKDIR /app

COPY --from=builder /app/dist/ ./
COPY --from=builder /app/node_modules/ ./node_modules

# Prepare external executables
RUN chmod +x /app/src/executables/getWireguardCredentials.js && \
    ln -s /app/src/executables/getWireguardCredentials.js /usr/local/bin/getWireguardCredentials

ENTRYPOINT [ "node", "src/index" ]
