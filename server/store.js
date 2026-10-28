'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Tiny dependency-free JSON store.
 * Keeps everything in memory and writes an atomic snapshot after each mutation.
 * Good enough for an MVP; swap for Postgres/Supabase when traffic grows.
 */

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (fs.existsSync('/data') ? '/data' : path.join(ROOT, 'data'));

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(DATA_DIR, 'uploads');

const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EMPTY = {
  users: [],
  videos: [],
  likes: [],
  follows: [],
  blocks: [],
  reports: [],
};

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY, ...parsed };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[store] Could not read db.json, starting empty:', err.message);
    }
    return { ...EMPTY };
  }
}

const db = load();

function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function now() {
  return new Date().toISOString();
}

/** JWT secret: env first, otherwise generated once and stored outside the repo. */
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, 'jwt.secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

function slugifyHandle(input) {
  const base = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 20);
  return base || 'creator' + crypto.randomBytes(2).toString('hex');
}

function uniqueHandle(base) {
  let handle = slugifyHandle(base);
  let n = 1;
  while (db.users.some((u) => u.handle === handle)) {
    handle = slugifyHandle(base).slice(0, 16) + (n++);
  }
  return handle;
}

module.exports = {
  db,
  persist,
  id,
  now,
  jwtSecret,
  slugifyHandle,
  uniqueHandle,
  DATA_DIR,
  UPLOAD_DIR,
  DB_FILE,
};
