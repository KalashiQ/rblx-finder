import sqlite3 from 'sqlite3';
import { config } from './config';
import type { Game, GameWithStatus } from './types';
import fs from 'fs';
import path from 'path';

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
    // Сначала проверяем, существует ли игра с таким же названием и URL
    db.get(`
      SELECT id, source_id FROM games 
      WHERE title = ? AND url = ?
    `, [game.title, game.url], (err, duplicate) => {
      if (err) {
        console.error(`❌ Ошибка поиска дубликата для "${game.title}":`, err);
        reject(err);
        return;
      }
      
      if (duplicate) {
        // Если найдена игра с таким же названием и URL, обновляем source_id
        const stmt = db.prepare(`
          UPDATE games 
          SET source_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `);
        stmt.run([game.source_id, (duplicate as any).id], (err) => {
          if (err) {
            console.error(`❌ Ошибка обновления дубликата для "${game.title}":`, err);
            reject(err);
          } else {
            resolve({ ...game, isNew: false });
          }
        });
        return;
      }
      
      // Проверяем, существует ли игра с таким source_id
      db.get('SELECT id FROM games WHERE source_id = ?', [game.source_id], (err, existing) => {
        if (err) {
          console.error(`❌ Ошибка поиска по source_id для "${game.title}":`, err);
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
              console.error(`❌ Ошибка обновления игры "${game.title}":`, err);
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
              console.error(`❌ Ошибка создания игры "${game.title}":`, err);
              reject(err);
            } else {
              resolve({ ...game, isNew: true });
            }
          });
        }
      });
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

export function getDatabaseStats(): Promise<{
  totalGames: number;
  databaseSize: string;
  oldestGame: string | null;
  newestGame: string | null;
}> {
  return new Promise((resolve, reject) => {
    // Получаем общее количество игр
    db.get('SELECT COUNT(*) as count FROM games', (err, result: any) => {
      if (err) {
        reject(err);
        return;
      }
      
      const totalGames = result.count;
      
      // Получаем размер базы данных
      db.get("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()", (err, sizeResult: any) => {
        if (err) {
          reject(err);
          return;
        }
        
        const databaseSize = sizeResult ? `${Math.round(sizeResult.size / 1024)} KB` : 'Неизвестно';
        
        // Получаем самую старую и новую игру
        db.get(`
          SELECT 
            MIN(created_at) as oldest,
            MAX(created_at) as newest
          FROM games
        `, (err, dateResult: any) => {
          if (err) {
            reject(err);
            return;
          }
          
          resolve({
            totalGames,
            databaseSize,
            oldestGame: dateResult?.oldest || null,
            newestGame: dateResult?.newest || null
          });
        });
      });
    });
  });
}

export function clearAllGames(): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM games', (err) => {
      if (err) {
        reject(err);
      } else {
        // Сбрасываем AUTOINCREMENT для ID
        db.run('DELETE FROM sqlite_sequence WHERE name = "games"', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  });
}

export function removeDuplicateGames(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Удаляем дубликаты, оставляя только самую старую запись для каждой комбинации title + url
    db.run(`
      DELETE FROM games 
      WHERE id NOT IN (
        SELECT MIN(id) 
        FROM games 
        GROUP BY title, url
      )
    `, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.changes || 0);
      }
    });
  });
}

export function checkDuplicates(): Promise<{duplicates: number, total: number}> {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) - COUNT(DISTINCT title || '|' || url) as duplicates
      FROM games
    `, (err, result: any) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          duplicates: result.duplicates,
          total: result.total
        });
      }
    });
  });
}

export function gameExistsByUrl(url: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM games WHERE url = ?', [url], (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(!!result);
      }
    });
  });
}

export function exportGamesToJson(): Promise<string> {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT source_id, title, url, created_at, updated_at
      FROM games
      ORDER BY created_at DESC
    `, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const exportData = {
          exportDate: new Date().toISOString(),
          totalGames: rows.length,
          games: rows
        };
        resolve(JSON.stringify(exportData, null, 2));
      }
    });
  });
}

export function exportGamesToCsv(): Promise<string> {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT source_id, title, url, created_at, updated_at
      FROM games
      ORDER BY created_at DESC
    `, (err, rows: any[]) => {
      if (err) {
        reject(err);
      } else {
        // Создаем CSV заголовки
        const headers = ['source_id', 'title', 'url', 'created_at', 'updated_at'];
        const csvRows = [headers.join(',')];
        
        // Добавляем данные
        rows.forEach(row => {
          const values = [
            `"${row.source_id}"`,
            `"${row.title.replace(/"/g, '""')}"`, // Экранируем кавычки в названии
            `"${row.url}"`,
            `"${row.created_at}"`,
            `"${row.updated_at}"`
          ];
          csvRows.push(values.join(','));
        });
        
        resolve(csvRows.join('\n'));
      }
    });
  });
}

export function exportDatabaseToFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().split('T')[0];
    const exportPath = path.join(process.cwd(), `games_export_${timestamp}.db`);
    
    // Копируем текущую базу данных
    fs.copyFile(config.DATABASE_PATH, exportPath, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(exportPath);
      }
    });
  });
}

export function exportGamesToJsonFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().split('T')[0];
    const exportPath = path.join(process.cwd(), `games_export_${timestamp}.json`);
    
    db.all(`
      SELECT source_id, title, url, created_at, updated_at
      FROM games
      ORDER BY created_at DESC
    `, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        const exportData = {
          exportDate: new Date().toISOString(),
          totalGames: rows.length,
          games: rows
        };
        
        fs.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf8', (writeErr) => {
          if (writeErr) {
            reject(writeErr);
          } else {
            resolve(exportPath);
          }
        });
      }
    });
  });
}

export function exportGamesToCsvFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().split('T')[0];
    const exportPath = path.join(process.cwd(), `games_export_${timestamp}.csv`);
    
    db.all(`
      SELECT source_id, title, url, created_at, updated_at
      FROM games
      ORDER BY created_at DESC
    `, (err, rows: any[]) => {
      if (err) {
        reject(err);
      } else {
        // Создаем CSV заголовки
        const headers = ['source_id', 'title', 'url', 'created_at', 'updated_at'];
        const csvRows = [headers.join(',')];
        
        // Добавляем данные
        rows.forEach(row => {
          const values = [
            `"${row.source_id}"`,
            `"${row.title.replace(/"/g, '""')}"`, // Экранируем кавычки в названии
            `"${row.url}"`,
            `"${row.created_at}"`,
            `"${row.updated_at}"`
          ];
          csvRows.push(values.join(','));
        });
        
        fs.writeFile(exportPath, csvRows.join('\n'), 'utf8', (writeErr) => {
          if (writeErr) {
            reject(writeErr);
          } else {
            resolve(exportPath);
          }
        });
      }
    });
  });
}

export { db };
