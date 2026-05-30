# The build runs Node with an 8 GB heap; give Docker ≥9 GB RAM
# or it GC-thrashes and appears to hang at compile-src.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential g++ python-is-python3 git ca-certificates \
        libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

ENTRYPOINT ["node", "build-scripts/vscode/build-vscode.mjs"]
