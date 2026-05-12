# Dockerfile for Spotify MCP Server
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
# Skip prepare script during install (it needs source files)
RUN npm ci --ignore-scripts

COPY . .
# Now run build after source files are available
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

COPY package*.json ./
# --ignore-scripts skips the 'prepare' script which tries to run tsc (not available in prod deps)
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/build ./build

ENV NODE_ENV=production

# MCP runs via stdio by default
CMD ["node", "./build/index.js"]
