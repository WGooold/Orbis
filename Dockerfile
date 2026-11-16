FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/e2e/package.json ./packages/e2e/
COPY packages/host/package.json ./packages/host/
COPY packages/relay/package.json ./packages/relay/
COPY packages/runtime-bridge/package.json ./packages/runtime-bridge/
COPY packages/remote-interaction-sdk/package.json ./packages/remote-interaction-sdk/
COPY packages/pi-extension/package.json ./packages/pi-extension/
COPY packages/claude-mod/package.json ./packages/claude-mod/
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --ignore-scripts --no-audit --no-fund --registry=$NPM_REGISTRY
COPY tsconfig.json tsconfig.base.json LICENSE THIRD-PARTY-NOTICES.md ./
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/WGooold/Orbis" \
    org.opencontainers.image.title="Orbis Relay"
ARG ORBIS_RELEASE_COMMIT
ENV ORBIS_RELEASE_COMMIT=$ORBIS_RELEASE_COMMIT
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    ORBIS_DEFAULT_STATE_FILE=/data/relay-state.json
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json /app/LICENSE /app/THIRD-PARTY-NOTICES.md ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "packages/relay/dist/main.js"]
