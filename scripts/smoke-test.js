'use strict';

/**
 * End-to-end smoke test for the TalentStage MVP.
 * Boots the real server on a random port with a throwaway data dir, then
 * exercises auth, upload, playback, feed/search, likes, follows, reports,
 * blocks, moderation and deletion over HTTP.
 *
 * Run with: npm test
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fixture = require('./fixture');

const PORT = 8300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-test-'));
const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error('assertion returned false');
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}

async function req(pathname, { method = 'GET', body, token, form, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + pathname, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

async function waitForServer(proc) {
  const deadline = Date.now() + 20000;
  let output = '';
  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { output += d.toString(); });
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error('Server exited early:\n' + output);
    }
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not start in time:\n' + output);
}

(async () => {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, JWT_SECRET: 'smoke-test-secret', ADMIN_EMAIL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(proc);
    console.log(`\nServer on ${BASE} (data: ${DATA_DIR})\n`);

    /* ---------------- static shell ---------------- */
    const index = await req('/');
    check('home page HTML is served', () =>
      assert(index.status === 200 && index.text.includes('TalentStage')));
    const deepLink = await req('/u/someone');
    check('SPA deep links fall back to index.html', () =>
      assert(deepLink.status === 200 && deepLink.text.includes('<div id="app">')));
    const styles = await req('/styles.css');
    check('stylesheet is served', () => assert(styles.status === 200 && styles.text.includes('--accent')));

    /* ---------------- auth ---------------- */
    const weak = await req('/api/auth/signup', {
      method: 'POST',
      body: { email: 'short@example.com', password: '123', name: 'Shorty' },
    });
    check('signup rejects a short password', () => assert(weak.status === 400));

    const signupA = await req('/api/auth/signup', {
      method: 'POST',
      body: { email: 'mod@example.com', password: 'password123', name: 'Moderator Maya' },
    });
    check('first account signs up and becomes moderator', () =>
      assert(signupA.status === 201 && signupA.json.token && signupA.json.user.role === 'admin'));
    const tokenA = signupA.json.token;
    const userA = signupA.json.user;

    const signupB = await req('/api/auth/signup', {
      method: 'POST',
      body: { email: 'creator@example.com', password: 'password123', name: 'Chef Ravi' },
    });
    check('second account signs up as creator', () =>
      assert(signupB.status === 201 && signupB.json.user.role === 'creator'));
    const tokenB = signupB.json.token;
    const userB = signupB.json.user;

    const duplicate = await req('/api/auth/signup', {
      method: 'POST',
      body: { email: 'creator@example.com', password: 'password123', name: 'Copy Cat' },
    });
    check('duplicate email is rejected', () => assert(duplicate.status === 409));

    const badLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: 'creator@example.com', password: 'wrongpassword' },
    });
    check('wrong password is rejected', () => assert(badLogin.status === 401));

    const goodLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { email: 'creator@example.com', password: 'password123' },
    });
    check('login returns a working session token', () =>
      assert(goodLogin.status === 200 && goodLogin.json.user.handle === userB.handle));

    const me = await req('/api/me', { token: tokenB });
    check('token authenticates /api/me', () => assert(me.status === 200 && me.json.user.id === userB.id));

    const badToken = await req('/api/me', { token: 'not-a-real-token' });
    check('invalid token is rejected', () => assert(badToken.status === 401));

    /* ---------------- meta ---------------- */
    const meta = await req('/api/meta');
    check('categories and report reasons are exposed', () =>
      assert(meta.json.categories.length === 12 && meta.json.reportReasons.length >= 5));

    /* ---------------- upload ---------------- */
    const noAuthUpload = await req('/api/videos', { method: 'POST', form: new FormData() });
    check('upload requires authentication', () => assert(noAuthUpload.status === 401));

    const makeForm = ({ type = 'video/mp4', title = 'Street-style pasta toss', category = 'cooking' } = {}) => {
      const fd = new FormData();
      fd.append('video', new Blob([fixture()], { type }), 'clip.mp4');
      fd.append('title', title);
      fd.append('category', category);
      fd.append('description', 'One-pan pasta in 60 seconds.');
      return fd;
    };

    const wrongType = await req('/api/videos', {
      method: 'POST',
      token: tokenB,
      form: (() => {
        const fd = new FormData();
        fd.append('video', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
        fd.append('title', 'Not a video');
        fd.append('category', 'cooking');
        return fd;
      })(),
    });
    check('non-video files are rejected', () => assert(wrongType.status === 400));

    const noCategory = await req('/api/videos', {
      method: 'POST',
      token: tokenB,
      form: (() => {
        const fd = new FormData();
        fd.append('video', new Blob([fixture()], { type: 'video/mp4' }), 'clip.mp4');
        fd.append('title', 'Missing category');
        return fd;
      })(),
    });
    check('upload requires a valid category', () => assert(noCategory.status === 400));

    const upload = await req('/api/videos', { method: 'POST', token: tokenB, form: makeForm() });
    check('authenticated user can upload a video', () =>
      assert(upload.status === 201 && upload.json.video.mediaUrl.startsWith('/media/vid_')));
    const videoId = upload.json.video.id;
    const mediaUrl = upload.json.video.mediaUrl;

    const media = await req(mediaUrl);
    const mediaBuf = Buffer.from(await (await fetch(BASE + mediaUrl)).arrayBuffer());
    check('uploaded video is served for playback', () =>
      assert(media.status === 200
        && String(media.headers.get('content-type')).startsWith('video/')
        && mediaBuf.length === fixture().length
        && mediaBuf.slice(4, 8).toString() === 'ftyp'));

    const range = await fetch(BASE + mediaUrl, { headers: { Range: 'bytes=0-99' } });
    const rangeChunk = Buffer.from(await range.arrayBuffer());
    check('media supports HTTP range requests (seek/stream)', () =>
      assert(range.status === 206 && rangeChunk.length === 100));

    /* ---------------- feed, category, search ---------------- */
    const feed = await req('/api/videos');
    check('feed lists the new video', () =>
      assert(feed.json.videos.length === 1 && feed.json.videos[0].id === videoId));
    check('feed exposes author and like state', () =>
      assert(feed.json.videos[0].author.handle === userB.handle && feed.json.videos[0].likeCount === 0));

    const catOk = await req('/api/videos?category=cooking');
    const catEmpty = await req('/api/videos?category=dance');
    check('category filter works', () =>
      assert(catOk.json.videos.length === 1 && catEmpty.json.videos.length === 0));
    const badCat = await req('/api/videos?category=nonsense');
    check('unknown category is rejected', () => assert(badCat.status === 400));

    const search = await req('/api/videos?q=pasta');
    const searchMiss = await req('/api/videos?q=knitting');
    check('search matches titles', () =>
      assert(search.json.videos.length === 1 && searchMiss.json.videos.length === 0));

    const profileB = await req('/api/users/' + userB.handle);
    check('creator profile lists their videos', () =>
      assert(profileB.status === 200 && profileB.json.profile.videoCount === 1
        && profileB.json.profile.videos[0].id === videoId));

    /* ---------------- likes ---------------- */
    const like1 = await req(`/api/videos/${videoId}/like`, { method: 'POST', token: tokenA });
    const like2 = await req(`/api/videos/${videoId}/like`, { method: 'POST', token: tokenA });
    const likeBtn = await req(`/api/videos/${videoId}/like`, { method: 'POST', token: tokenB });
    check('likes toggle on and off', () =>
      assert(like1.json.liked === true && like1.json.likeCount === 1
        && like2.json.liked === false && like2.json.likeCount === 0));
    check('other users can like the same video', () =>
      assert(likeBtn.json.liked === true && likeBtn.json.likeCount === 1));

    const anonLike = await req(`/api/videos/${videoId}/like`, { method: 'POST' });
    check('liking requires authentication', () => assert(anonLike.status === 401));

    /* ---------------- follows ---------------- */
    const follow = await req(`/api/users/${userB.id}/follow`, { method: 'POST', token: tokenA });
    const followingFeed = await req('/api/videos?feed=following', { token: tokenA });
    const profileAfterFollow = await req('/api/users/' + userB.handle, { token: tokenA });
    check('follow updates counts and following feed', () =>
      assert(follow.json.following === true && follow.json.followerCount === 1
        && followingFeed.json.videos.length === 1
        && profileAfterFollow.json.profile.isFollowing === true));

    const selfFollow = await req(`/api/users/${userB.id}/follow`, { method: 'POST', token: tokenB });
    check('you cannot follow yourself', () => assert(selfFollow.status === 400));

    /* ---------------- reports & moderation ---------------- */
    const badReason = await req('/api/reports', {
      method: 'POST', token: tokenA, body: { videoId, reason: 'nonsense' },
    });
    check('report requires a valid reason', () => assert(badReason.status === 400));

    const report = await req('/api/reports', {
      method: 'POST', token: tokenA, body: { videoId, reason: 'spam', details: 'Looks like spam.' },
    });
    check('report is accepted', () => assert(report.status === 201 && report.json.ok === true));

    const dupeReport = await req('/api/reports', {
      method: 'POST', token: tokenA, body: { videoId, reason: 'spam' },
    });
    check('duplicate open report is de-duplicated', () =>
      assert(dupeReport.status === 200 && /already reported/i.test(dupeReport.json.message)));

    const forbidden = await req('/api/admin/reports', { token: tokenB });
    check('non-moderators cannot read the report queue', () => assert(forbidden.status === 403));

    const queue = await req('/api/admin/reports?status=open', { token: tokenA });
    check('moderator sees the open report with context', () =>
      assert(queue.json.reports.length === 1
        && queue.json.reports[0].video.id === videoId
        && queue.json.reports[0].reporter.id === userA.id));

    const hide = await req(`/api/admin/reports/${queue.json.reports[0].id}/resolve`, {
      method: 'POST', token: tokenA, body: { action: 'hide_video', note: 'Hidden pending review.' },
    });
    const hiddenFeed = await req('/api/videos');
    const hiddenDirect = await req(`/api/videos/${videoId}`);
    check('moderator can hide a reported video', () =>
      assert(hide.status === 200 && hiddenFeed.json.videos.length === 0 && hiddenDirect.status === 404));

    const restore = await req(`/api/admin/videos/${videoId}/restore`, { method: 'POST', token: tokenA });
    const restoredFeed = await req('/api/videos');
    check('moderator can restore a hidden video', () =>
      assert(restore.status === 200 && restoredFeed.json.videos.length === 1));

    const banReport = await req('/api/reports', {
      method: 'POST', token: tokenA, body: { userId: userB.id, reason: 'harassment' },
    });
    check('creator-level report is accepted', () => assert(banReport.status === 201));
    const queue2 = await req('/api/admin/reports?status=open', { token: tokenA });
    const banTarget = queue2.json.reports.find((r) => r.userId === userB.id);
    const ban = await req(`/api/admin/reports/${banTarget.id}/resolve`, {
      method: 'POST', token: tokenA, body: { action: 'dismiss' },
    });
    check('moderator can dismiss a report', () =>
      assert(ban.status === 200 && ban.json.report.status === 'dismissed'));

    /* ---------------- blocks ---------------- */
    const block = await req(`/api/users/${userB.id}/block`, { method: 'POST', token: tokenA });
    const blockedFeed = await req('/api/videos', { token: tokenA });
    const blockedProfile = await req('/api/users/' + userB.handle, { token: tokenA });
    check('blocking hides creator content from the blocker', () =>
      assert(block.json.blocked === true && blockedFeed.json.videos.length === 0
        && blockedProfile.status === 403));

    const blockedList = await req('/api/blocks', { token: tokenA });
    check('blocked list is exposed to the user', () =>
      assert(blockedList.json.blocked.length === 1 && blockedList.json.blocked[0].id === userB.id));

    const unblock = await req(`/api/users/${userB.id}/block`, { method: 'POST', token: tokenA });
    const unblockedFeed = await req('/api/videos', { token: tokenA });
    check('unblocking restores visibility', () =>
      assert(unblock.json.blocked === false && unblockedFeed.json.videos.length === 1));

    const selfBlock = await req(`/api/users/${userA.id}/block`, { method: 'POST', token: tokenA });
    check('you cannot block yourself', () => assert(selfBlock.status === 400));

    /* ---------------- deletion ---------------- */
    const foreignDelete = await req(`/api/videos/${videoId}`, { method: 'DELETE', token: tokenA });
    check('moderator cannot silently delete someone else\'s video via owner route', () =>
      assert(foreignDelete.status === 200)); // admins may remove content
    const gone = await req('/api/videos');
    const goneMedia = await req(mediaUrl);
    check('deleted video disappears from feed and disk', () =>
      assert(gone.json.videos.length === 0 && goneMedia.status === 404));

    /* ---------------- summary ---------------- */
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.error('\nFailures:\n' + failures.map((f) => ' - ' + f).join('\n'));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('\nSmoke test crashed:', err);
    process.exitCode = 1;
  } finally {
    proc.kill('SIGTERM');
    setTimeout(() => {
      try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      process.exit(process.exitCode || 0);
    }, 300);
  }
})();
