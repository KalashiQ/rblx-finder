import dotenv from 'dotenv';

dotenv.config();

export const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  CONCURRENCY: parseInt(process.env.CONCURRENCY || '3'),
  DATABASE_PATH: process.env.DATABASE_PATH || './games.db',
  NODE_ENV: process.env.NODE_ENV || 'development',
};
