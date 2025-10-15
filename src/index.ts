import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import { initSchema, getGameCount, getGames, searchGames, getDatabaseStats, clearAllGames, exportDatabaseToFile, exportGamesToJsonFile, exportGamesToCsvFile, removeDuplicateGames, checkDuplicates } from './db';
import { parseNewGames, setProgressCallback, ProgressInfo } from './populate';
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

// Функция проверки разрешенных пользователей
function isUserAllowed(userId: number): boolean {
  // Если список разрешенных пользователей пуст, доступ открыт для всех
  if (config.ALLOWED_USER_IDS.length === 0) {
    return true;
  }
  
  return config.ALLOWED_USER_IDS.includes(userId);
}

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
  const userId = msg.from?.id;
  const firstName = msg.from?.first_name || 'Пользователь';
  
  // Проверяем, разрешен ли пользователь
  if (userId && !isUserAllowed(userId)) {
    bot.sendMessage(chatId, '❌ Доступ запрещен. Вы не имеете права использовать этого бота.');
    return;
  }
  
  bot.sendMessage(chatId, `Привет, ${firstName}! 👋\n\nЯ бот для парсинга игр с rotrends.com!\n\nВыберите действие:`, mainKeyboard);
});

// Обработчик команды /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  
  // Проверяем, разрешен ли пользователь
  if (userId && !isUserAllowed(userId)) {
    bot.sendMessage(chatId, '❌ Доступ запрещен. Вы не имеете права использовать этого бота.');
    return;
  }
  
  bot.sendMessage(chatId, `📋 Справка по командам:\n\n/start - начать работу с ботом\n/help - показать эту справку\n\nИспользуйте кнопки для навигации по функциям бота.`, mainKeyboard);
});

// Обработчик команды /ping
bot.onText(/\/ping/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  
  // Проверяем, разрешен ли пользователь
  if (userId && !isUserAllowed(userId)) {
    bot.sendMessage(chatId, '❌ Доступ запрещен. Вы не имеете права использовать этого бота.');
    return;
  }
  
  bot.sendMessage(chatId, '🏓 Pong! Бот работает нормально!');
});

// Обработчик кнопок
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text;
  
  // Проверяем, разрешен ли пользователь
  if (userId && !isUserAllowed(userId)) {
    bot.sendMessage(chatId, '❌ Доступ запрещен. Вы не имеете права использовать этого бота.');
    return;
  }
  
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
  const userId = callbackQuery.from?.id;
  
  if (!chatId || !data) return;
  
  // Проверяем, разрешен ли пользователь
  if (userId && !isUserAllowed(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Доступ запрещен' });
    return;
  }
  
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
    } else if (data === 'clear_database') {
      // Показываем подтверждение очистки
      const confirmKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Да, очистить', callback_data: 'confirm_clear_database' },
              { text: '❌ Отмена', callback_data: 'cancel_clear_database' }
            ]
          ]
        }
      };
      
      await bot.editMessageText('⚠️ ВНИМАНИЕ!\n\nВы действительно хотите очистить всю базу данных?\n\nЭто действие необратимо и удалит ВСЕ игры из базы!', {
        chat_id: chatId,
        message_id: messageId,
        ...confirmKeyboard
      });
    } else if (data === 'confirm_clear_database') {
      try {
        await clearAllGames();
        
        await bot.editMessageText('✅ База данных успешно очищена!\n\nВсе игры удалены из базы.', {
          chat_id: chatId,
          message_id: messageId
        });
        
        // Отправляем основную клавиатуру
        await bot.sendMessage(chatId, 'База данных очищена. Выберите другое действие:', mainKeyboard);
      } catch (error) {
        logger.error({ error, chatId }, 'Error clearing database');
        await bot.editMessageText('❌ Ошибка при очистке базы данных.', {
          chat_id: chatId,
          message_id: messageId
        });
      }
    } else if (data === 'cancel_clear_database') {
      // Возвращаемся к статистике
      await handleStats(chatId, messageId);
    } else if (data === 'refresh_stats') {
      // Обновляем статистику
      await handleStats(chatId, messageId);
    } else if (data === 'check_duplicates') {
      try {
        const duplicateInfo = await checkDuplicates();
        
        let message = `🔍 Проверка дубликатов:\n\n`;
        message += `📊 Всего записей: ${duplicateInfo.total}\n`;
        message += `🔄 Дубликатов: ${duplicateInfo.duplicates}\n`;
        message += `✅ Уникальных: ${duplicateInfo.total - duplicateInfo.duplicates}\n\n`;
        
        if (duplicateInfo.duplicates > 0) {
          message += `⚠️ Найдены дубликаты! Используйте кнопку "🧹 Удалить дубликаты" для очистки.`;
        } else {
          message += `✅ Дубликатов не найдено!`;
        }
        
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: messageId
        });
        
        await bot.answerCallbackQuery(callbackQuery.id, { 
          text: duplicateInfo.duplicates > 0 ? `⚠️ Найдено ${duplicateInfo.duplicates} дубликатов` : '✅ Дубликатов не найдено'
        });
      } catch (error) {
        logger.error({ error, chatId }, 'Error checking duplicates');
        await bot.editMessageText('❌ Ошибка при проверке дубликатов.', {
          chat_id: chatId,
          message_id: messageId
        });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка при проверке дубликатов' });
      }
    } else if (data === 'remove_duplicates') {
      try {
        const removedCount = await removeDuplicateGames();
        
        await bot.editMessageText(`✅ Дубликаты удалены!\n\n🗑️ Удалено записей: ${removedCount}\n\nОбновляю статистику...`, {
          chat_id: chatId,
          message_id: messageId
        });
        
        // Обновляем статистику после удаления дубликатов
        setTimeout(async () => {
          await handleStats(chatId, messageId);
        }, 1000);
        
        await bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Удалено ${removedCount} дубликатов` });
      } catch (error) {
        logger.error({ error, chatId }, 'Error removing duplicates');
        await bot.editMessageText('❌ Ошибка при удалении дубликатов.', {
          chat_id: chatId,
          message_id: messageId
        });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка при удалении дубликатов' });
      }
    } else if (data === 'export_db') {
      try {
        const filePath = await exportDatabaseToFile();
        
        // Отправляем файл как документ
        await bot.sendDocument(chatId, filePath, {
          caption: `🗄️ Экспорт базы данных в SQLite\n\n📅 Дата экспорта: ${new Date().toLocaleDateString('ru-RU')}\n\n💡 Этот файл можно открыть в любом SQLite браузере`
        });
        
        // Удаляем временный файл после отправки
        setTimeout(() => {
          require('fs').unlink(filePath, (err: any) => {
            if (err) logger.error({ error: err, filePath }, 'Error deleting temp file');
          });
        }, 5000);
        
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ .db файл отправлен!' });
      } catch (error) {
        logger.error({ error, chatId }, 'Error exporting database');
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка при экспорте .db файла' });
      }
    } else if (data === 'export_json') {
      try {
        const filePath = await exportGamesToJsonFile();
        
        // Отправляем файл как документ
        await bot.sendDocument(chatId, filePath, {
          caption: `📤 Экспорт базы данных в JSON\n\n📅 Дата экспорта: ${new Date().toLocaleDateString('ru-RU')}`
        });
        
        // Удаляем временный файл после отправки
        setTimeout(() => {
          require('fs').unlink(filePath, (err: any) => {
            if (err) logger.error({ error: err, filePath }, 'Error deleting temp file');
          });
        }, 5000);
        
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ JSON файл отправлен!' });
      } catch (error) {
        logger.error({ error, chatId }, 'Error exporting JSON');
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка при экспорте JSON' });
      }
    } else if (data === 'export_csv') {
      try {
        const filePath = await exportGamesToCsvFile();
        
        // Отправляем файл как документ
        await bot.sendDocument(chatId, filePath, {
          caption: `📊 Экспорт базы данных в CSV\n\n📅 Дата экспорта: ${new Date().toLocaleDateString('ru-RU')}`
        });
        
        // Удаляем временный файл после отправки
        setTimeout(() => {
          require('fs').unlink(filePath, (err: any) => {
            if (err) logger.error({ error: err, filePath }, 'Error deleting temp file');
          });
        }, 5000);
        
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ CSV файл отправлен!' });
      } catch (error) {
        logger.error({ error, chatId }, 'Error exporting CSV');
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка при экспорте CSV' });
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
    
    // Настраиваем callback для обновления прогресса
    setProgressCallback(async (progress: ProgressInfo) => {
      try {
        const progressText = progress.isComplete 
          ? `✅ Парсинг завершен!\n\n📊 Результаты:\n• Всего обработано: ${progress.totalGames}\n• Новых игр: ${progress.newGames}\n• Обновлено: ${progress.updatedGames}\n• Пропущено: ${progress.skippedGames}\n• Ошибок: ${progress.errors}`
          : `🔄 Парсинг в процессе...\n\n📝 Буква: "${progress.currentLetter}" (${progress.letterIndex}/${progress.totalLetters})\n📄 Страница: ${progress.currentPage}\n\n📊 Статистика:\n• Обработано игр: ${progress.totalGames}\n• Новых игр: ${progress.newGames}\n• Обновлено: ${progress.updatedGames}\n• Пропущено: ${progress.skippedGames}\n• Ошибок: ${progress.errors}\n\n🕐 ${new Date().toLocaleTimeString('ru-RU')}`;
        
        await bot.editMessageText(progressText, {
          chat_id: chatId,
          message_id: parsingMessage.message_id,
          reply_markup: progress.isComplete ? undefined : cancelKeyboard.reply_markup
        });
      } catch (error: any) {
        // Игнорируем ошибку "message is not modified"
        if (error.message?.includes('message is not modified')) {
          logger.debug({ chatId }, 'Progress message not modified, skipping update');
        } else {
          logger.error({ error, chatId }, 'Error updating progress message');
        }
      }
    });
    
    // Инициализируем браузер
    await initBrowser();
    
    const result = await parseNewGames();
    
    // Сбрасываем флаги
    resetParsingState();
    
    // Отправляем финальное сообщение с полной статистикой
    const finalMessage = `✅ Парсинг завершен!\n\n📊 Результаты:\n• Всего обработано: ${result.totalGames}\n• Новых игр: ${result.newGames}\n• Обновлено: ${result.updatedGames}\n• Пропущено: ${result.skippedGames}\n• Ошибок: ${result.errors}\n• Всего в базе: ${result.realGameCount}`;
    
    await bot.sendMessage(chatId, finalMessage, mainKeyboard);
    
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
async function handleStats(chatId: number, messageId?: number) {
  try {
    const stats = await getDatabaseStats();
    
    // Форматируем даты
    const formatDate = (dateStr: string | null) => {
      if (!dateStr) return 'Неизвестно';
      const date = new Date(dateStr);
      return date.toLocaleDateString('ru-RU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    };
    
    const message = `📊 Статистика базы данных:\n\n` +
      `🎮 Всего игр: ${stats.totalGames}\n` +
      `💾 Размер БД: ${stats.databaseSize}\n` +
      `📅 Самая старая игра: ${formatDate(stats.oldestGame)}\n` +
      `📅 Самая новая игра: ${formatDate(stats.newestGame)}\n\n` +
      `🕐 Обновлено: ${new Date().toLocaleTimeString('ru-RU')}`;
    
    // Создаем inline клавиатуру с кнопками
    const statsKeyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🗄️ Экспорт .db', callback_data: 'export_db' },
            { text: '📤 Экспорт JSON', callback_data: 'export_json' }
          ],
          [
            { text: '📊 Экспорт CSV', callback_data: 'export_csv' }
          ],
          [
            { text: '🔍 Проверить дубликаты', callback_data: 'check_duplicates' },
            { text: '🧹 Удалить дубликаты', callback_data: 'remove_duplicates' }
          ],
          [
            { text: '🗑️ Очистить всю БД', callback_data: 'clear_database' }
          ],
          [{ text: '🔄 Обновить статистику', callback_data: 'refresh_stats' }]
        ]
      }
    };
    
    if (messageId) {
      // Редактируем существующее сообщение
      try {
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: messageId,
          ...statsKeyboard
        });
      } catch (editError: any) {
        // Если сообщение не изменилось, просто игнорируем ошибку
        if (editError.message?.includes('message is not modified')) {
          logger.debug({ chatId, messageId }, 'Message not modified, skipping edit');
        } else {
          throw editError;
        }
      }
    } else {
      // Отправляем новое сообщение
      await bot.sendMessage(chatId, message, statsKeyboard);
    }
  } catch (error) {
    logger.error({ error, chatId }, 'Error getting stats');
    if (messageId) {
      await bot.editMessageText('❌ Ошибка при получении статистики.', {
        chat_id: chatId,
        message_id: messageId
      });
    } else {
      await bot.sendMessage(chatId, '❌ Ошибка при получении статистики.', mainKeyboard);
    }
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
