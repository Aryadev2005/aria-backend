# Multi-stage build for ARIA Backend (Node.js + TypeScript + Fastify)
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++ postgresql-client

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including dev)
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source code (excluding .env via .dockerignore)
COPY . .

# Note: .env file is NOT copied - env vars are passed via docker-compose at runtime
# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install runtime dependencies
RUN apk add --no-cache postgresql-client curl

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Install tsx for ES module runtime support
RUN npm install tsx

# Generate Prisma client for production
RUN npx prisma generate

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy Prisma 7 config (needed by migrate deploy and prisma generate at runtime)
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

# Copy essential scripts
COPY --from=builder /app/scripts ./scripts

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set proper ownership
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Run migrations then start the application
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx dist/server.js"]
