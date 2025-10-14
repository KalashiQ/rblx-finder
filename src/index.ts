import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { initSchema, getGameCount, getGames, searchGames } from './db';
import { parseNewGames } from './populate';
import { initBrowser, closeBrowser } from './browser';
import { isParsing, setParsingState, resetParsingState } from './parsing-state';
import { 
  setBotInstance, 
  addChatId, 
  isContinuousSearchActive, 
  startContinuousSearch, 
  stopContinuousSearch,
  cleanup as cleanupContinuousSearch 
} from './continuous-search';
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

// Инициализируем бота для модуля непрерывного поиска
setBotInstance(bot);

console.log('🤖 Telegram бот запущен!');
console.log('💡 Если видите ошибку 409 Conflict, остановите другие экземпляры бота');

// Создаем клавиатуру с кнопками
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [
        { text: '🎮 Парсинг новых игр' },
        { text: '📊 Статистика базы' }
      ],
      [
        { text: '🔄 Непрерывный поиск' }
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
  
  // Добавляем chatId для автоматических уведомлений
  addChatId(chatId);
  
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
        
      case '❓ Помощь':
        await handleHelp(chatId);
        break;
        
      case '🔄 Непрерывный поиск':
        await handleStartContinuousSearch(chatId);
        break;
        
      case '❌ Отменить парсинг':
        await handleCancelParsing(chatId);
        break;
        
      default:
        // Если это не команда и не кнопка
        bot.sendMessage(chatId, 'Используйте кнопки для навигации.', mainKeyboard);
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
    } else if (data === 'stop_continuous_search') {
      if (isContinuousSearchActive()) {
        stopContinuousSearch();
        
        // Обновляем сообщение
        await bot.editMessageText('⏹️ Непрерывный поиск остановлен!', {
          chat_id: chatId,
          message_id: messageId
        });
        
        // Отправляем основную клавиатуру
        await bot.sendMessage(chatId, 'Поиск остановлен. Выберите другое действие:', mainKeyboard);
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Непрерывный поиск не выполняется' });
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


// Функция помощи
async function handleHelp(chatId: number) {
  const message = `❓ Помощь по боту:\n\n🎮 Парсинг новых игр - запускает парсинг всех игр с rotrends.com\n📊 Статистика базы - показывает количество игр в базе\n🔄 Непрерывный поиск - запускает автоматический поиск новых игр каждые 5 минут\n\n🔔 Уведомления о новых играх приходят автоматически всем пользователям!\n\n⏹️ Для остановки непрерывного поиска используйте кнопку в сообщении о запуске.`;
  
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

// Функция запуска непрерывного поиска
async function handleStartContinuousSearch(chatId: number) {
  try {
    if (isContinuousSearchActive()) {
      await bot.sendMessage(chatId, '🔄 Непрерывный поиск уже запущен!', mainKeyboard);
      return;
    }
    
    // Дополнительная проверка с небольшой задержкой
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (isContinuousSearchActive()) {
      await bot.sendMessage(chatId, '🔄 Непрерывный поиск уже запущен!', mainKeyboard);
      return;
    }
    
    startContinuousSearch();
    
    // Создаем inline клавиатуру с кнопкой остановки
    const stopKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⏹️ Остановить поиск', callback_data: 'stop_continuous_search' }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, '🚀 Непрерывный поиск запущен! Бот будет искать новые игры каждые 5 минут и отправлять уведомления.', stopKeyboard);
  } catch (error) {
    logger.error({ error, chatId }, 'Error starting continuous search');
    await bot.sendMessage(chatId, '❌ Ошибка при запуске непрерывного поиска.', mainKeyboard);
  }
}

// Функция остановки непрерывного поиска
async function handleStopContinuousSearch(chatId: number) {
  try {
    if (!isContinuousSearchActive()) {
      await bot.sendMessage(chatId, '⏹️ Непрерывный поиск не запущен!', mainKeyboard);
      return;
    }
    
    stopContinuousSearch();
    await bot.sendMessage(chatId, '⏹️ Непрерывный поиск остановлен!', mainKeyboard);
  } catch (error) {
    logger.error({ error, chatId }, 'Error stopping continuous search');
    await bot.sendMessage(chatId, '❌ Ошибка при остановке непрерывного поиска.', mainKeyboard);
  }
}


// Обработка ошибок
bot.on('error', (error) => {
  console.error('❌ Ошибка бота:', error);
});

bot.on('polling_error', (error: any) => {
  if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
    console.error('❌ Конфликт: уже запущен другой экземпляр бота!');
    console.error('💡 Решение: остановите другие экземпляры бота или подождите 10 секунд');
    console.error('🔄 Попытка переподключения через 10 секунд...');
    
    // Останавливаем текущий polling
    bot.stopPolling();
    
    // Переподключаемся через 10 секунд
    setTimeout(() => {
      console.log('🔄 Переподключение к Telegram API...');
      bot.startPolling();
    }, 10000);
  } else if (error.code === 'EFATAL' || error.message?.includes('ECONNRESET')) {
    console.error('❌ Ошибка соединения с Telegram API');
    console.error('🔄 Попытка переподключения через 5 секунд...');
    
    // Переподключаемся через 5 секунд при ошибках соединения
    setTimeout(() => {
      console.log('🔄 Переподключение к Telegram API...');
      bot.startPolling();
    }, 5000);
  } else {
    console.error('❌ Ошибка polling:', error);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Остановка бота...');
  bot.stopPolling();
  
  // Сбрасываем флаги парсинга
  resetParsingState();
  
  // Останавливаем непрерывный поиск
  cleanupContinuousSearch();
  
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Остановка бота...');
  bot.stopPolling();
  
  // Сбрасываем флаги парсинга
  resetParsingState();
  
  // Останавливаем непрерывный поиск
  cleanupContinuousSearch();
  
  await closeBrowser();
  process.exit(0);
});
