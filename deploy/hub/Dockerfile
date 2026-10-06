# QuickBooks MCP hub (docs/CONNECTOR_DESIGN.md): the always-on server on the
# office Linux box. QuickBooks itself runs on workstations via the connector.
# Build from the repo root:  docker compose -f deploy/hub/docker-compose.yml build
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev
ENTRYPOINT ["node", "/app/dist/index.js"]
