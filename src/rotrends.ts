import { load } from 'cheerio';
import { newPage } from './browser';
import pino from 'pino';
import { config } from './config';
import type { Game } from './types';

function normalizeSourceIdFromUrl(url: string): string {
  // Try to extract Roblox placeId or an ID-like segment
  // Examples we might see: /games/1234567890/some-title or attribute data-game-id
  const match = url.match(/\/(?:games|game)\/(\d+)/);
  if (match) return match[1];
  // Fallback to full URL as stable id
  return url;
}

function parseGamesFromHtml(html: string): Game[] {
  const $ = load(html);
  const games: Game[] = [];

  // Heuristic selectors; may need adjustment based on actual markup
  $('[data-game-id], a[href*="/games/"]').each((_, el) => {
    const anchor = $(el).is('a') ? $(el) : $(el).find('a[href*="/games/"]').first();
    const href = anchor.attr('href');
    if (!href) return;

    const title = anchor.attr('title') || anchor.text().trim();
    const absoluteUrl = href.startsWith('http') ? href : `https://rotrends.com${href}`;
    const sourceId = normalizeSourceIdFromUrl(absoluteUrl);

    if (!title || !sourceId) return;

    games.push({
      source_id: sourceId,
      title,
      url: absoluteUrl,
    });
  });

  return games;
}

const logger = pino({ level: config.LOG_LEVEL });

async function waitForGamesJson(
  page: import('playwright').Page,
  timeoutMs = 7000
): Promise<unknown | null> {
  try {
    const resp = await page.waitForResponse(
      (r) => {
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        const url = r.url();
        return ct.includes('application/json') && /games|search|list|api/i.test(url);
      },
      { timeout: timeoutMs }
    );
    const data = await resp.json().catch(async () => {
      const txt = await resp.text();
      try {
        return JSON.parse(txt);
      } catch {
        return null;
      }
    });
    return data ?? null;
  } catch {
    return null;
  }
}

async function extractGamesFromDom(page: import('playwright').Page): Promise<Game[]> {
  // Достаём игры прямо из DOM после выполнения JS на странице
  const items = await page.$$eval('a[href^="/games/"], a[href^="/game/"]', (anchors) => {
    return anchors.map((a) => {
      const href = a.getAttribute('href') || '';
      const titleAttr = a.getAttribute('title') || '';
      const titleText = (a.textContent || '').trim();
      const title = titleAttr || titleText;
      const absoluteUrl = href.startsWith('http') ? href : `https://rotrends.com${href}`;
      const match = absoluteUrl.match(/\/(?:games|game)\/(\d+)/);
      const sourceId = match ? match[1] : absoluteUrl;
      return { source_id: sourceId, title, url: absoluteUrl };
    });
  });
  // Фильтруем пустые
  return items.filter((g) => g.title && g.url);
}

export async function fetchGamesByLetter(letter: string, pageSize = 100): Promise<Game[]> {
  // Пробуем разные варианты кодировки для русских букв
  const encodedLetter = encodeURIComponent(letter);
  const url = `https://rotrends.com/games?keyword=${encodedLetter}&page_size=${pageSize}&sort=-playing`;
  
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    const page = await newPage();
    try {
      logger.info({ url, type: 'letter', letter, retry: retryCount + 1 }, '🔍 Navigating to rotrends for letter');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const navUrl = page.url();
      const title = await page.title();
      logger.info({ navUrl, title }, '📄 Page loaded');
      await page.waitForTimeout(2000); // Увеличиваем таймаут
    // Try to consume JSON from XHR
    const json = await waitForGamesJson(page);
    logger.info({ hasJson: !!json, jsonType: typeof json }, '📊 JSON response status');
    
    if (json && typeof json === 'object' && (json as any).data?.games) {
      const jsonGames = (json as any).data.games;
      logger.info({ jsonGamesCount: jsonGames.length }, '📋 Found games in JSON response');
      
      // Ждём появления ссылок на игры в DOM
      await page.waitForSelector('a[href^="/games/"], a[href^="/game/"]', { timeout: 5000 }).catch(() => {});
      // Сначала попробуем извлечь полные ссылки из DOM
      const domGames = await extractGamesFromDom(page);
      logger.info({ domGamesCount: domGames.length }, '🎮 Extracted games from DOM');
      if (domGames.length > 0) {
        // Сопоставляем данные из JSON с полными ссылками из DOM
        const items = (json as any).data.games as any[];
        const mapped: Game[] = items
          .map((g) => {
            const gameId = String(g.place_id ?? g.game_id ?? g.id ?? '');
            // Ищем соответствующую игру в DOM по game_id (не place_id)
            const domGame = domGames.find(dg => dg.source_id === String(g.game_id ?? g.id ?? ''));
            return {
              source_id: gameId,
              title: String(g.game_name ?? g.title ?? ''),
              url: domGame?.url || `https://rotrends.com/games/${g.game_id ?? g.id ?? ''}`,
              ccu: typeof g.playing === 'number' ? g.playing : typeof g.ccu === 'number' ? g.ccu : undefined,
            };
          })
          .filter((g) => g.source_id && g.title && g.url);
        if (mapped.length > 0) return mapped;
      } else {
        // Fallback к старой логике если DOM игры не найдены
        const items = (json as any).data.games as any[];
        const mapped: Game[] = items
          .map((g) => ({
            source_id: String(g.place_id ?? g.game_id ?? g.id ?? ''),
            title: String(g.game_name ?? g.title ?? ''),
            url: `https://rotrends.com/games/${g.game_id ?? g.id ?? ''}`,
            ccu: typeof g.playing === 'number' ? g.playing : typeof g.ccu === 'number' ? g.ccu : undefined,
          }))
          .filter((g) => g.source_id && g.title && g.url);
        if (mapped.length > 0) return mapped;
      }
    }
    // Ждём появления ссылок на игры (если данные подгружаются XHR)
    await page.waitForSelector('a[href^="/games/"], a[href^="/game/"]', { timeout: 5000 }).catch(() => {});
    const content = await page.content();
    logger.debug({ url, navUrl, title, htmlLength: content.length }, 'Loaded rotrends page');
      const games = (await extractGamesFromDom(page)).length ? await extractGamesFromDom(page) : parseGamesFromHtml(content);
      logger.info({ gamesCount: games.length, letter, retry: retryCount + 1 }, '✅ Final games count for letter');
      
      if (games.length === 0) {
        logger.warn({ url, navUrl, title, retry: retryCount + 1 }, '❌ No games parsed');
        if (retryCount < maxRetries - 1) {
          logger.info({ letter, retry: retryCount + 1 }, '🔄 Retrying due to empty result');
          retryCount++;
          await page.context().close();
          await new Promise(resolve => setTimeout(resolve, 2000)); // Задержка перед retry
          continue;
        }
      }
      
      await page.context().close();
      return games;
      
    } catch (error) {
      logger.error({ letter, retry: retryCount + 1, error: (error as Error).message }, '❌ Error during parsing');
      await page.context().close();
      
      if (retryCount < maxRetries - 1) {
        logger.info({ letter, retry: retryCount + 1 }, '🔄 Retrying due to error');
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 3000)); // Задержка перед retry
        continue;
      } else {
        logger.error({ letter, error: (error as Error).message }, '💥 Max retries exceeded');
        throw error;
      }
    }
  }
  
  // Если дошли сюда, значит все retry исчерпаны
  throw new Error(`Failed to parse letter "${letter}" after ${maxRetries} attempts`);
}


export async function fetchGamesByLetterPage(
  letter: string,
  page: number,
  pageSize = 50
): Promise<Game[]> {
  const encodedLetter = encodeURIComponent(letter);
  const url = `https://rotrends.com/games?keyword=${encodedLetter}&page=${page}&page_size=${pageSize}&sort=-playing`;
  
  let retryCount = 0;
  const maxRetries = 3;
  
  while (retryCount < maxRetries) {
    const p = await newPage();
    try {
      logger.info({ url, type: 'letter_page', letter, page, pageSize, retry: retryCount + 1 }, '🔍 Navigating to rotrends page');
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(2000); // Увеличиваем таймаут
    const json = await waitForGamesJson(p);
    if (json && typeof json === 'object' && (json as any).data?.games) {
      // Ждём появления ссылок на игры в DOM
      await p.waitForSelector('a[href^="/games/"], a[href^="/game/"]', { timeout: 5000 }).catch(() => {});
      // Сначала попробуем извлечь полные ссылки из DOM
      const domGames = await extractGamesFromDom(p);
      logger.debug({ domGamesCount: domGames.length }, 'Extracted games from DOM');
      if (domGames.length > 0) {
        // Сопоставляем данные из JSON с полными ссылками из DOM
        const items = (json as any).data.games as any[];
        const mapped: Game[] = items
          .map((g) => {
            const gameId = String(g.place_id ?? g.game_id ?? g.id ?? '');
            // Ищем соответствующую игру в DOM по game_id (не place_id)
            const domGame = domGames.find(dg => dg.source_id === String(g.game_id ?? g.id ?? ''));
            return {
              source_id: gameId,
              title: String(g.game_name ?? g.title ?? ''),
              url: domGame?.url || `https://rotrends.com/games/${g.game_id ?? g.id ?? ''}`,
              ccu: typeof g.playing === 'number' ? g.playing : typeof g.ccu === 'number' ? g.ccu : undefined,
            };
          })
          .filter((g) => g.source_id && g.title && g.url);
        if (mapped.length > 0) return mapped;
      } else {
        // Fallback к старой логике если DOM игры не найдены
        const items = (json as any).data.games as any[];
        const mapped: Game[] = items
          .map((g) => ({
            source_id: String(g.place_id ?? g.game_id ?? g.id ?? ''),
            title: String(g.game_name ?? g.title ?? ''),
            url: `https://rotrends.com/games/${g.game_id ?? g.id ?? ''}`,
            ccu: typeof g.playing === 'number' ? g.playing : typeof g.ccu === 'number' ? g.ccu : undefined,
          }))
          .filter((g) => g.source_id && g.title && g.url);
        if (mapped.length > 0) return mapped;
      }
    }
      await p.waitForSelector('a[href^="/games/"]', { timeout: 5000 }).catch(() => {});
      const content = await p.content();
      const navUrl = p.url();
      const title = await p.title();
      logger.debug({ url, navUrl, title, htmlLength: content.length }, 'Loaded rotrends page');
      const games = (await extractGamesFromDom(p)).length ? await extractGamesFromDom(p) : parseGamesFromHtml(content);
      logger.info({ gamesCount: games.length, letter, page, retry: retryCount + 1 }, '✅ Final games count for letter page');
      
      if (games.length === 0) {
        logger.warn({ url, navUrl, title, retry: retryCount + 1 }, '❌ No games parsed for page');
        if (retryCount < maxRetries - 1) {
          logger.info({ letter, page, retry: retryCount + 1 }, '🔄 Retrying due to empty result');
          retryCount++;
          await p.context().close();
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      }
      
      await p.context().close();
      return games;
      
    } catch (error) {
      logger.error({ letter, page, retry: retryCount + 1, error: (error as Error).message }, '❌ Error during page parsing');
      await p.context().close();
      
      if (retryCount < maxRetries - 1) {
        logger.info({ letter, page, retry: retryCount + 1 }, '🔄 Retrying due to error');
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      } else {
        logger.error({ letter, page, error: (error as Error).message }, '💥 Max retries exceeded for page');
        throw error;
      }
    }
  }
  
  throw new Error(`Failed to parse letter "${letter}" page ${page} after ${maxRetries} attempts`);
}