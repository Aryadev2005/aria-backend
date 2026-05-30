import { defineConfig } from "@prisma/config";
import * as dotenv from "dotenv";

dotenv.config();

// For migrations, always use the direct URL (not pgbouncer)
const migrationUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

export default defineConfig({
  datasource: {
    url: migrationUrl,
  },
});
