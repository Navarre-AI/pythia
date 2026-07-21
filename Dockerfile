FROM node:20-slim
WORKDIR /app

# DuckDB CLI (the cube engine). linux-amd64 binary; Fly runs x86_64.
# 1.2+ required for -safe mode (blocks filesystem/env access on the query path).
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && curl -L -o /tmp/duckdb.zip "https://github.com/duckdb/duckdb/releases/download/v1.5.3/duckdb_cli-linux-${ARCH}.zip" \
 && unzip /tmp/duckdb.zip -d /usr/local/bin \
 && chmod +x /usr/local/bin/duckdb \
 && rm /tmp/duckdb.zip \
 && apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
