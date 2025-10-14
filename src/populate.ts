import pLimit from 'p-limit';
import pino from 'pino';
import { config } from './config';
import { initSchema, upsertGame, upsertGameWithStatus, getGameCount } from './db';
import { fetchGamesByLetter, fetchGamesByLetterPage } from './rotrends';
import { closeBrowser } from './browser';
import { isParsing } from './parsing-state';

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
    
    try {
      let page = 1;
      let emptyPagesCount = 0;
      const maxEmptyPages = 3; // Максимум 3 пустые страницы подряд
      
      for (;;) {
        // Проверяем флаг отмены перед каждой страницей
        if (!isParsing) {
          console.log('🛑 Парсинг отменен пользователем');
          break;
        }
        
        console.log(`📄 Обрабатываем страницу ${page} для буквы "${letter}"`);
        
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
        
        await Promise.all(
          pageGames.map((g) =>
            limit(async () => {
              // Проверяем флаг отмены перед обработкой каждой игры
              if (!isParsing) {
                return;
              }
              
              try {
                const result = await upsertGameWithStatus({ source_id: g.source_id, title: g.title, url: g.url });
                
                // Правильно считаем новые и обновленные игры
                if (result.isNew) {
                  newGames++;
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
    } catch (e) {
      errors++;
      logger.warn({ letter, err: (e as Error).message }, 'Failed to process letter');
    }
  }
  
  // Получаем реальное количество игр в базе данных
  const realGameCount = await getGameCount();
  
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