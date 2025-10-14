import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

// Загружаем переменные окружения
dotenv.config();

// Проверяем наличие токена бота
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN не найден в переменных окружения!');
  console.log('Создайте файл .env и добавьте ваш токен бота');
  process.exit(1);
}

// Создаем экземпляр бота
const bot = new TelegramBot(token, { polling: true });

console.log('🤖 Telegram бот запущен!');

// Обработчик команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'Пользователь';
  
  bot.sendMessage(chatId, `Привет, ${firstName}! 👋\n\nЯ базовый Telegram бот на Node.js + TypeScript.\n\nДоступные команды:\n/start - начать работу\n/help - помощь\n/ping - проверить работу бота`);
});

// Обработчик команды /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, `📋 Справка по командам:\n\n/start - начать работу с ботом\n/help - показать эту справку\n/ping - проверить, что бот работает\n\nДля получения токена бота обратитесь к @BotFather в Telegram`);
});

// Обработчик команды /ping
bot.onText(/\/ping/, (msg) => {
  const chatId = msg.chat.id;
  
  bot.sendMessage(chatId, '🏓 Pong! Бот работает нормально!');
});

// Обработчик всех остальных сообщений
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Игнорируем команды (они обрабатываются выше)
  if (text && text.startsWith('/')) {
    return;
  }
  
  // Отвечаем на обычные сообщения
  if (text) {
    bot.sendMessage(chatId, `Вы написали: "${text}"\n\nИспользуйте /help для просмотра доступных команд.`);
  }
});

// Обработка ошибок
bot.on('error', (error) => {
  console.error('❌ Ошибка бота:', error);
});

bot.on('polling_error', (error) => {
  console.error('❌ Ошибка polling:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stopPolling();
  process.exit(0);
});
