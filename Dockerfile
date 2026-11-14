FROM docker.io/library/node:20-slim

WORKDIR /app

# Install build tools for better-sqlite3
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    build-essential node-gyp pkg-config python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Environment
ENV PORT=8080 \
    NODE_ENV=production \
    DATABASE_PATH=/data/chess.db

EXPOSE 8080

CMD ["node", "server.js"]