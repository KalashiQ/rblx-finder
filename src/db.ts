import sqlite3 from 'sqlite3';
import { config } from './config';
import type { Game, GameWithStatus } from './types';

let db: sqlite3.Database;

export function initSchema(): void {
  db = new sqlite3.Database(config.DATABASE_PATH);
  
  // Создаем таблицу игр
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Создаем индекс для быстрого поиска по source_id
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_games_source_id ON games(source_id);
  `);
}

export function upsertGame(game: Omit<Game, 'ccu'>): Promise<number> {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO games (source_id, title, url, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `);
    
    stmt.run([game.source_id, game.title, game.url], function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
}

export function upsertGameWithStatus(game: Omit<Game, 'ccu'>): Promise<GameWithStatus> {
  return new Promise((resolve, reject) => {
    // Проверяем, существует ли игра
    db.get('SELECT id FROM games WHERE source_id = ?', [game.source_id], (err, existing) => {
      if (err) {
        reject(err);
        return;
      }
      
      if (existing) {
        // Обновляем существующую игру
        const stmt = db.prepare(`
          UPDATE games 
          SET title = ?, url = ?, updated_at = CURRENT_TIMESTAMP
          WHERE source_id = ?
        `);
        stmt.run([game.title, game.url, game.source_id], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve({ ...game, isNew: false });
          }
        });
      } else {
        // Создаем новую игру
        const stmt = db.prepare(`
          INSERT INTO games (source_id, title, url)
          VALUES (?, ?, ?)
        `);
        stmt.run([game.source_id, game.title, game.url], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve({ ...game, isNew: true });
          }
        });
      }
    });
  });
}

export function getGameCount(): Promise<number> {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM games', (err, result: any) => {
      if (err) {
        reject(err);
      } else {
        resolve(result.count);
      }
    });
  });
}

export function getGames(limit = 100, offset = 0): Promise<Game[]> {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT source_id, title, url
      FROM games
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset], (err, rows: Game[]) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

export function searchGames(query: string, limit = 50): Promise<Game[]> {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT source_id, title, url
      FROM games
      WHERE title LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `, [`%${query}%`, limit], (err, rows: Game[]) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

export { db };
