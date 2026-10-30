FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94

# io.modelcontextprotocol.server.name is how the MCP registry proves this image
# belongs to the server named in server.json; it must match that name exactly.
LABEL io.modelcontextprotocol.server.name="com.growwer/growwer" \
      org.opencontainers.image.title="Growwer MCP bridge" \
      org.opencontainers.image.description="Stdio bridge to the hosted Growwer MCP server." \
      org.opencontainers.image.source="https://github.com/viralitymedia/growwer-mcp" \
      org.opencontainers.image.url="https://growwer.com/mcp/" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# catalog.json is read at runtime by the keyless setup server, exactly like package.json is read
# for the version: omit it and `docker run` without a credential crashes on startup.
COPY package.json catalog.json ./

USER node

# stdio transport: the container must be run with -i and without -t.
ENTRYPOINT ["node", "dist/cli.js"]
