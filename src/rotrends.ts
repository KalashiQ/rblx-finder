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

export async function fetchGamesByLetter(letter: string): Promise<Game[]> {
  // Важно: rotrends ожидает не URL-энкоденную кириллицу в параметре keyword
  const url = `https://rotrends.com/games?keyword=${letter}`;
  const page = await newPage();
  try {
    logger.debug({ url, type: 'letter', letter }, 'Navigating to rotrends');
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const navUrl = page.url();
    const title = await page.title();
    await page.waitForTimeout(1200);
    // Try to consume JSON from XHR
    const json = await waitForGamesJson(page);
    if (json && typeof json === 'object' && (json as any).data?.games) {
      // Ждём появления ссылок на игры в DOM
      await page.waitForSelector('a[href^="/games/"], a[href^="/game/"]', { timeout: 5000 }).catch(() => {});
      // Сначала попробуем извлечь полные ссылки из DOM
      const domGames = await extractGamesFromDom(page);
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
    // Ждём появления ссылок на игры (если данные подгружаются XHR)
    await page.waitForSelector('a[href^="/games/"], a[href^="/game/"]', { timeout: 5000 }).catch(() => {});
    const content = await page.content();
    logger.debug({ url, navUrl, title, htmlLength: content.length }, 'Loaded rotrends page');
    const games = (await extractGamesFromDom(page)).length ? await extractGamesFromDom(page) : parseGamesFromHtml(content);
    if (games.length === 0) {
      logger.warn({ url, navUrl, title }, 'No games parsed');
    }
    return games;
  } finally {
    await page.context().close();
  }
}

export async function fetchGamesByPage(page: number, pageSize = 50): Promise<Game[]> {
  const url = `https://rotrends.com/games?page=${page}&page_size=${pageSize}&sort=-playing`;
  const p = await newPage();
  try {
    logger.debug({ url, type: 'page', page, pageSize }, 'Navigating to rotrends');
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
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
    if (games.length === 0) {
      logger.warn({ url, navUrl, title }, 'No games parsed');
    }
    return games;
  } finally {
    await p.context().close();
  }
}

export async function fetchGamesByLetterPage(
  letter: string,
  page: number,
  pageSize = 50
): Promise<Game[]> {
  const url = `https://rotrends.com/games?keyword=${letter}&page=${page}&page_size=${pageSize}&sort=-playing`;
  const p = await newPage();
  try {
    logger.debug({ url, type: 'letter_page', letter, page, pageSize }, 'Navigating to rotrends');
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
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
    if (games.length === 0) {
      logger.warn({ url, navUrl, title }, 'No games parsed');
    }
    return games;
  } finally {
    await p.context().close();
  }
}