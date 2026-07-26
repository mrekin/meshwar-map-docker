# node:sqlite ships SQLite compiled into Node, so there are no native addons to
# build: no builder stage, no python3/make/g++, no node-gyp. Pure-JS deps only.
FROM node:24-slim

WORKDIR /app

# Install server dependencies. Cached unless package.json changes.
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

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
# node:sqlite is experimental on Node 24 (no flag needed); silence the one-time
# ExperimentalWarning so it doesn't pollute logs.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
