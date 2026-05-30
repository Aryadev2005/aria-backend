import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { logger } from "../utils/logger";

// Setup the driver (node-postgres)
// Use DIRECT_URL for dev/migrations (not pgbouncer), DATABASE_URL for production
const connectionString = process.env.NODE_ENV === 'production' 
  ? process.env.DATABASE_URL 
  : (process.env.DIRECT_URL || process.env.DATABASE_URL);

const pool = new Pool({
  connectionString,
  max:                    parseInt(process.env.DB_POOL_MAX     || "10",    10),
  min:                    parseInt(process.env.DB_POOL_MIN     || "2",     10),
  idleTimeoutMillis:      parseInt(process.env.DB_IDLE_TIMEOUT || "30000", 10),
  connectionTimeoutMillis:parseInt(process.env.DB_CONN_TIMEOUT || "5000",  10),
});

// Initialize the adapter
const adapter = new PrismaPg(pool);

// Pass the adapter to PrismaClient
export const prisma = new PrismaClient({ adapter });

export const connectDB = async () => {
  try {
    await prisma.$connect();
    logger.info(
      { pool: { max: pool.options.max ?? 10, min: pool.options.min ?? 2 } },
      "PostgreSQL & Prisma connected",
    );
    return prisma;
  } catch (err: any) {
    // DB_MOCK=true enables a mock mode for local dev without a real database.
    // NODE_ENV alone is not a reliable gate — it hides real connection failures.
    if (process.env.DB_MOCK === "true") {
      logger.warn({ err }, "DB_MOCK=true — skipping database connection");
      return null;
    }
    logger.error({ err }, "Database connection failed");
    throw err;
  }
};

export const disconnectDB = async () => {
  await prisma.$disconnect();
  await pool.end();
};
