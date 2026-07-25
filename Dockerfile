# ---- Builder: compile native modules (better-sqlite3) ----
FROM node:22-slim AS builder

# python3/make/g++ are required by node-gyp for --build-from-source.
# They stay here and do NOT reach the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server dependencies (ignore host lock file, build native modules fresh)
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev --build-from-source

# ---- Runtime: lean image, no build toolchain ----
FROM node:22-slim

WORKDIR /app

# Native modules compiled above (same base image => ABI-compatible)
COPY --from=builder /app/server/node_modules ./server/node_modules

# Copy application
COPY server/ ./server/
COPY public/ ./public/
# Tools baked to a non-shadowed path; entrypoint seeds them into /app/tools.
COPY tools/ /app/tools-image/
# Config template; the app seeds it into /app/config at startup if missing.
COPY config_examples/ /app/config_examples/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create data directory
RUN mkdir -p /app/data/processed

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
