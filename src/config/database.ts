import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { logger } from "../utils/logger";

// Setup the driver (node-postgres)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Initialize the adapter
const adapter = new PrismaPg(pool);

// Pass the adapter to PrismaClient
export const prisma = new PrismaClient({ adapter });

export const connectDB = async () => {
  try {
    await prisma.$connect();
    logger.info({ pool: 20 }, "PostgreSQL & Prisma connected");
    return prisma;
  } catch (err: any) {
    if (process.env.NODE_ENV === "development") {
      logger.warn(
        { err },
        "PostgreSQL/Prisma connection failed - running in mock mode",
      );
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
