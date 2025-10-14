import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { initSchema, getGameCount, getGames, searchGames } from './db';
import { parseNewGames } from './populate';
import { initBrowser, closeBrowser } from './browser';
import { isParsing, setParsingState, resetParsingState } from './parsing-state';
import pino from 'pino';

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

// Проверяем наличие токена бота
if (!config.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не найден в переменных окружения!');
  console.log('Создайте файл .env и добавьте ваш токен бота');
  process.exit(1);
}

// Создаем экземпляр бота
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

// Инициализируем базу данных
initSchema();

console.log('🤖 Telegram бот запущен!');

// Создаем клавиатуру с кнопками
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [
        { text: '🎮 Парсинг новых игр' },
        { text: '📊 Статистика базы' }
      ],
      [
        { text: '🔍 Поиск игр' },
        { text: '📋 Список игр' }
      ],
      [
        { text: '❓ Помощь' }
      ]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

// Обработчик команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'Пользователь';
  
  bot.sendMessage(chatId, `Привет, ${firstName}! 👋\n\nЯ бот для парсинга игр с rotrends.com!\n\nВыберите действие:`, mainKeyboard);
});

// Обработчик команды /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, `📋 Справка по командам:\n\n/start - начать работу с ботом\n/help - показать эту справку\n\nИспользуйте кнопки для навигации по функциям бота.`, mainKeyboard);
});

// Обработчик команды /ping
bot.onText(/\/ping/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, '🏓 Pong! Бот работает нормально!');
});

// Обработчик кнопок
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Игнорируем команды (они обрабатываются выше)
  if (text && text.startsWith('/')) {
    return;
  }
  
  if (!text) return;
  
  try {
    switch (text) {
      case '🎮 Парсинг новых игр':
        await handleParseGames(chatId);
        break;
        
      case '📊 Статистика базы':
        await handleStats(chatId);
        break;
        
      case '🔍 Поиск игр':
        await handleSearch(chatId);
        break;
        
      case '📋 Список игр':
        await handleListGames(chatId);
        break;
        
      case '❓ Помощь':
        await handleHelp(chatId);
        break;
        
      case '❌ Отменить парсинг':
        await handleCancelParsing(chatId);
        break;
        
      default:
        // Если это не команда и не кнопка, возможно это поисковый запрос
        if (text.length > 2) {
          await handleSearchQuery(chatId, text);
        } else {
          bot.sendMessage(chatId, 'Используйте кнопки для навигации или введите поисковый запрос.', mainKeyboard);
        }
    }
  } catch (error) {
    logger.error({ error, chatId }, 'Error handling message');
    bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте позже.');
  }
});

// Обработчик callback кнопок (inline кнопки)
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message?.chat.id;
  const messageId = callbackQuery.message?.message_id;
  const data = callbackQuery.data;
  
  if (!chatId || !data) return;
  
  try {
    if (data === 'cancel_parsing') {
      if (isParsing) {
        console.log('🛑 Парсинг отменен пользователем');
        // Устанавливаем флаг отмены
        resetParsingState();
        
        // Обновляем сообщение
        await bot.editMessageText('❌ Парсинг отменен пользователем.', {
          chat_id: chatId,
          message_id: messageId
        });
        
        // Закрываем браузер
        await closeBrowser();
        
        // Отправляем основную клавиатуру
        await bot.sendMessage(chatId, 'Парсинг отменен. Выберите другое действие:', mainKeyboard);
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Парсинг не выполняется' });
      }
    }
    
    // Подтверждаем получение callback
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (error) {
    logger.error({ error, chatId, data }, 'Error handling callback query');
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Произошла ошибка' });
  }
});

// Функция парсинга игр
async function handleParseGames(chatId: number) {
  try {
    // Проверяем, не идет ли уже парсинг
    if (isParsing) {
      await bot.sendMessage(chatId, '⏳ Парсинг уже выполняется. Дождитесь завершения.', mainKeyboard);
      return;
    }
    
    // Устанавливаем флаг парсинга
    setParsingState(true, chatId);
    
    // Создаем клавиатуру с кнопкой отмены
    const cancelKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Отменить парсинг', callback_data: 'cancel_parsing' }]
        ]
      }
    };
    
    const parsingMessage = await bot.sendMessage(chatId, '🚀 Начинаю парсинг игр с rotrends.com...\nЭто может занять несколько минут.', cancelKeyboard);
    setParsingState(true, chatId, parsingMessage.message_id);
    
    console.log('🚀 Парсинг запущен');
    
    // Инициализируем браузер
    await initBrowser();
    
    const result = await parseNewGames();
    
    // Сбрасываем флаги
    resetParsingState();
    
    const message = `✅ Парсинг завершен!\n\n📊 Результаты:\n• Всего обработано: ${result.totalGames}\n• Новых игр: ${result.newGames}\n• Обновлено: ${result.updatedGames}\n• Ошибок: ${result.errors}\n• Всего в базе: ${result.realGameCount}`;
    
    await bot.sendMessage(chatId, message, mainKeyboard);
    
    // Закрываем браузер
    await closeBrowser();
  } catch (error) {
    logger.error({ error, chatId }, 'Error parsing games');
    
    // Сбрасываем флаги при ошибке
    resetParsingState();
    
    await bot.sendMessage(chatId, '❌ Ошибка при парсинге игр. Попробуйте позже.', mainKeyboard);
    await closeBrowser();
  }
}

// Функция показа статистики
async function handleStats(chatId: number) {
  try {
    const totalGames = await getGameCount();
    const message = `📊 Статистика базы данных:\n\n🎮 Всего игр: ${totalGames}`;
    await bot.sendMessage(chatId, message, mainKeyboard);
  } catch (error) {
    logger.error({ error, chatId }, 'Error getting stats');
    await bot.sendMessage(chatId, '❌ Ошибка при получении статистики.', mainKeyboard);
  }
}

// Функция поиска игр
async function handleSearch(chatId: number) {
  await bot.sendMessage(chatId, '🔍 Введите название игры для поиска:', {
    reply_markup: {
      remove_keyboard: true
    }
  });
}

// Функция обработки поискового запроса
async function handleSearchQuery(chatId: number, query: string) {
  try {
    const games = await searchGames(query, 10);
    
    if (games.length === 0) {
      await bot.sendMessage(chatId, `❌ Игры по запросу "${query}" не найдены.`, mainKeyboard);
      return;
    }
    
    let message = `🔍 Найдено игр: ${games.length}\n\n`;
    games.forEach((game, index) => {
      message += `${index + 1}. ${game.title}\n`;
    });
    
    if (games.length >= 10) {
      message += '\n... и другие игры';
    }
    
    await bot.sendMessage(chatId, message, mainKeyboard);
  } catch (error) {
    logger.error({ error, chatId, query }, 'Error searching games');
    await bot.sendMessage(chatId, '❌ Ошибка при поиске игр.', mainKeyboard);
  }
}

// Функция показа списка игр
async function handleListGames(chatId: number) {
  try {
    const games = await getGames(10);
    
    if (games.length === 0) {
      await bot.sendMessage(chatId, '📋 База данных пуста. Запустите парсинг игр.', mainKeyboard);
      return;
    }
    
    let message = `📋 Последние игры (${games.length}):\n\n`;
    games.forEach((game, index) => {
      message += `${index + 1}. ${game.title}\n`;
    });
    
    await bot.sendMessage(chatId, message, mainKeyboard);
  } catch (error) {
    logger.error({ error, chatId }, 'Error listing games');
    await bot.sendMessage(chatId, '❌ Ошибка при получении списка игр.', mainKeyboard);
  }
}

// Функция помощи
async function handleHelp(chatId: number) {
  const message = `❓ Помощь по боту:\n\n🎮 Парсинг новых игр - запускает парсинг всех игр с rotrends.com\n📊 Статистика базы - показывает количество игр в базе\n🔍 Поиск игр - позволяет найти игры по названию\n📋 Список игр - показывает последние добавленные игры\n\nДля поиска просто введите название игры в чат.`;
  
  await bot.sendMessage(chatId, message, mainKeyboard);
}

// Функция отмены парсинга
async function handleCancelParsing(chatId: number) {
  if (isParsing) {
    console.log('🛑 Парсинг отменен через кнопку');
    resetParsingState();
    await closeBrowser();
    await bot.sendMessage(chatId, '❌ Парсинг отменен. Выберите другое действие:', mainKeyboard);
  } else {
    await bot.sendMessage(chatId, '⏳ Парсинг не выполняется.', mainKeyboard);
  }
}

// Обработка ошибок
bot.on('error', (error) => {
  console.error('❌ Ошибка бота:', error);
});

bot.on('polling_error', (error) => {
  console.error('❌ Ошибка polling:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Остановка бота...');
  bot.stopPolling();
  
  // Сбрасываем флаги парсинга
  resetParsingState();
  
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Остановка бота...');
  bot.stopPolling();
  
  // Сбрасываем флаги парсинга
  resetParsingState();
  
  await closeBrowser();
  process.exit(0);
});
