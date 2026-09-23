FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY LICENSE THIRD-PARTY-NOTICES.md ./
COPY packages ./packages
COPY scripts ./scripts
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm ci --ignore-scripts --no-audit --no-fund --registry=$NPM_REGISTRY && npm run build

FROM node:22-bookworm-slim
ARG ORBIS_RELEASE_COMMIT
ENV ORBIS_RELEASE_COMMIT=$ORBIS_RELEASE_COMMIT
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    PI_REMOTE_STATE_FILE=/data/relay-state.json
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json /app/LICENSE /app/THIRD-PARTY-NOTICES.md ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "packages/relay/dist/main.js"]
