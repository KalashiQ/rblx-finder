import { chromium, Browser, BrowserContext } from 'playwright';
import pino from 'pino';
import { config } from './config';

const logger = pino({ level: config.LOG_LEVEL });

let browser: Browser | null = null;

export async function initBrowser(): Promise<void> {
  if (browser) return;
  
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  
  logger.info('Browser initialized');
}

export async function newPage(): Promise<import('playwright').Page> {
  if (!browser) {
    await initBrowser();
  }
  
  if (!browser) {
    throw new Error('Failed to initialize browser');
  }
  
  // Проверяем, что браузер не закрыт
  if (browser.isConnected() === false) {
    logger.warn('Browser disconnected, reinitializing...');
    await closeBrowser();
    await initBrowser();
    if (!browser) {
      throw new Error('Failed to reinitialize browser');
    }
  }
  
  const context: BrowserContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });
  
  const page = await context.newPage();
  
  // Устанавливаем таймауты
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Browser closed');
  }
}
