import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL || '';
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.json');

/* ================= JSON Store (default — tanpa setup apa pun) ================= */
class JsonStore {
  constructor() {
    this.data = { users: [], sessions: {}, chats: {} };
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      if (fs.existsSync(DB_PATH)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
    } catch { /* mulai dari kosong */ }
  }
  persist() {
    const tmp = DB_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, DB_PATH); // tulis atomik
  }
  async findUserByUsername(u) { return this.data.users.find(x => x.username.toLowerCase() === u.toLowerCase()) || null; }
  async findUserById(id) { return this.data.users.find(x => x.id === id) || null; }
  async findUserByGoogleId(gid) { return this.data.users.find(x => x.googleId === gid) || null; }
  async createUser({ username, passHash = null, googleId = null }) {
    const user = { id: crypto.randomUUID(), username, passHash, googleId, createdAt: Date.now() };
    this.data.users.push(user); this.persist(); return user;
  }
  async createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions[token] = { userId, exp: Date.now() + 30 * 24 * 3600 * 1000 };
    this.persist(); return token;
  }
  async getSession(token) {
    const s = this.data.sessions[token];
    if (!s) return null;
    if (s.exp < Date.now()) { delete this.data.sessions[token]; this.persist(); return null; }
    return s;
  }
  async deleteSession(token) { delete this.data.sessions[token]; this.persist(); }
  async getChats(userId) { return this.data.chats[userId] || []; }
  async saveChats(userId, chats) { this.data.chats[userId] = chats; this.persist(); }
}

/* ================= PostgreSQL Store (aktif jika DATABASE_URL diisi) ================= */
class PgStore {
  async init() {
    const { Pool } = await import('pg');
    this.pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id        TEXT PRIMARY KEY,
        username  TEXT UNIQUE NOT NULL,
        pass_hash TEXT,
        google_id TEXT,
        created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        token   TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        exp     BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        data    JSONB NOT NULL);`);
    return this;
  }
  async findUserByUsername(u) {
    return (await this.pool.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [u])).rows[0] || null;
  }
  async findUserById(id) {
    return (await this.pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0] || null;
  }
  async findUserByGoogleId(gid) {
    return (await this.pool.query('SELECT * FROM users WHERE google_id=$1', [gid])).rows[0] || null;
  }
  async createUser({ username, passHash = null, googleId = null }) {
    const id = crypto.randomUUID(), now = Date.now();
    await this.pool.query(
      'INSERT INTO users(id,username,pass_hash,google_id,created_at) VALUES($1,$2,$3,$4,$5)',
      [id, username, passHash, googleId, now]);
    return { id, username, passHash, googleId, createdAt: now };
  }
  async createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await this.pool.query('INSERT INTO sessions(token,user_id,exp) VALUES($1,$2,$3)',
      [token, userId, Date.now() + 30 * 24 * 3600 * 1000]);
    return token;
  }
  async getSession(token) {
    const s = (await this.pool.query('SELECT * FROM sessions WHERE token=$1', [token])).rows[0];
    if (!s) return null;
    if (Number(s.exp) < Date.now()) {
      await this.pool.query('DELETE FROM sessions WHERE token=$1', [token]);
      return null;
    }
    return s;
  }
  async deleteSession(token) { await this.pool.query('DELETE FROM sessions WHERE token=$1', [token]); }
  async getChats(userId) {
    return (await this.pool.query('SELECT data FROM chats WHERE user_id=$1', [userId])).rows[0]?.data || [];
  }
  async saveChats(userId, chats) {
    await this.pool.query(
      `INSERT INTO chats(user_id,data) VALUES($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET data=$2`,
      [userId, JSON.stringify(chats)]);
  }
}

export const db = DATABASE_URL ? await new PgStore().init() : new JsonStore();
console.log(`  💾 Database: ${DATABASE_URL ? 'PostgreSQL' : 'JSON file (' + DB_PATH + ')'}`);
