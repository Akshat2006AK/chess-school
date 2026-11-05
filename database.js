const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'chess.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize tables
function init() {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      registration_status TEXT DEFAULT 'approved', -- 'pending', 'approved', 'rejected'
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      last_login INTEGER
    )
  `);

  // User stats table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id TEXT PRIMARY KEY,
      wins INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Games table (for history)
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      white_id TEXT,
      black_id TEXT,
      white_name TEXT NOT NULL,
      black_name TEXT NOT NULL,
      mode TEXT NOT NULL, -- 'cpu', 'multiplayer'
      level TEXT, -- 'beginner', 'medium', 'expert'
      time_control TEXT,
      result TEXT, -- 'white', 'black', 'draw', 'abandoned'
      moves TEXT, -- JSON array of moves
      started_at INTEGER DEFAULT (strftime('%s', 'now')),
      ended_at INTEGER,
      FOREIGN KEY (white_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (black_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Active rooms table
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL, -- 6-char room code
      host_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      guest_id TEXT,
      guest_name TEXT,
      mode TEXT NOT NULL, -- 'multiplayer'
      time_control TEXT,
      status TEXT DEFAULT 'waiting', -- 'waiting', 'playing', 'finished'
      game_state TEXT, -- JSON game state
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (guest_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Create indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_games_user ON games(white_id, black_id)`);

  // Tournaments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      time_control TEXT NOT NULL,
      max_players INTEGER DEFAULT 64,
      status TEXT DEFAULT 'upcoming', -- 'upcoming', 'registration', 'ongoing', 'completed', 'cancelled'
      created_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Tournament registrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS tournament_registrations (
      id TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      registered_at INTEGER DEFAULT (strftime('%s', 'now')),
      status TEXT DEFAULT 'registered', -- 'registered', 'checked_in', 'eliminated', 'winner'
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(tournament_id, user_id)
    )
  `);

  // Announcements table
  db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'info', -- 'info', 'warning', 'success', 'tournament'
      target_audience TEXT DEFAULT 'all', -- 'all', 'registered', 'admins'
      created_by TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      expires_at INTEGER,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Create indexes for new tables
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tournament_reg_tournament ON tournament_registrations(tournament_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tournament_reg_user ON tournament_registrations(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active, expires_at)`);
}

init();

// User operations
const userOps = {
  create: db.prepare(`
    INSERT INTO users (id, username, password_hash, salt, is_admin, registration_status)
    VALUES (?, ?, ?, ?, 0, 'pending')
  `),
  getByUsername: db.prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`),
  getById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  updateLastLogin: db.prepare(`UPDATE users SET last_login = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM users WHERE id = ?`),
  // Admin operations
  getAll: db.prepare(`SELECT id, username, is_admin, registration_status, created_at, last_login FROM users ORDER BY created_at DESC`),
  getPending: db.prepare(`SELECT * FROM users WHERE registration_status = 'pending' ORDER BY created_at ASC`),
  updateStatus: db.prepare(`UPDATE users SET registration_status = ? WHERE id = ?`),
  setAdmin: db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`),
  getStats: db.prepare(`SELECT
    COUNT(*) as total_users,
    SUM(CASE WHEN registration_status = 'pending' THEN 1 ELSE 0 END) as pending_users,
    SUM(CASE WHEN registration_status = 'approved' THEN 1 ELSE 0 END) as approved_users,
    SUM(CASE WHEN is_admin = 1 THEN 1 ELSE 0 END) as admin_count
    FROM users`),
};

const statsOps = {
  get: db.prepare(`SELECT * FROM user_stats WHERE user_id = ?`),
  upsert: db.prepare(`
    INSERT INTO user_stats (user_id, wins, draws, losses, games_played)
    VALUES (?, 0, 0, 0, 0)
    ON CONFLICT(user_id) DO NOTHING
  `),
  incrementWin: db.prepare(`UPDATE user_stats SET wins = wins + 1, games_played = games_played + 1 WHERE user_id = ?`),
  incrementDraw: db.prepare(`UPDATE user_stats SET draws = draws + 1, games_played = games_played + 1 WHERE user_id = ?`),
  incrementLoss: db.prepare(`UPDATE user_stats SET losses = losses + 1, games_played = games_played + 1 WHERE user_id = ?`),
};

const gameOps = {
  create: db.prepare(`
    INSERT INTO games (id, white_id, black_id, white_name, black_name, mode, level, time_control, result, moves, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getByUser: db.prepare(`
    SELECT * FROM games WHERE white_id = ? OR black_id = ? ORDER BY started_at DESC LIMIT 50
  `),
  updateResult: db.prepare(`
    UPDATE games SET result = ?, moves = ?, ended_at = ? WHERE id = ?
  `),
  // Admin operations
  getAll: db.prepare(`
    SELECT g.*,
      u1.username as white_username,
      u2.username as black_username
    FROM games g
    LEFT JOIN users u1 ON g.white_id = u1.id
    LEFT JOIN users u2 ON g.black_id = u2.id
    ORDER BY g.started_at DESC
  `),
  getRecent: db.prepare(`
    SELECT g.*,
      u1.username as white_username,
      u2.username as black_username
    FROM games g
    LEFT JOIN users u1 ON g.white_id = u1.id
    LEFT JOIN users u2 ON g.black_id = u2.id
    ORDER BY g.started_at DESC LIMIT 100
  `),
};

const roomOps = {
  create: db.prepare(`
    INSERT INTO rooms (id, code, host_id, host_name, mode, time_control, status, game_state)
    VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?)
  `),
  getByCode: db.prepare(`SELECT * FROM rooms WHERE code = ?`),
  getById: db.prepare(`SELECT * FROM rooms WHERE id = ?`),
  getWaiting: db.prepare(`SELECT * FROM rooms WHERE status = 'waiting' AND guest_id IS NULL ORDER BY created_at DESC`),
  // Admin operations
  getAll: db.prepare(`SELECT * FROM rooms ORDER BY created_at DESC`),
  getWithPlayers: db.prepare(`
    SELECT r.*,
      u1.username as host_username,
      u2.username as guest_username
    FROM rooms r
    LEFT JOIN users u1 ON r.host_id = u1.id
    LEFT JOIN users u2 ON r.guest_id = u2.id
    ORDER BY r.created_at DESC
  `),
  updateGuest: db.prepare(`
    UPDATE rooms SET guest_id = ?, guest_name = ?, status = 'playing', updated_at = ? WHERE id = ?
  `),
  updateState: db.prepare(`
    UPDATE rooms SET game_state = ?, updated_at = ? WHERE id = ?
  `),
  updateStatus: db.prepare(`
    UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?
  `),
  delete: db.prepare(`DELETE FROM rooms WHERE id = ?`),
  cleanupOld: db.prepare(`
    DELETE FROM rooms WHERE status != 'playing' AND created_at < ?
  `),
};

// Helper functions
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function hashPassword(password, salt) {
  return bcrypt.hash(password + salt, 10);
}

async function verifyPassword(password, salt, hash) {
  return bcrypt.compare(password + salt, hash);
}

// Cleanup old waiting rooms (older than 1 hour)
function cleanupOldRooms() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  roomOps.cleanupOld.run(Math.floor(oneHourAgo / 1000));
}

// Run cleanup every 10 minutes
setInterval(cleanupOldRooms, 10 * 60 * 1000);

// Tournament operations
const tournamentOps = {
  create: db.prepare(`
    INSERT INTO tournaments (id, name, description, start_time, end_time, time_control, max_players, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'upcoming', ?)
  `),
  getAll: db.prepare(`SELECT t.*, u.username as creator_name FROM tournaments t LEFT JOIN users u ON t.created_by = u.id ORDER BY t.created_at DESC`),
  getById: db.prepare(`SELECT t.*, u.username as creator_name FROM tournaments t LEFT JOIN users u ON t.created_by = u.id WHERE t.id = ?`),
  getByStatus: db.prepare(`SELECT t.*, u.username as creator_name FROM tournaments t LEFT JOIN users u ON t.created_by = u.id WHERE t.status = ? ORDER BY t.start_time ASC`),
  update: db.prepare(`
    UPDATE tournaments SET name = ?, description = ?, start_time = ?, end_time = ?, time_control = ?, max_players = ?, status = ? WHERE id = ?
  `),
  updateStatus: db.prepare(`UPDATE tournaments SET status = ? WHERE id = ?`),
  delete: db.prepare(`DELETE FROM tournaments WHERE id = ?`),
  getRegistrationCount: db.prepare(`SELECT COUNT(*) as count FROM tournament_registrations WHERE tournament_id = ?`),
  getRegistrations: db.prepare(`
    SELECT tr.*, u.username FROM tournament_registrations tr LEFT JOIN users u ON tr.user_id = u.id WHERE tr.tournament_id = ?
  `),
  register: db.prepare(`
    INSERT INTO tournament_registrations (id, tournament_id, user_id) VALUES (?, ?, ?)
  `),
  unregister: db.prepare(`DELETE FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`),
  updateRegistrationStatus: db.prepare(`UPDATE tournament_registrations SET status = ? WHERE tournament_id = ? AND user_id = ?`),
  getUserRegistrations: db.prepare(`SELECT tr.*, t.name, t.start_time, t.status FROM tournament_registrations tr JOIN tournaments t ON tr.tournament_id = t.id WHERE tr.user_id = ?`),
};

// Announcement operations
const announcementOps = {
  create: db.prepare(`
    INSERT INTO announcements (id, title, content, type, target_audience, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getAll: db.prepare(`SELECT a.*, u.username as creator_name FROM announcements a LEFT JOIN users u ON a.created_by = u.id ORDER BY a.created_at DESC`),
  getActive: db.prepare(`
    SELECT a.*, u.username as creator_name
    FROM announcements a
    LEFT JOIN users u ON a.created_by = u.id
    WHERE a.is_active = 1 AND (a.expires_at IS NULL OR a.expires_at > ?)
    ORDER BY a.created_at DESC
  `),
  getById: db.prepare(`SELECT a.*, u.username as creator_name FROM announcements a LEFT JOIN users u ON a.created_by = u.id WHERE a.id = ?`),
  update: db.prepare(`
    UPDATE announcements SET title = ?, content = ?, type = ?, target_audience = ?, expires_at = ?, is_active = ? WHERE id = ?
  `),
  delete: db.prepare(`DELETE FROM announcements WHERE id = ?`),
  deactivateExpired: db.prepare(`UPDATE announcements SET is_active = 0 WHERE expires_at IS NOT NULL AND expires_at < ?`),
};

// Admin stats
const adminStatsOps = {
  getOverview: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM users WHERE registration_status = 'pending') as pending_users,
      (SELECT COUNT(*) FROM users WHERE registration_status = 'approved') as approved_users,
      (SELECT COUNT(*) FROM rooms) as total_rooms,
      (SELECT COUNT(*) FROM rooms WHERE status = 'playing') as active_rooms,
      (SELECT COUNT(*) FROM rooms WHERE status = 'waiting') as waiting_rooms,
      (SELECT COUNT(*) FROM games) as total_games,
      (SELECT COUNT(*) FROM tournaments) as total_tournaments,
      (SELECT COUNT(*) FROM tournaments WHERE status = 'ongoing') as active_tournaments,
      (SELECT COUNT(*) FROM announcements WHERE is_active = 1) as active_announcements
  `),
};

module.exports = {
  db,
  userOps,
  statsOps,
  gameOps,
  roomOps,
  tournamentOps,
  announcementOps,
  adminStatsOps,
  generateRoomCode,
  hashPassword,
  verifyPassword,
};