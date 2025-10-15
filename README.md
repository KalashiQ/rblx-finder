# Telegram Bot на Node.js + TypeScript

Базовый проект для создания Telegram бота с использованием Node.js и TypeScript.

## 🚀 Быстрый старт

### 1. Установка зависимостей

```bash
npm install
```

### 2. Настройка переменных окружения

1. Скопируйте файл `env.example` в `.env`:
```bash
cp env.example .env
```

2. Откройте файл `.env` и настройте переменные:
```
BOT_TOKEN=your_bot_token_here
ALLOWED_USER_IDS=123456789,987654321
```

**Настройка доступа:**
- `ALLOWED_USER_IDS` - список ID пользователей, которым разрешен доступ к боту (через запятую)
- Если `ALLOWED_USER_IDS` не задан или пуст - доступ открыт для всех пользователей
- Чтобы узнать свой ID, напишите боту [@userinfobot](https://t.me/userinfobot)

### 3. Получение токена бота

1. Найдите [@BotFather](https://t.me/BotFather) в Telegram
2. Отправьте команду `/newbot`
3. Следуйте инструкциям для создания бота
4. Скопируйте полученный токен в файл `.env`

### 4. Запуск бота

#### Режим разработки (с автоперезагрузкой):
```bash
npm run dev
```

#### Обычный запуск:
```bash
npm run build
npm start
```

#### Запуск с отслеживанием изменений:
```bash
npm run watch
```

## 📁 Структура проекта

```
├── src/
│   └── index.ts          # Основной файл бота
├── dist/                 # Скомпилированные файлы (создается автоматически)
├── package.json          # Зависимости и скрипты
├── tsconfig.json         # Конфигурация TypeScript
├── env.example           # Пример файла с переменными окружения
├── .gitignore           # Игнорируемые файлы для Git
└── README.md            # Документация
```

## 🤖 Доступные команды бота

- `/start` - начать работу с ботом
- `/help` - показать справку
- `/ping` - проверить работу бота

## 🛠 Разработка

### Добавление новых команд

Для добавления новой команды в файле `src/index.ts`:

```typescript
bot.onText(/\/yourcommand/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Ответ на вашу команду!');
});
```

### Обработка сообщений

```typescript
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (text) {
    // Ваша логика обработки сообщения
    bot.sendMessage(chatId, `Вы написали: ${text}`);
  }
});
```

## 📦 Зависимости

- **node-telegram-bot-api** - библиотека для работы с Telegram Bot API
- **dotenv** - загрузка переменных окружения
- **typescript** - компилятор TypeScript
- **ts-node** - запуск TypeScript файлов без компиляции

## 🔧 Скрипты

- `npm run dev` - запуск в режиме разработки
- `npm run build` - компиляция TypeScript в JavaScript
- `npm start` - запуск скомпилированного бота
- `npm run watch` - запуск с отслеживанием изменений

## 📝 Лицензия

MIT
