# Dockerfile for YouTube Analytics MCP Server
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine AS runtime

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files
COPY --from=build /app/build ./build

ENV NODE_ENV=production

# MCP runs via stdio by default
CMD ["node", "./build/index.js"]
