import pLimit from 'p-limit';
import pino from 'pino';
import { config } from './config';
import { upsertGameWithStatus, getGameCount } from './db';
import { fetchGamesByLetter, fetchGamesByLetterPage } from './rotrends';
import { closeBrowser } from './browser';
import TelegramBot from 'node-telegram-bot-api';

const logger = pino({ 
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// Только кириллический алфавит для парсинга русских игр
const LETTERS = [
  'а','б','в','г','д','е','ж','з','и','й','к','л','м','н','о','п','р','с','т','у','ф','х','ц','ч','ш','щ','ъ','ы','ь','э','ю','я'
];

// Состояние непрерывного поиска
let isContinuousSearchRunning = false;
let continuousSearchInterval: NodeJS.Timeout | null = null;
let nextCycleTimeout: NodeJS.Timeout | null = null; // Таймер для следующего цикла
let botInstance: TelegramBot | null = null;
let allChatIds: Set<number> = new Set(); // Все чаты, которые когда-либо писали боту
let isStarting = false; // Флаг для предотвращения множественных запусков

export function setBotInstance(bot: TelegramBot) {
  botInstance = bot;
}

export function addChatId(chatId: number) {
  allChatIds.add(chatId);
}

export function isContinuousSearchActive(): boolean {
  return isContinuousSearchRunning;
}

export function startContinuousSearch(): void {
  if (isContinuousSearchRunning || isStarting) {
    logger.warn('Continuous search is already running or starting');
    return;
  }

  isStarting = true;
  isContinuousSearchRunning = true;
  logger.info('🚀 Starting continuous search with 5-minute intervals');
  logger.info('📋 Search pattern: А → Б → В → ... → Я → (wait 5 min) → А → Б → В → ...');
  
  // Запускаем первый поиск сразу
  performContinuousSearchWithDelay();
  
  isStarting = false;
}

export function stopContinuousSearch(): void {
  if (!isContinuousSearchRunning) {
    logger.warn('Continuous search is not running');
    return;
  }

  isContinuousSearchRunning = false;
  
  // Очищаем все таймеры
  if (continuousSearchInterval) {
    clearInterval(continuousSearchInterval);
    continuousSearchInterval = null;
  }
  
  if (nextCycleTimeout) {
    clearTimeout(nextCycleTimeout);
    nextCycleTimeout = null;
  }
  
  logger.info('⏹️ Continuous search stopped');
}

async function performContinuousSearchWithDelay(): Promise<void> {
  if (!isContinuousSearchRunning) {
    logger.info('🛑 Continuous search was stopped, skipping cycle');
    return;
  }

  // Выполняем поиск
  await performContinuousSearch();
  
  // Дополнительная проверка после выполнения поиска
  if (!isContinuousSearchRunning) {
    logger.info('🛑 Continuous search was stopped after cycle completion');
    return;
  }
  
  // Если поиск все еще активен, планируем следующий цикл через 5 минут
  logger.info('⏰ Planning next cycle in 5 minutes...');
  nextCycleTimeout = setTimeout(() => {
    if (isContinuousSearchRunning) {
      performContinuousSearchWithDelay();
    } else {
      logger.info('🛑 Continuous search was stopped, canceling next cycle');
    }
  }, 5 * 60 * 1000); // 5 минут
}

async function performContinuousSearch(): Promise<void> {
  if (!isContinuousSearchRunning) {
    return;
  }

  logger.info('🔄 Starting continuous search cycle - processing all letters from А to Я');
  
  let totalGames = 0;
  let newGames = 0;
  let updatedGames = 0;
  let errors = 0;
  const newGamesList: Array<{title: string, url: string}> = [];
  
  const limit = pLimit(config.CONCURRENCY);
  
  try {
    // Парсинг по буквам последовательно от А до Я
    for (let i = 0; i < LETTERS.length; i++) {
      const letter = LETTERS[i];
      
      // Проверяем, не остановлен ли поиск
      if (!isContinuousSearchRunning) {
        logger.info('Continuous search was stopped during execution');
        break;
      }
      
      logger.info(`📝 Processing letter "${letter}" (${i + 1}/${LETTERS.length})`);
      
      try {
        let page = 1;
        let letterGames = 0;
        let letterNewGames = 0;
        
        let emptyPagesCount = 0;
        const maxEmptyPages = 3; // Максимум 3 пустые страницы подряд
        
        for (;;) {
          // Проверяем, не остановлен ли поиск
          if (!isContinuousSearchRunning) {
            logger.info('Continuous search was stopped during execution');
            break;
          }
          
          logger.info(`📄 Processing page ${page} for letter "${letter}"`);
          
          let pageGames: any[] = [];
          try {
            pageGames = page === 1 ? await fetchGamesByLetter(letter, 100) : await fetchGamesByLetterPage(letter, page, 100);
            logger.info({ letter, page, count: pageGames.length }, '✅ Page parsed successfully');
          } catch (error) {
            logger.error({ letter, page, error: (error as Error).message }, '❌ Page parsing failed');
            // Продолжаем с пустым массивом, чтобы не прерывать весь процесс
            pageGames = [];
          }
          
          if (!pageGames.length) {
            emptyPagesCount++;
            logger.warn(`⚠️ Empty page ${page} for letter "${letter}" (${emptyPagesCount}/${maxEmptyPages})`);
            
            if (emptyPagesCount >= maxEmptyPages) {
              logger.info(`🛑 Stopping pagination for letter "${letter}" after ${maxEmptyPages} empty pages`);
              break;
            }
            
            page++;
            continue;
          }
          
          // Сбрасываем счетчик пустых страниц при успешном парсинге
          emptyPagesCount = 0;
          
          letterGames += pageGames.length;
          totalGames += pageGames.length;
          
          // Добавляем небольшую задержку между страницами, чтобы не перегружать сайт
          if (page > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
          await Promise.all(
            pageGames.map((g) =>
              limit(async () => {
                // Проверяем, не остановлен ли поиск
                if (!isContinuousSearchRunning) {
                  return;
                }
                
                try {
                  const result = await upsertGameWithStatus({ source_id: g.source_id, title: g.title, url: g.url });
                  
                  if (result.isNew) {
                    newGames++;
                    letterNewGames++;
                    newGamesList.push({ title: g.title, url: g.url });
                    logger.info(`🎮 New game found: ${g.title} (${g.url})`);
                    
                    // Отправляем уведомление сразу же
                    await sendSingleGameNotification({ title: g.title, url: g.url });
                  } else {
                    updatedGames++;
                  }
                } catch (e) {
                  errors++;
                  logger.warn({ source_id: g.source_id, err: (e as Error).message }, 'Failed to process game');
                }
              })
            )
          );
          page += 1;
        }
        
        logger.info(`✅ Letter "${letter}" completed: ${letterGames} games processed, ${letterNewGames} new games found, ${page - 1} pages processed`);
        
      } catch (e) {
        errors++;
        logger.warn({ letter, err: (e as Error).message }, 'Failed to process letter');
      }
    }
    
    // Уведомления уже отправлены по одной игре
    
    logger.info(`🎯 Continuous search cycle completed! Total: ${totalGames}, New: ${newGames}, Updated: ${updatedGames}, Errors: ${errors}`);
    
  } catch (error) {
    logger.error({ error }, 'Error during continuous search');
  }
}

async function sendSingleGameNotification(game: {title: string, url: string}): Promise<void> {
  if (!botInstance) {
    return;
  }

  // Экранируем специальные символы для Markdown
  const escapeMarkdown = (text: string): string => {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  };

  const message = `🎮 Найдена новая игра!\n\n[${escapeMarkdown(game.title)}](${game.url})`;

  // Отправляем уведомления всем чатам, которые когда-либо писали боту
  for (const chatId of allChatIds) {
    try {
      await botInstance.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: false 
      });
    } catch (error) {
      // Если Markdown не работает, отправляем без форматирования
      try {
        const plainMessage = `🎮 Найдена новая игра!\n\n${game.title}\n${game.url}`;
        
        await botInstance.sendMessage(chatId, plainMessage, { 
          disable_web_page_preview: false 
        });
      } catch (fallbackError) {
        logger.error({ error: fallbackError, chatId }, 'Failed to send single game notification even with fallback');
      }
    }
  }
}

async function sendNewGamesNotifications(newGames: Array<{title: string, url: string}>): Promise<void> {
  if (!botInstance || newGames.length === 0) {
    return;
  }

  // Экранируем специальные символы для Markdown
  const escapeMarkdown = (text: string): string => {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  };

  const message = `🎮 Найдены новые игры!\n\n${newGames.map((game, index) => 
    `${index + 1}. [${escapeMarkdown(game.title)}](${game.url})`
  ).join('\n')}`;

  // Отправляем уведомления всем чатам, которые когда-либо писали боту
  for (const chatId of allChatIds) {
    try {
      await botInstance.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: false 
      });
    } catch (error) {
      // Если Markdown не работает, отправляем без форматирования
      try {
        const plainMessage = `🎮 Найдены новые игры!\n\n${newGames.map((game, index) => 
          `${index + 1}. ${game.title}\n${game.url}`
        ).join('\n\n')}`;
        
        await botInstance.sendMessage(chatId, plainMessage, { 
          disable_web_page_preview: false 
        });
      } catch (fallbackError) {
        logger.error({ error: fallbackError, chatId }, 'Failed to send notification even with fallback');
      }
    }
  }
}

// Graceful shutdown
export function cleanup(): void {
  stopContinuousSearch();
}
