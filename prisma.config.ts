import { defineConfig } from '@prisma/config';
import * as dotenv from 'dotenv';
import path from 'path';

// Manually point to the .env file in your root directory
dotenv.config({ path: path.join(__dirname, '.env') });

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL,
  },
});