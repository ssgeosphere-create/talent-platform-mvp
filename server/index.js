'use strict';

const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./store');
const {
  CATEGORIES, CATEGORY_SLUGS, REPORT_REASONS, REASON_SLUGS, AVATAR_COLORS,
} = require('./constants');

const { db, persist, id, now, jwtSecret, uniqueHandle, UPLOAD_DIR } = store;

const app = express();
const PORT = Number(process.env.PORT || 80);
const MAX_VIDEO_BYTES = 80 * 1024 * 1024; // 80 MB free-tier friendly cap
const TOKEN_TTL = '30d';

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const publicUser = (u) => u && ({
  id: u.id,
  name: u.name,
  handle: u.handle,
  bio: u.bio || '',
  avatarColor: u.avatarColor,
  role: u.role,
  createdAt: u.createdAt,
});

const findUser = (uid) => db.users.find((u) => u.id === uid);
const findUserByHandle = (handle) => db.users.find((u) => u.handle === String(handle).toLowerCase());

function isBlockedBetween(a, b) {
  if (!a || !b) return false;
  return db.blocks.some(
    (x) => (x.userId === a && x.blockedUserId === b) || (x.userId === b && x.blockedUserId === a),
  );
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, jwtSecret(), { expiresIn: TOKEN_TTL });
}

function authOptional(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret());
      const user = findUser(payload.sub);
      if (user && !user.banned) req.user = user;
    } catch {
      /* invalid token -> stay anonymous */
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only.' });
  next();
}

function videoStats(videoId) {
  return {
    likes: db.likes.filter((l) => l.videoId === videoId).length,
    reports: db.reports.filter((r) => r.videoId === videoId && r.status === 'open').length,
  };
}

function serializeVideo(video, viewer) {
  const author = findUser(video.userId);
  const stats = videoStats(video.id);
  return {
    id: video.id,
    title: video.title,
    description: video.description || '',
    category: video.category,
    categoryName: (CATEGORIES.find((c) => c.slug === video.category) || {}).name || video.category,
    createdAt: video.createdAt,
    mediaUrl: '/media/' + video.filename,
    mime: video.mime,
    size: video.size,
    hidden: !!video.hidden,
    removed: !!video.removed,
    author: publicUser(author),
    likeCount: stats.likes,
    likedByMe: viewer ? db.likes.some((l) => l.videoId === video.id && l.userId === viewer.id) : false,
    mine: viewer ? video.userId === viewer.id : false,
    followingAuthor: viewer
      ? db.follows.some((f) => f.followerId === viewer.id && f.followingId === video.userId)
      : false,
  };
}

function serializeProfile(user, viewer) {
  const followerCount = db.follows.filter((f) => f.followingId === user.id).length;
  const followingCount = db.follows.filter((f) => f.followerId === user.id).length;
  const videos = db.videos
    .filter((v) => v.userId === user.id && !v.removed && !v.hidden)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((v) => serializeVideo(v, viewer));
  return {
    ...publicUser(user),
    followerCount,
    followingCount,
    videoCount: videos.length,
    likeCount: videos.reduce((sum, v) => sum + v.likeCount, 0),
    isFollowing: viewer ? db.follows.some((f) => f.followerId === viewer.id && f.followingId === user.id) : false,
    isBlocked: viewer ? db.blocks.some((b) => b.userId === viewer.id && b.blockedUserId === user.id) : false,
    blockedMe: viewer ? db.blocks.some((b) => b.userId === user.id && b.blockedUserId === viewer.id) : false,
    isMe: viewer ? viewer.id === user.id : false,
    videos,
  };
}

function validCategory(cat) {
  return CATEGORY_SLUGS.includes(cat);
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (String(password || '').length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const cleanName = String(name || '').trim().slice(0, 40);
  if (cleanName.length < 2) return res.status(400).json({ error: 'Tell us your name (2+ characters).' });
  if (db.users.some((u) => u.email === cleanEmail)) {
    return res.status(409).json({ error: 'That email is already registered. Try logging in.' });
  }

  // Bootstrap: the very first account (or ADMIN_EMAIL) becomes the moderator.
  const isFirstUser = db.users.length === 0;
  const isAdminEmail = process.env.ADMIN_EMAIL && cleanEmail === process.env.ADMIN_EMAIL.toLowerCase();

  const user = {
    id: id('usr'),
    email: cleanEmail,
    passwordHash: await bcrypt.hash(String(password), 10),
    name: cleanName,
    handle: uniqueHandle(cleanName),
    bio: '',
    avatarColor: AVATAR_COLORS[db.users.length % AVATAR_COLORS.length],
    role: (isFirstUser || isAdminEmail) ? 'admin' : 'creator',
    banned: false,
    createdAt: now(),
  };
  db.users.push(user);
  persist();
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const user = db.users.find((u) => u.email === cleanEmail);
  const ok = user && await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended by a moderator.' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.patch('/api/me', requireAuth, (req, res) => {
  const { name, bio, avatarColor } = req.body || {};
  if (typeof name === 'string' && name.trim().length >= 2) req.user.name = name.trim().slice(0, 40);
  if (typeof bio === 'string') req.user.bio = bio.trim().slice(0, 300);
  if (typeof avatarColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(avatarColor)) {
    req.user.avatarColor = avatarColor;
  }
  persist();
  res.json({ user: publicUser(req.user) });
});

/* ------------------------------------------------------------------ *
 * Meta
 * ------------------------------------------------------------------ */

app.get('/api/meta', (req, res) => {
  res.json({
    categories: CATEGORIES,
    reportReasons: REPORT_REASONS,
    maxVideoMb: Math.round(MAX_VIDEO_BYTES / (1024 * 1024)),
    user: req.user ? publicUser(req.user) : null,
  });
});

/* ------------------------------------------------------------------ *
 * Videos & feed
 * ------------------------------------------------------------------ */

app.get('/api/videos', authOptional, (req, res) => {
  const { category, q, feed, sort } = req.query;
  const viewer = req.user;
  let items = db.videos.filter((v) => !v.removed && !v.hidden);
  items = items.filter((v) => !viewer || !isBlockedBetween(viewer.id, v.userId));

  if (category && category !== 'all') {
    if (!validCategory(category)) return res.status(400).json({ error: 'Unknown category.' });
    items = items.filter((v) => v.category === category);
  }
  if (q && String(q).trim()) {
    const needle = String(q).trim().toLowerCase();
    items = items.filter((v) =>
      v.title.toLowerCase().includes(needle) ||
      (v.description || '').toLowerCase().includes(needle) ||
      ((findUser(v.userId) || {}).name || '').toLowerCase().includes(needle) ||
      ((findUser(v.userId) || {}).handle || '').toLowerCase().includes(needle));
  }
  if (feed === 'following') {
    if (!viewer) return res.status(401).json({ error: 'Sign in to see creators you follow.' });
    const following = new Set(
      db.follows.filter((f) => f.followerId === viewer.id).map((f) => f.followingId),
    );
    items = items.filter((v) => following.has(v.userId));
  }
  if (sort === 'liked') {
    items = items.slice().sort((a, b) => videoStats(b.id).likes - videoStats(a.id).likes);
  } else {
    items = items.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 48);
  const page = Math.max(Number(req.query.page) || 0, 0);
  const total = items.length;
  const pageItems = items.slice(page * limit, page * limit + limit).map((v) => serializeVideo(v, viewer));
  res.json({ videos: pageItems, total, page, hasMore: (page + 1) * limit < total });
});

app.get('/api/videos/:id', authOptional, (req, res) => {
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video || video.removed) return res.status(404).json({ error: 'Video not found.' });
  if (req.user && isBlockedBetween(req.user.id, video.userId)) {
    return res.status(404).json({ error: 'Video not found.' });
  }
  if (video.hidden && !(req.user && (req.user.role === 'admin' || req.user.id === video.userId))) {
    return res.status(404).json({ error: 'This video is under review.' });
  }
  res.json({ video: serializeVideo(video, req.user) });
});

/* ---------------------------- upload ------------------------------ */

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
      cb(null, id('vid') + ext);
    },
  }),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/^video\//i.test(file.mimetype || '')) {
      return cb(new Error('INVALID_TYPE'));
    }
    cb(null, true);
  },
});

app.post('/api/videos', requireAuth, (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `Video is too large. Maximum size is ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB.`
        : err.message === 'INVALID_TYPE'
          ? 'Please choose a video file (mp4, webm or mov).'
          : 'Upload failed. Please try again.';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a video to upload.' });

    const title = String((req.body && req.body.title) || '').trim().slice(0, 90);
    const description = String((req.body && req.body.description) || '').trim().slice(0, 400);
    const category = String((req.body && req.body.category) || '').trim();

    const fail = (msg) => {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: msg });
    };
    if (title.length < 3) return fail('Give your video a title (3+ characters).');
    if (!validCategory(category)) return fail('Pick a talent category.');

    const video = {
      id: id('vd'),
      userId: req.user.id,
      title,
      description,
      category,
      filename: req.file.filename,
      mime: req.file.mimetype,
      size: req.file.size,
      hidden: false,
      removed: false,
      createdAt: now(),
    };
    db.videos.push(video);
    persist();
    res.status(201).json({ video: serializeVideo(video, req.user) });
  });
});

app.delete('/api/videos/:id', requireAuth, (req, res) => {
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (video.userId !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only delete your own videos.' });
  }
  video.removed = true;
  persist();
  fs.unlink(path.join(UPLOAD_DIR, video.filename), () => {});
  res.json({ ok: true });
});

/* ---------------------------- likes ------------------------------- */

app.post('/api/videos/:id/like', requireAuth, (req, res) => {
  const video = db.videos.find((v) => v.id === req.params.id && !v.removed);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  if (isBlockedBetween(req.user.id, video.userId)) {
    return res.status(403).json({ error: 'Unavailable.' });
  }
  const existing = db.likes.findIndex((l) => l.videoId === video.id && l.userId === req.user.id);
  let liked;
  if (existing >= 0) {
    db.likes.splice(existing, 1);
    liked = false;
  } else {
    db.likes.push({ id: id('like'), videoId: video.id, userId: req.user.id, createdAt: now() });
    liked = true;
  }
  persist();
  res.json({ liked, likeCount: db.likes.filter((l) => l.videoId === video.id).length });
});

/* --------------------------- follows ------------------------------ */

app.post('/api/users/:id/follow', requireAuth, (req, res) => {
  const target = findUser(req.params.id);
  if (!target) return res.status(404).json({ error: 'Creator not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself.' });
  if (isBlockedBetween(req.user.id, target.id)) return res.status(403).json({ error: 'Unavailable.' });
  const idx = db.follows.findIndex(
    (f) => f.followerId === req.user.id && f.followingId === target.id,
  );
  let following;
  if (idx >= 0) {
    db.follows.splice(idx, 1);
    following = false;
  } else {
    db.follows.push({ id: id('flw'), followerId: req.user.id, followingId: target.id, createdAt: now() });
    following = true;
  }
  persist();
  res.json({ following, followerCount: db.follows.filter((f) => f.followingId === target.id).length });
});

app.get('/api/users/:handle', authOptional, (req, res) => {
  const user = findUserByHandle(req.params.handle);
  if (!user) return res.status(404).json({ error: 'Creator not found.' });
  if (req.user && isBlockedBetween(req.user.id, user.id) && req.user.id !== user.id) {
    return res.status(403).json({ error: 'This profile is unavailable.' });
  }
  res.json({ profile: serializeProfile(user, req.user) });
});

app.get('/api/creators', authOptional, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let users = db.users.filter((u) => !u.banned);
  if (q) {
    users = users.filter((u) => u.name.toLowerCase().includes(q) || u.handle.includes(q));
  }
  const items = users
    .slice()
    .sort((a, b) => db.follows.filter((f) => f.followingId === b.id).length
      - db.follows.filter((f) => f.followingId === a.id).length)
    .slice(0, 30)
    .map((u) => {
      const p = serializeProfile(u, req.user);
      return {
        id: p.id, name: p.name, handle: p.handle, avatarColor: p.avatarColor,
        bio: p.bio, followerCount: p.followerCount, videoCount: p.videoCount,
      };
    });
  res.json({ creators: items });
});

/* --------------------------- reports ------------------------------ */

app.post('/api/reports', requireAuth, (req, res) => {
  const { videoId, userId, reason, details } = req.body || {};
  if (!REASON_SLUGS.includes(reason)) return res.status(400).json({ error: 'Choose a reason.' });
  if (!videoId && !userId) return res.status(400).json({ error: 'Nothing to report.' });
  const video = videoId ? db.videos.find((v) => v.id === videoId && !v.removed) : null;
  const targetUser = userId ? findUser(userId) : null;
  if (videoId && !video) return res.status(404).json({ error: 'Video not found.' });
  if (userId && !targetUser) return res.status(404).json({ error: 'Creator not found.' });

  const duplicate = db.reports.find((r) => r.status === 'open'
    && r.reporterId === req.user.id && r.videoId === (videoId || null)
    && r.userId === (userId || null));
  if (duplicate) return res.status(200).json({ ok: true, message: 'You already reported this. Our team is on it.' });

  db.reports.push({
    id: id('rpt'),
    reporterId: req.user.id,
    videoId: videoId || null,
    userId: userId || null,
    videoOwnerId: video ? video.userId : null,
    reason,
    details: String(details || '').trim().slice(0, 500),
    status: 'open',
    createdAt: now(),
    resolvedAt: null,
    resolution: null,
  });
  persist();
  res.status(201).json({ ok: true, message: 'Thanks — a moderator will review this.' });
});

/* ---------------------------- blocks ------------------------------ */

app.post('/api/users/:id/block', requireAuth, (req, res) => {
  const target = findUser(req.params.id);
  if (!target) return res.status(404).json({ error: 'Creator not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot block yourself.' });
  const idx = db.blocks.findIndex((b) => b.userId === req.user.id && b.blockedUserId === target.id);
  let blocked;
  if (idx >= 0) {
    db.blocks.splice(idx, 1);
    blocked = false;
  } else {
    db.blocks.push({ id: id('blk'), userId: req.user.id, blockedUserId: target.id, createdAt: now() });
    // Blocking someone you follow also unfollows them.
    db.follows = db.follows.filter(
      (f) => !(f.followerId === req.user.id && f.followingId === target.id),
    );
    blocked = true;
  }
  persist();
  res.json({ blocked });
});

app.get('/api/blocks', requireAuth, (req, res) => {
  const items = db.blocks
    .filter((b) => b.userId === req.user.id)
    .map((b) => {
      const u = findUser(b.blockedUserId);
      return u ? { ...publicUser(u), blockedAt: b.createdAt } : null;
    })
    .filter(Boolean);
  res.json({ blocked: items });
});

/* ------------------------------------------------------------------ *
 * Admin moderation
 * ------------------------------------------------------------------ */

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const status = String(req.query.status || 'open');
  const reports = db.reports
    .filter((r) => (status === 'all' ? true : r.status === status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const video = r.videoId ? db.videos.find((v) => v.id === r.videoId) : null;
      return {
        ...r,
        reporter: publicUser(findUser(r.reporterId)),
        video: video ? serializeVideo(video, req.user) : null,
        targetUser: publicUser(findUser(r.userId || r.videoOwnerId)),
        reasonLabel: (REPORT_REASONS.find((x) => x.slug === r.reason) || {}).label || r.reason,
      };
    });
  res.json({ reports, openCount: db.reports.filter((r) => r.status === 'open').length });
});

app.post('/api/admin/reports/:id/resolve', requireAdmin, (req, res) => {
  const report = db.reports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  const { action, note } = req.body || {};
  if (!['dismiss', 'hide_video', 'ban_user', 'restore_video'].includes(action)) {
    return res.status(400).json({ error: 'Unknown moderation action.' });
  }

  if (action === 'hide_video') {
    const video = db.videos.find((v) => v.id === report.videoId);
    if (video) video.hidden = true;
  }
  if (action === 'restore_video') {
    const video = db.videos.find((v) => v.id === report.videoId);
    if (video) video.hidden = false;
  }
  if (action === 'ban_user') {
    const target = findUser(report.userId || report.videoOwnerId);
    if (target && target.role !== 'admin') {
      target.banned = true;
      db.videos.filter((v) => v.userId === target.id).forEach((v) => { v.hidden = true; });
    }
  }

  report.status = action === 'dismiss' ? 'dismissed' : 'resolved';
  report.resolution = { action, note: String(note || '').slice(0, 300), at: now(), by: req.user.id };
  report.resolvedAt = now();
  persist();
  res.json({ ok: true, report });
});

app.post('/api/admin/videos/:id/hide', requireAdmin, (req, res) => {
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  video.hidden = true;
  persist();
  res.json({ ok: true, video: serializeVideo(video, req.user) });
});

app.post('/api/admin/videos/:id/restore', requireAdmin, (req, res) => {
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });
  video.hidden = false;
  persist();
  res.json({ ok: true, video: serializeVideo(video, req.user) });
});

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  res.json({
    users: db.users.length,
    videos: db.videos.filter((v) => !v.removed).length,
    hiddenVideos: db.videos.filter((v) => v.hidden && !v.removed).length,
    openReports: db.reports.filter((r) => r.status === 'open').length,
    likes: db.likes.length,
    follows: db.follows.length,
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, time: now() }));

/* ------------------------------------------------------------------ *
 * Static media + SPA
 * ------------------------------------------------------------------ */

app.use('/media', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  },
  fallthrough: true,
}));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TalentStage MVP listening on http://0.0.0.0:${PORT}`);
    console.log(`Data dir: ${store.DATA_DIR}`);
    if (db.users.length === 0) {
      console.log('No accounts yet — the first sign-up becomes the moderator account.');
    }
  });
}

module.exports = app;
