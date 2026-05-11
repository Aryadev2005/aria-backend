# Dockerfile for Spotify MCP Server
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

ENV NODE_ENV=production

# MCP runs via stdio by default
CMD ["node", "./build/index.js"]
