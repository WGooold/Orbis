ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/review-demo /app/scripts/review-demo
USER node
ENV HOME=/data/home
WORKDIR /data/workspace
CMD ["node", "/app/scripts/review-demo/host.mjs"]
