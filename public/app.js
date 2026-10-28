'use strict';

/* TalentStage — vanilla JS SPA (no build step, works offline after first load) */

const view = document.getElementById('view');
const topbarActions = document.getElementById('topbar-actions');
const tabbar = document.getElementById('tabbar');
const toastEl = document.getElementById('toast');

const state = {
  token: localStorage.getItem('ts_token') || '',
  user: null,
  meta: { categories: [], reportReasons: [], maxVideoMb: 80 },
  feed: { category: 'all', tab: 'latest', q: '' },
  renderId: 0,
  observer: null,
};

/* ------------------------------ utils ------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function avatar(user, size = '') {
  return `<div class="avatar ${size}" style="background:${esc(user.avatarColor || '#6366f1')}">${esc(initials(user.name))}</div>`;
}

function timeAgo(iso) {
  const secs = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (state.token) opts.headers.Authorization = 'Bearer ' + state.token;
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* non-json */ }
  if (res.status === 401 && state.token) {
    setSession('', null);
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function setSession(token, user) {
  state.token = token || '';
  state.user = user || null;
  if (token) localStorage.setItem('ts_token', token);
  else localStorage.removeItem('ts_token');
  renderTopbar();
}

function route(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

/* --------------------------- modal sheet --------------------------- */

function openSheet(html, onMount) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  if (onMount) onMount($('.sheet', backdrop), close);
  return { close };
}

function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = true, onConfirm }) {
  openSheet(`
    <h2>${esc(title)}</h2>
    <p class="sheet-sub">${esc(message)}</p>
    <div class="stack">
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" data-confirm>${esc(confirmLabel)}</button>
      <button class="btn btn-ghost btn-block" data-cancel>Cancel</button>
    </div>
  `, (sheet, close) => {
    $('[data-cancel]', sheet).onclick = close;
    $('[data-confirm]', sheet).onclick = async () => {
      const btn = $('[data-confirm]', sheet);
      btn.disabled = true;
      try { await onConfirm(); close(); } catch (err) { btn.disabled = false; toast(err.message); }
    };
  });
}

/* ----------------------------- topbar ----------------------------- */

function renderTopbar() {
  if (state.user) {
    topbarActions.innerHTML = `
      ${state.user.role === 'admin' ? '<a class="btn btn-sm btn-ghost" href="#/admin">Moderation</a>' : ''}
      <a href="#/me" aria-label="Your profile">${avatar(state.user, 'sm')}</a>`;
  } else {
    topbarActions.innerHTML = '<a class="btn btn-sm btn-primary" href="#/auth">Log in</a>';
  }
}

/* ------------------------------ feed ------------------------------ */

function videoCard(v) {
  return `
    <article class="video-card paused" data-video-id="${esc(v.id)}">
      <video src="${esc(v.mediaUrl)}" muted loop playsinline preload="metadata"></video>
      <div class="play-badge">▶</div>
      <div class="overlay">
        <div class="author-row">
          <a href="#/u/${esc(v.author.handle)}" class="author-row" aria-label="Open ${esc(v.author.name)} profile">
            ${avatar(v.author, 'sm')}
            <span class="small" style="font-weight:700">@${esc(v.author.handle)}</span>
          </a>
          <span class="badge">${esc(v.categoryName)}</span>
        </div>
        <h3 class="video-title">${esc(v.title)}</h3>
        <div class="video-meta">${esc(timeAgo(v.createdAt))}${v.hidden ? ' · under review' : ''}</div>
      </div>
      <div class="side-actions">
        <button class="side-btn ${v.likedByMe ? 'active' : ''}" data-like aria-label="Like video">
          ♥<span data-like-count>${v.likeCount}</span>
        </button>
        <button class="side-btn" data-more aria-label="More options">⋯</button>
      </div>
    </article>`;
}

function setupFeedVideos(root) {
  if (state.observer) state.observer.disconnect();
  const cards = $$('.video-card', root);
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const video = $('video', entry.target);
      if (!video) return;
      if (entry.isIntersecting && entry.intersectionRatio > 0.55) {
        video.play().then(() => entry.target.classList.remove('paused')).catch(() => {});
      } else {
        video.pause();
        entry.target.classList.add('paused');
      }
    });
  }, { threshold: [0, 0.55, 0.9] });

  cards.forEach((card) => {
    observer.observe(card);
    const video = $('video', card);
    const toggle = () => {
      if (video.paused) { video.play().then(() => card.classList.remove('paused')).catch(() => {}); }
      else { video.pause(); card.classList.add('paused'); }
    };
    video.addEventListener('click', toggle);
    $('.play-badge', card).addEventListener('click', toggle);
    $('.overlay', card).addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      route('/v/' + card.dataset.videoId);
    });
    card.querySelector('[data-like]').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLike(card.dataset.videoId, card.querySelector('[data-like]'));
    });
    card.querySelector('[data-more]').addEventListener('click', (e) => {
      e.stopPropagation();
      openVideoMenu(card.dataset.videoId);
    });
  });
  state.observer = observer;
}



/* --------------------------- interactions -------------------------- */

async function toggleLike(videoId, button) {
  if (!state.user) { toast('Log in to like videos.'); return route('/auth?next=/v/' + videoId); }
  const countEl = button.querySelector('[data-like-count]');
  button.disabled = true;
  try {
    const { liked, likeCount } = await api(`/videos/${videoId}/like`, { method: 'POST' });
    button.classList.toggle('active', liked);
    if (countEl) countEl.textContent = likeCount;
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function toggleFollow(userId, button) {
  if (!state.user) { toast('Log in to follow creators.'); return route('/auth'); }
  button.disabled = true;
  try {
    const { following, followerCount } = await api(`/users/${userId}/follow`, { method: 'POST' });
    button.textContent = following ? 'Following' : 'Follow';
    button.classList.toggle('btn-primary', !following);
    button.classList.toggle('btn-ghost', following);
    const count = document.querySelector('[data-follower-count]');
    if (count) count.textContent = followerCount;
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function openVideoMenu(videoId) {
  let video;
  try {
    ({ video } = await api('/videos/' + videoId));
  } catch (err) { return toast(err.message); }

  const isMine = state.user && video.author.id === state.user.id;
  const isAdmin = state.user && state.user.role === 'admin';

  openSheet(`
    <div class="row" style="margin-bottom:14px">
      ${avatar(video.author)}
      <div style="min-width:0">
        <div style="font-weight:700">@${esc(video.author.handle)}</div>
        <div class="muted small">${esc(video.title)}</div>
      </div>
    </div>
    <div class="option-list">
      <button class="option" data-act="report-video">🚩 Report this video</button>
      ${!isMine && state.user ? '<button class="option" data-act="block">🚫 Block this creator</button>' : ''}
      ${!isMine && state.user ? '<button class="option" data-act="report-user">⚠️ Report this creator</button>' : ''}
      <button class="option" data-act="copy">🔗 Copy link</button>
      ${isMine ? '<button class="option" data-act="delete" style="color:#fca5a5">🗑 Delete my video</button>' : ''}
      ${isAdmin && video.hidden ? '<button class="option" data-act="restore">♻️ Restore video (admin)</button>' : ''}
      ${isAdmin && !video.hidden ? '<button class="option" data-act="hide">🙈 Hide video (admin)</button>' : ''}
    </div>
  `, (sheet, close) => {
    const go = (fn) => async () => { close(); await fn(); };
    const reportVideo = $('[data-act="report-video"]', sheet);
    if (reportVideo) reportVideo.onclick = go(() => openReportSheet({ videoId, title: video.title }));
    const blockBtn = $('[data-act="block"]', sheet);
    if (blockBtn) blockBtn.onclick = go(() => confirmSheet({
      title: 'Block @' + video.author.handle + '?',
      message: 'You will no longer see their videos, and they cannot see yours.',
      confirmLabel: 'Block creator',
      onConfirm: async () => {
        await api(`/users/${video.author.id}/block`, { method: 'POST' });
        toast('Creator blocked.');
        render();
      },
    }));
    const reportUser = $('[data-act="report-user"]', sheet);
    if (reportUser) reportUser.onclick = go(() => openReportSheet({ userId: video.author.id, title: '@' + video.author.handle }));
    $('[data-act="copy"]', sheet).onclick = go(async () => {
      const url = location.origin + '/#/v/' + videoId;
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied.');
      } catch {
        toast(url);
      }
    });
    const deleteBtn = $('[data-act="delete"]', sheet);
    if (deleteBtn) deleteBtn.onclick = go(() => confirmSheet({
      title: 'Delete this video?',
      message: 'This removes the video permanently.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await api('/videos/' + videoId, { method: 'DELETE' });
        toast('Video deleted.');
        route('/home');
        render();
      },
    }));
    const hideBtn = $('[data-act="hide"]', sheet);
    if (hideBtn) hideBtn.onclick = go(async () => {
      try {
        await api(`/admin/videos/${videoId}/hide`, { method: 'POST' });
        toast('Video hidden from the feed.');
        render();
      } catch (err) { toast(err.message); }
    });
    const restoreBtn = $('[data-act="restore"]', sheet);
    if (restoreBtn) restoreBtn.onclick = go(async () => {
      await api(`/admin/videos/${videoId}/restore`, { method: 'POST' });
      toast('Video restored.');
      render();
    });
  });
}

function openReportSheet({ videoId, userId, title }) {
  openSheet(`
    <h2>Report</h2>
    <p class="sheet-sub">Why are you reporting ${esc(title || 'this')}?</p>
    <div class="option-list" data-reasons>
      ${state.meta.reportReasons.map((r) => `
        <button class="option" data-reason="${esc(r.slug)}">${esc(r.label)}</button>`).join('')}
    </div>
    <div class="field" style="margin-top:14px">
      <label for="report-details">More detail (optional)</label>
      <textarea class="input" id="report-details" maxlength="500" placeholder="Tell moderators what happened"></textarea>
    </div>
    <button class="btn btn-primary btn-block" data-submit disabled>Submit report</button>
  `, (sheet, close) => {
    let reason = '';
    const submit = $('[data-submit]', sheet);
    $$('[data-reason]', sheet).forEach((btn) => {
      btn.onclick = () => {
        $$('[data-reason]', sheet).forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        reason = btn.dataset.reason;
        submit.disabled = false;
      };
    });
    submit.onclick = async () => {
      submit.disabled = true;
      submit.textContent = 'Sending…';
      try {
        const body = { reason, details: $('#report-details', sheet).value };
        if (videoId) body.videoId = videoId;
        if (userId) body.userId = userId;
        const data = await api('/reports', { method: 'POST', body });
        close();
        toast(data.message || 'Report sent.');
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Submit report';
        toast(err.message);
      }
    };
  });
}

/* ----------------------------- screens ---------------------------- */

async function renderHome() {
  const { category, tab } = state.feed;
  view.innerHTML = `
    <div class="screen" style="padding-bottom:8px">
      <div class="segmented" role="tablist">
        <button data-feed="latest" class="${tab === 'latest' ? 'active' : ''}">For you</button>
        <button data-feed="following" class="${tab === 'following' ? 'active' : ''}">Following</button>
      </div>
      <div class="chips" data-cats>
        <button class="chip ${category === 'all' ? 'active' : ''}" data-cat="all">All talents</button>
        ${state.meta.categories.map((c) =>
          `<button class="chip ${category === c.slug ? 'active' : ''}" data-cat="${esc(c.slug)}">${c.emoji} ${esc(c.name)}</button>`).join('')}
      </div>
    </div>
    <div class="screen" id="feed" style="padding-top:6px">
      ${Array.from({ length: 2 }).map(() => '<div class="skeleton" style="margin-bottom:18px"></div>').join('')}
    </div>`;

  $$('[data-feed]').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.feed === 'following' && !state.user) {
        toast('Log in to see creators you follow.');
        return route('/auth?next=/home');
      }
      state.feed.tab = btn.dataset.feed;
      render();
    };
  });
  $$('[data-cat]').forEach((btn) => {
    btn.onclick = () => { state.feed.category = btn.dataset.cat; render(); };
  });

  const feedEl = $('#feed');
  try {
    const params = new URLSearchParams({ category, sort: 'latest' });
    if (tab === 'following') params.set('feed', 'following');
    const data = await api('/videos?' + params.toString());
    if (!data.videos.length) {
      feedEl.innerHTML = `
        <div class="empty">
          <div class="emoji">${tab === 'following' ? '👀' : '🎬'}</div>
          <strong>${tab === 'following' ? 'Your following feed is empty' : 'No videos here yet'}</strong>
          <p class="small" style="margin:0;max-width:280px">${tab === 'following'
            ? 'Follow a few creators and their latest talents will show up here.'
            : 'Be the first to post a talent in this category.'}</p>
          <a class="btn btn-primary btn-sm" href="#/upload" style="margin-top:8px">Post a video</a>
        </div>`;
      return;
    }
    feedEl.innerHTML = `<div class="feed">${data.videos.map(videoCard).join('')}</div>`;
    setupFeedVideos(feedEl);
  } catch (err) {
    feedEl.innerHTML = `<div class="empty"><div class="emoji">⚠️</div><strong>Could not load the feed</strong><p class="small">${esc(err.message)}</p><button class="btn btn-sm" onclick="location.reload()">Retry</button></div>`;
  }
}

async function renderDiscover() {
  view.innerHTML = `
    <div class="screen">
      <div class="field" style="margin-bottom:16px">
        <input class="input" id="search-input" type="search" inputmode="search"
          placeholder="Search talents, creators, skills…" value="${esc(state.feed.q)}" />
      </div>
      <div class="section-title">Browse by category <span>12 talents</span></div>
      <div class="category-grid">
        ${state.meta.categories.map((c) => `
          <button class="category-tile" data-cat="${esc(c.slug)}">
            <span class="emoji">${c.emoji}</span><span>${esc(c.name)}</span>
          </button>`).join('')}
      </div>
      <div class="section-title">Creators to follow <span>Most followed</span></div>
      <div class="stack" id="creator-list"><div class="skeleton" style="height:90px"></div></div>
      <div class="section-title" id="results-title" style="display:none">Search results</div>
      <div class="stack" id="search-results"></div>
    </div>`;

  $$('[data-cat]').forEach((btn) => {
    btn.onclick = () => {
      state.feed.category = btn.dataset.cat;
      route('/home');
    };
  });

  const input = $('#search-input');
  let timer;
  const doSearch = async () => {
    const q = input.value.trim();
    state.feed.q = q;
    const title = $('#results-title');
    const results = $('#search-results');
    if (!q) {
      title.style.display = 'none';
      results.innerHTML = '';
      return;
    }
    title.style.display = '';
    try {
      const [vids, creators] = await Promise.all([
        api('/videos?q=' + encodeURIComponent(q)),
        api('/creators?q=' + encodeURIComponent(q)),
      ]);
      const videoHtml = vids.videos.length
        ? `<div class="grid-videos">${vids.videos.map((v) => `
            <a class="thumb" href="#/v/${esc(v.id)}">
              <video src="${esc(v.mediaUrl)}" muted playsinline preload="metadata"></video>
              <span class="thumb-label">${esc(v.title)}</span>
            </a>`).join('')}</div>`
        : '<p class="muted small">No videos matched — try another word.</p>';
      const creatorHtml = creators.creators.length
        ? creators.creators.map((c) => `
            <a class="list-item" href="#/u/${esc(c.handle)}">
              ${avatar(c)}
              <div style="min-width:0">
                <div style="font-weight:700">${esc(c.name)}</div>
                <div class="muted small">@${esc(c.handle)} · ${c.followerCount} followers</div>
              </div>
            </a>`).join('')
        : '';
      results.innerHTML = creatorHtml + videoHtml;
    } catch (err) {
      results.innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(doSearch, 280); });
  if (state.feed.q) doSearch();

  try {
    const { creators } = await api('/creators');
    const list = $('#creator-list');
    if (!creators.length) {
      list.innerHTML = '<p class="muted small">No creators yet — be the first.</p>';
    } else {
      list.innerHTML = creators.slice(0, 8).map((c) => `
        <a class="list-item" href="#/u/${esc(c.handle)}">
          ${avatar(c)}
          <div style="min-width:0;flex:1">
            <div style="font-weight:700">${esc(c.name)}</div>
            <div class="muted small">@${esc(c.handle)} · ${c.followerCount} followers</div>
          </div>
          <span class="badge">${c.videoCount} 🎬</span>
        </a>`).join('');
    }
  } catch { /* non-blocking */ }
}

async function renderDetail(videoId) {
  view.innerHTML = '<div class="screen"><div class="skeleton" style="height:48vh"></div></div>';
  let video;
  try {
    ({ video } = await api('/videos/' + videoId));
  } catch (err) {
    view.innerHTML = `<div class="screen"><div class="empty"><div class="emoji">🚫</div><strong>${esc(err.message)}</strong><a class="btn btn-sm" href="#/home">Back to feed</a></div></div>`;
    return;
  }
  const isMine = state.user && video.author.id === state.user.id;
  view.innerHTML = `
    <div class="screen">
      <div class="player-wrap">
        <video src="${esc(video.mediaUrl)}" controls playsinline preload="metadata" poster=""></video>
      </div>
      <div class="detail-actions">
        <button class="btn btn-sm ${video.likedByMe ? 'btn-primary' : ''}" data-like>
          ♥ <span data-like-count>${video.likeCount}</span>
        </button>
        ${isMine ? '<span class="badge">Your video</span>' : `
          <button class="btn btn-sm ${video.followingAuthor ? 'btn-ghost' : 'btn-primary'}" data-follow>
            ${video.followingAuthor ? 'Following' : 'Follow @' + esc(video.author.handle)}
          </button>`}
        <button class="btn btn-sm" data-more>More</button>
      </div>
      <h1 style="font-size:20px;margin:10px 0 6px;letter-spacing:-0.02em">${esc(video.title)}</h1>
      <div class="muted small">${esc(video.categoryName)} · ${esc(timeAgo(video.createdAt))}</div>
      ${video.description ? `<p style="margin:12px 0 0;white-space:pre-wrap">${esc(video.description)}</p>` : ''}
      <a class="list-item" href="#/u/${esc(video.author.handle)}" style="margin-top:18px">
        ${avatar(video.author)}
        <div style="min-width:0">
          <div style="font-weight:700">${esc(video.author.name)}</div>
          <div class="muted small">@${esc(video.author.handle)}</div>
        </div>
        <span class="spacer"></span><span class="muted">›</span>
      </a>
    </div>`;
  $('[data-like]').onclick = () => toggleLike(video.id, $('[data-like]'));
  const followBtn = $('[data-follow]');
  if (followBtn) followBtn.onclick = () => toggleFollow(video.author.id, followBtn);
  $('[data-more]').onclick = () => openVideoMenu(video.id);
}

async function renderProfile(handleParam) {
  const handle = handleParam || (state.user ? state.user.handle : null);
  if (!handle) return route('/auth?next=/me');
  view.innerHTML = '<div class="screen"><div class="skeleton" style="height:40vh"></div></div>';
  let profile;
  try {
    ({ profile } = await api('/users/' + encodeURIComponent(handle)));
  } catch (err) {
    view.innerHTML = `<div class="screen"><div class="empty"><div class="emoji">🙈</div><strong>${esc(err.message)}</strong><a class="btn btn-sm" href="#/home">Back to feed</a></div></div>`;
    return;
  }

  const isMe = profile.isMe;
  view.innerHTML = `
    <div class="screen">
      <div class="profile-head">
        <div class="profile-id">
          ${avatar(profile, 'lg')}
          <div style="min-width:0">
            <h1 class="profile-name">${esc(profile.name)} ${profile.role === 'admin' ? '<span class="badge">moderator</span>' : ''}</h1>
            <div class="handle">@${esc(profile.handle)}</div>
          </div>
        </div>
        ${profile.bio ? `<p style="margin:0;color:var(--muted)">${esc(profile.bio)}</p>` : ''}
        <div class="stats">
          <div class="stat"><b>${profile.videoCount}</b><span>videos</span></div>
          <div class="stat"><b data-follower-count>${profile.followerCount}</b><span>followers</span></div>
          <div class="stat"><b>${profile.followingCount}</b><span>following</span></div>
          <div class="stat"><b>${profile.likeCount}</b><span>likes</span></div>
        </div>
        <div class="row">
          ${isMe
            ? `<a class="btn btn-primary btn-sm" href="#/upload">+ New video</a>
               <button class="btn btn-sm" data-edit>Edit profile</button>
               <a class="btn btn-sm btn-ghost" href="#/blocked">Blocked</a>`
            : `<button class="btn btn-sm ${profile.isFollowing ? 'btn-ghost' : 'btn-primary'}" data-follow>
                 ${profile.isFollowing ? 'Following' : 'Follow'}
               </button>
               <button class="btn btn-sm" data-report>Report</button>
               <button class="btn btn-sm btn-danger" data-block>${profile.isBlocked ? 'Unblock' : 'Block'}</button>`}
        </div>
      </div>
      <div class="section-title">Talents <span>${profile.videoCount} posted</span></div>
      ${profile.videos.length ? `<div class="grid-videos">${profile.videos.map((v) => `
        <a class="thumb" href="#/v/${esc(v.id)}">
          <video src="${esc(v.mediaUrl)}" muted playsinline preload="metadata"></video>
          <span class="thumb-label">${esc(v.title)}</span>
        </a>`).join('')}</div>`
        : `<div class="empty"><div class="emoji">🎬</div><strong>No videos yet</strong>
           ${isMe ? '<a class="btn btn-primary btn-sm" href="#/upload">Post your first talent</a>' : ''}</div>`}
    </div>`;

  const followBtn = $('[data-follow]');
  if (followBtn) followBtn.onclick = () => toggleFollow(profile.id, followBtn);

  const editBtn = $('[data-edit]');
  if (editBtn) editBtn.onclick = () => openEditProfile(profile);

  const reportBtn = $('[data-report]');
  if (reportBtn) reportBtn.onclick = () => openReportSheet({ userId: profile.id, title: '@' + profile.handle });

  const blockBtn = $('[data-block]');
  if (blockBtn) blockBtn.onclick = async () => {
    if (!profile.isBlocked) {
      return confirmSheet({
        title: 'Block @' + profile.handle + '?',
        message: 'Their videos will be hidden from your feed and they cannot interact with you.',
        confirmLabel: 'Block',
        onConfirm: async () => {
          await api(`/users/${profile.id}/block`, { method: 'POST' });
          toast('Creator blocked.');
          route('/home');
        },
      });
    }
    try {
      await api(`/users/${profile.id}/block`, { method: 'POST' });
      toast('Creator unblocked.');
      render();
    } catch (err) { toast(err.message); }
  };
}

function openEditProfile(profile) {
  openSheet(`
    <h2>Edit profile</h2>
    <p class="sheet-sub">Keep it short and friendly.</p>
    <div class="field">
      <label for="edit-name">Display name</label>
      <input class="input" id="edit-name" maxlength="40" value="${esc(profile.name)}" />
    </div>
    <div class="field">
      <label for="edit-bio">Bio</label>
      <textarea class="input" id="edit-bio" maxlength="300" placeholder="What talents do you share?">${esc(profile.bio)}</textarea>
    </div>
    <button class="btn btn-primary btn-block" data-save>Save</button>
  `, (sheet, close) => {
    $('[data-save]', sheet).onclick = async () => {
      const btn = $('[data-save]', sheet);
      btn.disabled = true;
      try {
        const { user } = await api('/me', {
          method: 'PATCH',
          body: { name: $('#edit-name', sheet).value, bio: $('#edit-bio', sheet).value },
        });
        state.user = user;
        close();
        toast('Profile updated.');
        render();
      } catch (err) {
        btn.disabled = false;
        toast(err.message);
      }
    };
  });
}

function renderUpload() {
  if (!state.user) {
    view.innerHTML = `
      <div class="screen">
        <div class="empty" style="padding-top:60px">
          <div class="emoji">🎥</div>
          <strong>Sign in to post a talent</strong>
          <p class="small" style="max-width:260px">Create a free account to upload short videos, get likes and grow your audience.</p>
          <a class="btn btn-primary" href="#/auth?next=/upload">Log in or sign up</a>
        </div>
      </div>`;
    return;
  }

  view.innerHTML = `
    <div class="screen">
      <h1 style="font-size:22px;margin:4px 0 4px;letter-spacing:-0.02em">Share a talent</h1>
      <p class="muted small" style="margin:0 0 18px">Short videos work best — up to ${state.meta.maxVideoMb} MB.</p>
      <form id="upload-form">
        <div class="form-error" data-error></div>
        <label class="dropzone" id="dropzone" for="video-file">
          <span style="font-size:30px">⬆️</span>
          <strong>Choose a video from your phone</strong>
          <span class="small muted">MP4, WebM or MOV</span>
        </label>
        <input id="video-file" type="file" accept="video/*" hidden />
        <div class="field" style="margin-top:16px">
          <label for="title">Title</label>
          <input class="input" id="title" maxlength="90" placeholder="e.g. 30-second guitar riff" required />
        </div>
        <div class="field">
          <label for="category">Talent category</label>
          <select class="input" id="category" required>
            <option value="">Choose a category…</option>
            ${state.meta.categories.map((c) => `<option value="${esc(c.slug)}">${c.emoji} ${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="description">Description (optional)</label>
          <textarea class="input" id="description" maxlength="400" placeholder="Tell viewers about this talent"></textarea>
        </div>
        <div class="progress" id="progress" hidden><div></div></div>
        <button class="btn btn-primary btn-block" id="submit-btn" type="submit" style="margin-top:10px">Post video</button>
      </form>
    </div>`;

  const fileInput = $('#video-file');
  const dropzone = $('#dropzone');
  const form = $('#upload-form');
  const errorEl = $('[data-error]');
  let file = null;
  let previewUrl = null;

  fileInput.addEventListener('change', () => {
    file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!/^video\//.test(file.type)) {
      errorEl.textContent = 'Please choose a video file.';
      errorEl.classList.add('show');
      file = null;
      return;
    }
    if (file.size > state.meta.maxVideoMb * 1024 * 1024) {
      errorEl.textContent = `That video is too big. Maximum is ${state.meta.maxVideoMb} MB.`;
      errorEl.classList.add('show');
      file = null;
      return;
    }
    errorEl.classList.remove('show');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    dropzone.outerHTML = `<div class="dropzone has-file" id="dropzone">
        <video class="preview-video" src="${previewUrl}" controls playsinline></video>
      </div>`;
    const label = $('#title');
    if (label && !label.value && file.name) {
      label.value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 90);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    errorEl.classList.remove('show');
    if (!file) {
      errorEl.textContent = 'Choose a video to upload first.';
      errorEl.classList.add('show');
      return;
    }
    const title = $('#title').value.trim();
    const category = $('#category').value;
    if (title.length < 3) {
      errorEl.textContent = 'Give your video a title (3+ characters).';
      errorEl.classList.add('show');
      return;
    }
    if (!category) {
      errorEl.textContent = 'Pick a talent category.';
      errorEl.classList.add('show');
      return;
    }

    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', title);
    formData.append('category', category);
    formData.append('description', $('#description').value);

    const submitBtn = $('#submit-btn');
    const progressWrap = $('#progress');
    const progressBar = $('#progress > div');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading…';
    progressWrap.hidden = false;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos');
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.upload.onprogress = (ev) => {
      if (!ev.lengthComputable) return;
      progressBar.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        progressBar.style.width = '100%';
        toast('Posted! Your video is live.');
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        state.feed.category = 'all';
        state.feed.tab = 'latest';
        route('/v/' + data.video.id);
      } else {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Post video';
        progressWrap.hidden = true;
        errorEl.textContent = data.error || 'Upload failed. Please try again.';
        errorEl.classList.add('show');
      }
    };
    xhr.onerror = () => {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Post video';
      progressWrap.hidden = true;
      errorEl.textContent = 'Network error while uploading. Check your connection.';
      errorEl.classList.add('show');
    };
    xhr.send(formData);
  });
}

function renderBlocked() {
  if (!state.user) return route('/auth?next=/blocked');
  view.innerHTML = '<div class="screen"><div class="skeleton" style="height:30vh"></div></div>';
  api('/blocks').then(({ blocked }) => {
    view.innerHTML = `
      <div class="screen">
        <h1 style="font-size:21px;margin:4px 0 14px">Blocked creators</h1>
        ${blocked.length ? `<div class="stack">${blocked.map((u) => `
          <div class="list-item">
            ${avatar(u)}
            <div style="min-width:0;flex:1">
              <div style="font-weight:700">${esc(u.name)}</div>
              <div class="muted small">@${esc(u.handle)}</div>
            </div>
            <button class="btn btn-sm" data-unblock="${esc(u.id)}">Unblock</button>
          </div>`).join('')}</div>`
          : '<div class="empty"><div class="emoji">🕊️</div><strong>No blocked accounts</strong><p class="small">People you block will appear here.</p></div>'}
      </div>`;
    $$('[data-unblock]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/users/${btn.dataset.unblock}/block`, { method: 'POST' });
          toast('Unblocked.');
          renderBlocked();
        } catch (err) { toast(err.message); }
      };
    });
  }).catch((err) => {
    view.innerHTML = `<div class="screen"><div class="empty"><strong>${esc(err.message)}</strong></div></div>`;
  });
}

async function renderAdmin() {
  if (!state.user) return route('/auth?next=/admin');
  if (state.user.role !== 'admin') {
    view.innerHTML = '<div class="screen"><div class="empty"><div class="emoji">🔒</div><strong>Moderation is for moderators only</strong><a class="btn btn-sm" href="#/home">Back home</a></div></div>';
    return;
  }
  view.innerHTML = `
    <div class="screen">
      <h1 style="font-size:22px;margin:4px 0 12px">Moderation</h1>
      <div class="card" id="admin-stats"><div class="skeleton" style="height:56px"></div></div>
      <div class="segmented" style="margin-top:18px">
        <button class="active" data-status="open">Open reports</button>
        <button data-status="resolved">Resolved</button>
        <button data-status="all">All</button>
      </div>
      <div class="stack" id="report-list"></div>
    </div>`;

  try {
    const stats = await api('/admin/stats');
    $('#admin-stats').innerHTML = `
      <div class="stats" style="justify-content:space-between;gap:8px;padding:0">
        <div class="stat"><b>${stats.users}</b><span>users</span></div>
        <div class="stat"><b>${stats.videos}</b><span>videos</span></div>
        <div class="stat"><b>${stats.openReports}</b><span>open reports</span></div>
        <div class="stat"><b>${stats.hiddenVideos}</b><span>hidden</span></div>
      </div>`;
  } catch { /* ignore */ }

  const loadReports = async (status) => {
    const list = $('#report-list');
    list.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      const { reports } = await api('/admin/reports?status=' + status);
      if (!reports.length) {
        list.innerHTML = `<div class="empty"><div class="emoji">✅</div><strong>Nothing ${status === 'open' ? 'to review' : 'here'}</strong><p class="small">The queue is clear.</p></div>`;
        return;
      }
      list.innerHTML = reports.map((r) => `
        <div class="card report-card">
          <div class="row-between">
            <span class="badge">${esc(r.reasonLabel)}</span>
            <span class="muted small">${esc(timeAgo(r.createdAt))}</span>
          </div>
          <div>
            <div style="font-weight:700">${r.video ? esc(r.video.title) : '@' + esc((r.targetUser || {}).handle || 'unknown')}</div>
            <div class="muted small">Reported by @${esc((r.reporter || {}).handle || 'unknown')}${r.targetUser ? ' · creator @' + esc(r.targetUser.handle) : ''}</div>
          </div>
          ${r.details ? `<div class="quote">${esc(r.details)}</div>` : ''}
          ${r.video ? `<div class="muted small">${r.video.hidden ? '🚫 hidden from feed' : '👁 visible in feed'}</div>` : ''}
          ${r.status === 'open' ? `
            <div class="admin-actions">
              <button class="btn btn-sm btn-ok" data-action="dismiss" data-id="${esc(r.id)}">Dismiss</button>
              ${r.video ? `<button class="btn btn-sm btn-danger" data-action="hide_video" data-id="${esc(r.id)}">${r.video.hidden ? 'Keep hidden' : 'Hide video'}</button>` : ''}
              ${r.targetUser ? `<button class="btn btn-sm btn-danger" data-action="ban_user" data-id="${esc(r.id)}">Suspend creator</button>` : ''}
              ${r.video ? `<a class="btn btn-sm" href="#/v/${esc(r.video.id)}">Watch</a>` : ''}
            </div>` : `<div class="muted small">${esc((r.resolution && r.resolution.action) || r.status)} · ${esc(timeAgo(r.resolvedAt || r.createdAt))}</div>`}
        </div>`).join('');

      $$('[data-action]', list).forEach((btn) => {
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            await api(`/admin/reports/${btn.dataset.id}/resolve`, {
              method: 'POST',
              body: { action: btn.dataset.action },
            });
            toast('Moderation action saved.');
            loadReports(status);
          } catch (err) {
            btn.disabled = false;
            toast(err.message);
          }
        };
      });
    } catch (err) {
      list.innerHTML = `<div class="empty"><strong>${esc(err.message)}</strong></div>`;
    }
  };

  $$('[data-status]').forEach((btn) => {
    btn.onclick = () => {
      $$('[data-status]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadReports(btn.dataset.status);
    };
  });
  loadReports('open');
}

/* ---------------------------- auth ------------------------------- */

const EYE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <g class="eye-open">
      <path d="M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12Z" />
      <circle cx="12" cy="12" r="3.1" />
    </g>
    <path class="eye-slash" d="M4 4l16 16" />
  </svg>`;

/**
 * Password input with its own show/hide (eye) button.
 * The button is type="button" so it never submits the form, and it keeps the
 * typed value + caret intact while flipping input.type between password/text.
 */
function passwordField({ id, label, autocomplete, placeholder, showLabel, hideLabel, hint = '' }) {
  return `
    <div class="field">
      <label for="${id}">${esc(label)}</label>
      <div class="input-wrap">
        <input class="input" id="${id}" name="${id}" type="password"
               autocomplete="${esc(autocomplete)}" placeholder="${esc(placeholder)}"
               minlength="8" required aria-describedby="${id}-toggle-hint" />
        <button class="eye-btn" type="button" data-toggle="${id}"
                aria-controls="${id}" aria-label="${esc(showLabel)}"
                aria-pressed="false" title="${esc(showLabel)}">${EYE_ICON}</button>
      </div>
      <span class="hint" id="${id}-toggle-hint" hidden>${esc(hideLabel)}</span>
      ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    </div>`;
}

function bindPasswordToggles(root) {
  $('[data-toggle]', root).forEach((btn) => {
    const input = $('#' + btn.dataset.toggle, root);
    if (!input) return;
    const baseLabel = btn.dataset.labelShow || btn.getAttribute('aria-label');
    btn.dataset.labelShow = baseLabel;
    btn.dataset.labelHide = btn.dataset.labelHide
      || baseLabel.replace(/^Show /, 'Hide ');

    const setState = (visible) => {
      btn.classList.toggle('active', visible);
      btn.setAttribute('aria-pressed', visible ? 'true' : 'false');
      const label = visible ? btn.dataset.labelHide : btn.dataset.labelShow;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    };

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Snapshot before the type flip: some older Android/Chromium builds reset
      // the field value when input.type changes, so we always restore it.
      const value = input.value;
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      if (value) input.value = value;
      try { input.setSelectionRange(start, end); } catch { /* unsupported */ }
      setState(show);
    });
  });
}

function renderAuth() {
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  const next = params.get('next') || '/me';
  if (state.user) return (location.hash = '#' + next);

  view.innerHTML = `
    <div class="screen">
      <div class="auth-hero">
        <h1>Every talent<br />deserves a stage.</h1>
        <p>Sing, dance, cook, code, fix, grow — share it in a short video.</p>
      </div>
      <div class="segmented" role="tablist" aria-label="Log in or sign up">
        <button type="button" role="tab" class="active" data-mode="login" aria-selected="true">Log in</button>
        <button type="button" role="tab" data-mode="signup" aria-selected="false">Sign up</button>
      </div>
      <form id="auth-form" novalidate>
        <div class="form-error" data-error role="alert" aria-live="polite"></div>
        <div data-fields></div>
        <button class="btn btn-primary btn-block" data-submit type="submit">Log in</button>
        <p class="hint center" style="margin-top:14px">Free accounts. We never post without you.</p>
      </form>
    </div>`;

  let mode = 'login';
  const form = $('#auth-form');
  const errorEl = $('[data-error]');
  const fieldsEl = $('[data-fields]');
  const submitBtn = $('[data-submit]');
  const draft = { name: '', email: '', password: '', confirm: '' };
  const idleLabel = () => (mode === 'login' ? 'Log in' : 'Create free account');

  const valueOf = (sel) => { const el = $(sel); return el ? el.value : ''; };

  function readDraft() {
    draft.name = valueOf('#auth-name');
    draft.email = valueOf('#auth-email');
    draft.password = valueOf('#auth-password');
    draft.confirm = valueOf('#auth-confirm');
  }

  function renderFields() {
    // Log In deliberately has no name field and no confirm-password field.
    const nameField = mode === 'signup' ? `
      <div class="field">
        <label for="auth-name">Full name</label>
        <input class="input" id="auth-name" name="name" autocomplete="name"
               placeholder="e.g. Meera K" minlength="2" required />
      </div>` : '';

    const confirmField = mode === 'signup' ? passwordField({
      id: 'auth-confirm',
      label: 'Confirm password',
      autocomplete: 'new-password',
      placeholder: 'Re-enter your password',
      showLabel: 'Show confirm password',
      hideLabel: 'Hide confirm password',
    }) : '';

    fieldsEl.innerHTML = `
      ${nameField}
      <div class="field">
        <label for="auth-email">Email</label>
        <input class="input" id="auth-email" name="email" type="email" inputmode="email"
               autocomplete="email" placeholder="you@example.com" required />
      </div>
      ${passwordField({
        id: 'auth-password',
        label: 'Password',
        autocomplete: mode === 'login' ? 'current-password' : 'new-password',
        placeholder: mode === 'login' ? 'Your password' : 'At least 8 characters',
        showLabel: 'Show password',
        hideLabel: 'Hide password',
        hint: mode === 'signup' ? 'Use at least 8 characters.' : '',
      })}
      ${confirmField}`;

    // Keep whatever the user already typed when switching tabs.
    if (draft.name) $('#auth-name').value = draft.name;
    $('#auth-email').value = draft.email;
    $('#auth-password').value = draft.password;
    if ($('#auth-confirm') && draft.confirm) $('#auth-confirm').value = draft.confirm;

    bindPasswordToggles(fieldsEl);
  }

  function setMode(nextMode) {
    if (nextMode === mode) return;
    readDraft();
    mode = nextMode;
    $('[data-mode]').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    submitBtn.textContent = idleLabel();
    errorEl.classList.remove('show');
    errorEl.textContent = '';
    renderFields();
  }

  $('[data-mode]').forEach((btn) => { btn.onclick = () => setMode(btn.dataset.mode); });
  renderFields();

  function showError(message, selector) {
    errorEl.textContent = message;
    errorEl.classList.add('show');
    submitBtn.disabled = false;
    submitBtn.textContent = idleLabel();
    const el = selector ? $(selector) : null;
    if (el) el.focus({ preventScroll: true });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.remove('show');

    const email = valueOf('#auth-email').trim();
    const password = valueOf('#auth-password');
    const name = mode === 'signup' ? valueOf('#auth-name').trim() : '';
    const confirm = mode === 'signup' ? valueOf('#auth-confirm') : '';

    if (mode === 'signup' && name.length < 2) return showError('Enter your full name (2+ characters).', '#auth-name');
    if (!email) return showError('Enter your email address.', '#auth-email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Enter a valid email address.', '#auth-email');
    if (!password) return showError('Enter your password.', '#auth-password');
    if (mode === 'signup' && password.length < 8) return showError('Password must be at least 8 characters.', '#auth-password');
    if (mode === 'signup' && !confirm) return showError('Re-enter your password to confirm it.', '#auth-confirm');
    if (mode === 'signup' && confirm !== password) return showError('Passwords do not match.', '#auth-confirm');

    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'login' ? 'Logging in…' : 'Creating account…';
    try {
      // Confirm password is a client-side check only — it is never sent or stored.
      const body = { email, password };
      if (mode === 'signup') body.name = name;
      const data = await api('/auth/' + mode, { method: 'POST', body });
      setSession(data.token, data.user);
      toast(mode === 'login' ? `Welcome back, ${data.user.name}!` : 'Account created — welcome!');
      route(next);
    } catch (err) {
      showError(err.message);
    }
  });
}

/* ----------------------------- router ----------------------------- */

function setActiveTab(path) {
  const map = { home: 'home', discover: 'discover', upload: 'upload', me: 'profile', u: 'profile' };
  const key = path.split('/')[0] || 'home';
  $$('.tab', tabbar).forEach((t) => t.classList.toggle('active', t.dataset.tab === map[key]));
}

async function render() {
  const myId = ++state.renderId;
  if (state.observer) { state.observer.disconnect(); state.observer = null; }
  document.querySelectorAll('video').forEach((v) => v.pause());

  const hash = location.hash.replace(/^#/, '') || '/home';
  const [pathPart, queryPart] = hash.split('?');
  const path = pathPart || '/home';
  const segments = path.split('/').filter(Boolean);

  setActiveTab(path);
  renderTopbar();
  window.scrollTo({ top: 0 });

  try {
    if (segments[0] === 'home') await renderHome();
    else if (segments[0] === 'discover') await renderDiscover();
    else if (segments[0] === 'upload') renderUpload();
    else if (segments[0] === 'auth') renderAuth();
    else if (segments[0] === 'admin') await renderAdmin();
    else if (segments[0] === 'blocked') renderBlocked();
    else if (segments[0] === 'v' && segments[1]) await renderDetail(segments[1]);
    else if (segments[0] === 'u' && segments[1]) await renderProfile(segments[1]);
    else if (segments[0] === 'me') await renderProfile(null);
    else if (segments[0] === 'search') {
      const q = new URLSearchParams(queryPart || '').get('q') || '';
      state.feed.q = q;
      await renderDiscover();
    } else route('/home');
  } catch (err) {
    console.error(err);
    if (myId === state.renderId) {
      view.innerHTML = `<div class="screen"><div class="empty"><div class="emoji">😵</div><strong>Something went wrong</strong><p class="small">${esc(err.message)}</p><a class="btn btn-sm" href="#/home">Back home</a></div></div>`;
    }
  }
}

window.addEventListener('hashchange', render);

(async function boot() {
  try {
    const meta = await api('/meta');
    state.meta = meta;
    if (meta.user) state.user = meta.user;
    else if (state.token) setSession('', null);
  } catch (err) {
    console.error('boot failed', err);
  }
  renderTopbar();
  render();
})();
