import dotenv from 'dotenv';

dotenv.config();

// Парсим ALLOWED_USER_IDS с более детальной обработкой
const parseAllowedUserIds = (): number[] => {
  const rawIds = process.env.ALLOWED_USER_IDS;
  if (!rawIds || rawIds.trim() === '') {
    console.log('🔓 ALLOWED_USER_IDS не задан - доступ открыт для всех пользователей');
    return [];
  }
  
  try {
    const ids = rawIds.split(',').map(id => {
      const trimmed = id.trim();
      const parsed = parseInt(trimmed);
      if (isNaN(parsed)) {
        console.warn(`⚠️ Некорректный ID пользователя: "${trimmed}"`);
        return null;
      }
      return parsed;
    }).filter(id => id !== null) as number[];
    
    console.log(`🔒 ALLOWED_USER_IDS загружен: [${ids.join(', ')}]`);
    return ids;
  } catch (error) {
    console.error('❌ Ошибка парсинга ALLOWED_USER_IDS:', error);
    return [];
  }
};

export const config = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  CONCURRENCY: parseInt(process.env.CONCURRENCY || '3'),
  DATABASE_PATH: process.env.DATABASE_PATH || './games.db',
  NODE_ENV: process.env.NODE_ENV || 'development',
  ALLOWED_USER_IDS: parseAllowedUserIds(),
};
