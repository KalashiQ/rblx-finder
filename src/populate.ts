import pLimit from 'p-limit';
import pino from 'pino';
import { config } from './config';
import { initSchema, upsertGame, upsertGameWithStatus, getGameCount } from './db';
import { fetchGamesByLetter, fetchGamesByLetterPage } from './rotrends';
import { closeBrowser } from './browser';
import { isParsing } from './parsing-state';
import TelegramBot from 'node-telegram-bot-api';

const logger = pino({ 
  level: 'warn',
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

// Переменные для отслеживания прогресса
let progressCallback: ((progress: ProgressInfo) => void) | null = null;

export interface ProgressInfo {
  currentLetter: string;
  letterIndex: number;
  totalLetters: number;
  currentPage: number;
  totalGames: number;
  newGames: number;
  updatedGames: number;
  errors: number;
  isComplete: boolean;
}

export function setProgressCallback(callback: (progress: ProgressInfo) => void) {
  progressCallback = callback;
}

function updateProgress(progress: ProgressInfo) {
  if (progressCallback) {
    progressCallback(progress);
  }
}

export async function populateByLetters(): Promise<void> {
  const limit = pLimit(config.CONCURRENCY);
  for (const letter of LETTERS) {
    try {
      // Первая страница
      let page = 1;
      let emptyPagesCount = 0;
      const maxEmptyPages = 3; // Максимум 3 пустые страницы подряд
      
      for (;;) {
        logger.info({ letter, page }, '📄 Processing page for letter');
        const pageGames = page === 1 ? await fetchGamesByLetter(letter) : await fetchGamesByLetterPage(letter, page, 100); // Увеличиваем размер страницы
        logger.info({ letter, page, count: pageGames.length }, '✅ Fetched games by letter/page');
        
        if (!pageGames.length) {
          emptyPagesCount++;
          logger.warn({ letter, page, emptyPagesCount, maxEmptyPages }, '⚠️ Empty page detected');
          
          if (emptyPagesCount >= maxEmptyPages) {
            logger.info({ letter }, '🛑 Stopping pagination after empty pages');
            break;
          }
          
          page++;
          continue;
        }
        
        // Сбрасываем счетчик пустых страниц при успешном парсинге
        emptyPagesCount = 0;
        await Promise.all(
          pageGames.map((g) =>
            limit(async () => {
              const gameId = await upsertGame({ source_id: g.source_id, title: g.title, url: g.url });
              logger.debug({ gameId, source_id: g.source_id }, 'Upserted game');
            })
          )
        );
        page += 1;
      }
    } catch (e) {
      logger.warn({ letter, err: (e as Error).message }, 'Failed to process letter');
    }
  }
}

export async function populate(): Promise<void> {
  initSchema();
  await populateByLetters();
}

export async function parseNewGames(): Promise<{
  totalGames: number;
  newGames: number;
  updatedGames: number;
  errors: number;
  realGameCount: number;
}> {
  initSchema();
  
  let totalGames = 0;
  let newGames = 0;
  let updatedGames = 0;
  let errors = 0;
  
  const limit = pLimit(config.CONCURRENCY);
  
  // Парсинг по буквам
  for (let i = 0; i < LETTERS.length; i++) {
    const letter = LETTERS[i];
    
    // Проверяем флаг отмены перед каждой буквой
    if (!isParsing) {
      console.log('🛑 Парсинг отменен пользователем');
      break;
    }
    
    console.log(`📝 Обрабатываем букву "${letter}" (${i + 1}/${LETTERS.length})`);
    
    // Отправляем обновление прогресса
    updateProgress({
      currentLetter: letter,
      letterIndex: i + 1,
      totalLetters: LETTERS.length,
      currentPage: 1,
      totalGames,
      newGames,
      updatedGames,
      errors,
      isComplete: false
    });
    
    try {
      let page = 1;
      let emptyPagesCount = 0;
      const maxEmptyPages = 3; // Максимум 3 пустые страницы подряд
      const processedPages = new Set<number>(); // Отслеживаем обработанные страницы
      
      for (;;) {
        // Проверяем флаг отмены перед каждой страницей
        if (!isParsing) {
          console.log('🛑 Парсинг отменен пользователем');
          break;
        }
        
        // Проверяем, не обрабатывали ли мы уже эту страницу
        if (processedPages.has(page)) {
          console.log(`⚠️ Страница ${page} для буквы "${letter}" уже обработана, пропускаем`);
          page++;
          continue;
        }
        
        console.log(`📄 Обрабатываем страницу ${page} для буквы "${letter}"`);
        
        // Отмечаем страницу как обработанную
        processedPages.add(page);
        
        // Обновляем прогресс с текущей страницей
        updateProgress({
          currentLetter: letter,
          letterIndex: i + 1,
          totalLetters: LETTERS.length,
          currentPage: page,
          totalGames,
          newGames,
          updatedGames,
          errors,
          isComplete: false
        });
        
        let pageGames: any[] = [];
        try {
          pageGames = page === 1 ? await fetchGamesByLetter(letter, 100) : await fetchGamesByLetterPage(letter, page, 100);
          console.log(`✅ Страница ${page} для буквы "${letter}": найдено ${pageGames.length} игр`);
        } catch (error) {
          console.error(`❌ Ошибка парсинга страницы ${page} для буквы "${letter}":`, (error as Error).message);
          // Продолжаем с пустым массивом
          pageGames = [];
        }
        
        if (!pageGames.length) {
          emptyPagesCount++;
          console.log(`⚠️ Пустая страница ${page} для буквы "${letter}" (${emptyPagesCount}/${maxEmptyPages})`);
          
          if (emptyPagesCount >= maxEmptyPages) {
            console.log(`🛑 Останавливаем пагинацию для буквы "${letter}" после ${maxEmptyPages} пустых страниц`);
            break;
          }
          
          page++;
          continue;
        }
        
        // Сбрасываем счетчик пустых страниц при успешном парсинге
        emptyPagesCount = 0;
        
        totalGames += pageGames.length;
        
        const processedGames = await Promise.all(
          pageGames.map((g) =>
            limit(async () => {
              // Проверяем флаг отмены перед обработкой каждой игры
              if (!isParsing) {
                return null;
              }
              
              try {
                const result = await upsertGameWithStatus({ source_id: g.source_id, title: g.title, url: g.url });
                
                // Правильно считаем новые и обновленные игры
                if (result.isNew) {
                  newGames++;
                } else {
                  updatedGames++;
                }
                return result;
              } catch (e) {
                errors++;
                logger.warn({ source_id: g.source_id, err: (e as Error).message }, 'Failed to process game');
                return null;
              }
            })
          )
        );
        
        // Подсчитываем успешно обработанные игры
        const successfulGames = processedGames.filter(g => g !== null).length;
        const failedGames = pageGames.length - successfulGames;
        
        console.log(`📊 Страница ${page} для буквы "${letter}": ${pageGames.length} найдено, ${successfulGames} записано, ${failedGames} ошибок`);
        
        if (failedGames > 0) {
          console.log(`⚠️ Ошибки на странице ${page}: ${failedGames} игр не записались`);
        }
        
        // Обновляем прогресс после обработки игр
        updateProgress({
          currentLetter: letter,
          letterIndex: i + 1,
          totalLetters: LETTERS.length,
          currentPage: page,
          totalGames,
          newGames,
          updatedGames,
          errors,
          isComplete: false
        });
        
        page += 1;
      }
    } catch (e) {
      errors++;
      logger.warn({ letter, err: (e as Error).message }, 'Failed to process letter');
    }
  }
  
  // Получаем реальное количество игр в базе данных
  const realGameCount = await getGameCount();
  
  // Финальное обновление прогресса
  updateProgress({
    currentLetter: '',
    letterIndex: LETTERS.length,
    totalLetters: LETTERS.length,
    currentPage: 0,
    totalGames,
    newGames,
    updatedGames,
    errors,
    isComplete: true
  });
  
  console.log(`✅ Парсинг завершен! Обработано: ${totalGames}, новых: ${newGames}, обновлено: ${updatedGames}, ошибок: ${errors}`);
  
  return {
    totalGames,
    newGames,
    updatedGames,
    errors,
    realGameCount
  };
}

if (require.main === module) {
  populate()
    .then(() => {
      logger.info('Populate completed');
      return closeBrowser();
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}