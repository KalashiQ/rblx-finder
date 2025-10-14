// Файл для управления состоянием парсинга
export let isParsing = false;
export let parsingChatId: number | null = null;
export let parsingMessageId: number | null = null;

export function setParsingState(parsing: boolean, chatId: number | null = null, messageId: number | null = null) {
  isParsing = parsing;
  parsingChatId = chatId;
  parsingMessageId = messageId;
}

export function resetParsingState() {
  isParsing = false;
  parsingChatId = null;
  parsingMessageId = null;
}
