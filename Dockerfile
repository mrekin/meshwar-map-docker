FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ bash jq \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server dependencies (ignore host lock file, build native modules fresh)
COPY server/package.json ./server/
RUN cd server && npm install --production --build-from-source

# Copy application
COPY server/ ./server/
COPY public/ ./public/
COPY tools/ ./tools/

# Create data directory
RUN mkdir -p /app/data/processed

EXPOSE 3000

CMD ["node", "server/index.js"]
