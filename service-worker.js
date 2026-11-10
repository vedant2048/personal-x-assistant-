const DEFAULT_SETTINGS = {
  provider: 'gemini', model: 'gemini-3.5-flash-lite', proxyUrl: 'http://localhost:8787',
  minIntervalSeconds: 60, maxIntervalSeconds: 180, timeoutMs: 45000,
  sleepCycleEnabled: true
};
const runtime = {
  state: 'stopped', queue: [], processing: false, nextAt: 0,
  currentId: null, lastError: null, pendingSubmitId: null,
  sessionStartTime: 0, sleepUntil: 0
};
const DB_NAME = 'personal-x-ai-assistant';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const posts = db.createObjectStore('posts', { keyPath: 'id' });
      posts.createIndex('timestamp', 'timestamp');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function dbGet(id) { const db = await openDb(); return new Promise((resolve, reject) => { const r = db.transaction('posts').objectStore('posts').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
async function dbPut(value) { const db = await openDb(); return new Promise((resolve, reject) => { const r = db.transaction('posts', 'readwrite').objectStore('posts').put(value); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }); }
async function dbAll() { const db = await openDb(); return new Promise((resolve, reject) => { const r = db.transaction('posts').objectStore('posts').getAll(); r.onsuccess = () => resolve(r.result.sort((a,b) => b.timestamp-a.timestamp)); r.onerror = () => reject(r.error); }); }
async function dbClear() { const db = await openDb(); return new Promise((resolve, reject) => { const r = db.transaction('posts', 'readwrite').objectStore('posts').clear(); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); }); }
async function settings() { return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) }; }
async function persistRuntime() {
  await chrome.storage.session.set({
    runtime: {
      state: runtime.state, nextAt: runtime.nextAt, currentId: runtime.currentId,
      lastError: runtime.lastError, pendingSubmitId: runtime.pendingSubmitId,
      sessionStartTime: runtime.sessionStartTime, sleepUntil: runtime.sleepUntil
    }
  });
}
async function restoreRuntime() { const { runtime: saved } = await chrome.storage.session.get('runtime'); if (saved) Object.assign(runtime, saved); }
function updateBadge() {
  if (runtime.state !== 'running') {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (runtime.sleepUntil && runtime.sleepUntil > Date.now()) {
    const diffSec = Math.max(0, Math.floor((runtime.sleepUntil - Date.now()) / 1000));
    const badgeText = diffSec >= 60 ? `${Math.ceil(diffSec / 60)}m` : `${diffSec}s`;
    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: '#a855f7' });
    return;
  }
  if (runtime.nextAt && runtime.nextAt > Date.now()) {
    const diffSec = Math.max(0, Math.floor((runtime.nextAt - Date.now()) / 1000));
    const badgeText = diffSec >= 60 ? `${Math.ceil(diffSec / 60)}m` : `${diffSec}s`;
    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: '#38bdf8' });
  } else if (runtime.processing) {
    chrome.action.setBadgeText({ text: '...' });
    chrome.action.setBadgeBackgroundColor({ color: '#56d364' });
  } else {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#2385df' });
  }
}

function sendUpdate() {
  chrome.runtime.sendMessage({ type: 'UPDATE' }).catch(() => {});
  chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] }).then(tabs => {
    tabs.forEach(t => {
      chrome.tabs.sendMessage(t.id, { type: 'STATE_UPDATE', runtime }).catch(() => {});
    });
  }).catch(() => {});
  updateBadge();
}

setInterval(() => {
  if (runtime.state === 'running') {
    updateBadge();
  }
}, 1000);
function cleanJson(text) {
  const match = text.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Malformed classification JSON.');
  const result = JSON.parse(match[0]);

  const action = (result.action || '').toUpperCase();
  const shouldEngage = action === 'GENERATE_REPLY' || action === 'GENERATE_HUMOROUS_REPLY' || (action !== 'SKIP' && result.decision === 'ENGAGE');

  result.decision = shouldEngage ? 'ENGAGE' : 'SKIP';
  result.action = action || (shouldEngage ? 'GENERATE_REPLY' : 'SKIP');
  result.relevant = shouldEngage;
  result.post_type = result.post_type || (shouldEngage ? 'INTERESTING_TECH_OPINION' : 'NON_TECH');
  return result;
}

async function requestAi(task, prompt) {
  const cfg = await settings(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const response = await fetch(`${cfg.proxyUrl.replace(/\/$/, '')}/v1/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ provider: cfg.provider, model: cfg.model, task, prompt }) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const errMsg = body.error || `AI proxy returned HTTP ${response.status}.`;
      throw new Error(errMsg);
    }
    const body = await response.json(); if (!body.text?.trim()) throw new Error('AI provider returned empty output.'); return body.text.trim();
  } catch (error) { if (error.name === 'AbortError') throw new Error('AI request timed out.'); if (error instanceof TypeError) throw new Error('Local AI proxy is unavailable at localhost:8787.'); throw error; } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
//  Helpers: X Tab, Scroll, Auto-Submit
// ---------------------------------------------------------------------------

async function getXTabId(preferTabId) {
  if (preferTabId) {
    try { const tab = await chrome.tabs.get(preferTabId); if (tab) return preferTabId; } catch { /* tab gone */ }
  }
  const tabs = await chrome.tabs.query({ url: ['*://x.com/*', '*://twitter.com/*'] });
  const active = tabs.find(t => t.active) || tabs[0];
  return active?.id;
}

/** Ask content script to scroll the feed and return newly visible posts. */
async function scrollForMorePosts(preferTabId) {
  const tabId = await getXTabId(preferTabId);
  if (!tabId) { runtime.lastError = 'No X tab found. Open x.com/home.'; sendUpdate(); return; }
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'SCROLL_FEED' });
    if (result?.posts?.length) {
      for (const post of result.posts) {
        if (!runtime.queue.some(item => item.id === post.id)) {
          runtime.queue.push({ ...post, tabId });
        }
      }
    }
  } catch (e) {
    runtime.lastError = 'Could not scroll feed: ' + e.message;
    sendUpdate();
  }
}

/** Calculate organic human randomized delay (bell curve with decimal jitter). */
function getHumanDelay(minSec = 60, maxSec = 180) {
  const factor = (Math.random() + Math.random()) / 2;
  const rawSec = minSec + factor * (maxSec - minSec);
  return Math.round((rawSec + (Math.random() * 4 - 2)) * 10) / 10;
}

/** Ask content script to like a post. */
async function autoLikePost(postId, preferTabId) {
  const tabId = await getXTabId(preferTabId);
  if (!tabId) return false;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'LIKE_POST', postId });
    return res?.liked || res?.alreadyLiked;
  } catch (_) {
    return false;
  }
}

/** Submit a ready draft reply to X via the content script. */
async function autoSubmitDraft(postId) {
  const post = await dbGet(postId);
  if (!post?.draft || post.status !== 'draft_ready') return false;
  const tabId = await getXTabId(post.tabId);
  if (!tabId) { runtime.lastError = 'No X tab found for submission.'; return false; }
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'SUBMIT_REPLY', postId: post.id, draft: post.draft });
    post.status = result?.ok ? 'submitted' : 'submission_failed';
    post.error = result?.error || null;
    post.submittedAt = Date.now();
    await dbPut(post);
    if (!result?.ok) { runtime.lastError = post.error; return false; }
    return true;
  } catch (e) {
    post.status = 'submission_failed'; post.error = e.message; await dbPut(post);
    runtime.lastError = e.message; return false;
  }
}

// ---------------------------------------------------------------------------
//  Core Processing
// ---------------------------------------------------------------------------

function isMediaPost(post) {
  if (!post) return false;
  if (post.hasMedia) return true;
  const text = post.text || '';
  if (/pic\.(?:twitter|x)\.com/i.test(text)) return true;
  if (/\bpic\.x\b/i.test(text)) return true;
  if (/\b(photo|video)\/\d+/i.test(post.url || '')) return true;
  return false;
}

async function processPost(post, force = false) {
  if (!post?.id || !post.text?.trim()) throw new Error('Empty post or unsupported X layout.');
  const existing = await dbGet(post.id);
  if (existing && !force) { runtime.lastError = 'Duplicate post ID skipped.'; return; }
  const base = { ...existing, ...post, timestamp: Date.now(), status: 'classifying', error: null };
  await dbPut(base); sendUpdate();

  // Skip image, video, or pic.x posts immediately without calling AI, liking, or replying
  if (isMediaPost(post)) {
    base.status = 'irrelevant';
    base.classification = {
      decision: 'SKIP',
      action: 'SKIP',
      post_type: 'MEDIA_POST',
      reason: 'Skipped: Contains image, video, or pic.x media link'
    };
    await dbPut(base);
    sendUpdate();
    return;
  }

  try {
    // Classification (cached per post)
    const classification = base.classification || cleanJson(await requestAi('classification',
      `Analyze this X post and classify its relevance according to your instructions. Output ONLY valid JSON.\n\nPost:\n${post.text}`));
    base.classification = classification;
    if (classification.decision !== 'ENGAGE' || classification.action === 'SKIP') {
      base.status = 'irrelevant';
      await dbPut(base);
      return;
    }

    // Randomly like tech posts (approx 3 out of 5 -> 60% probability)
    if (Math.random() < 0.6) {
      try {
        const liked = await autoLikePost(post.id, post.tabId);
        if (liked) base.liked = true;
      } catch (_) {}
    }

    // Reply generation: adaptive tone based on action (humorous for memes vs thoughtful for opinions/discussions)
    let rawReply;
    if (classification.action === 'GENERATE_HUMOROUS_REPLY') {
      rawReply = await requestAi('humorous_reply',
        `Write a short, simple, dry developer reply to this tech post:
- Length: strictly 5 to 12 words. Keep it short, not too much.
- Language: very simple everyday words that anyone can easily understand.
- Think like a human: casual, dry developer humor.
- Style: lowercase where natural.
- Zero emojis. No exclamation marks.
- No fake laughter (no "lol", "haha", "so true").
- Add a quick, relatable developer punchline or observation.
- Output ONLY the reply text directly.

Post:
"${post.text}"`);
    } else {
      rawReply = await requestAi('reply',
        `Write a short, simple reply to this tech post:
- Length: strictly 5 to 12 words. Keep it short, not too much.
- Language: simple, plain words. Easy to understand. Avoid fancy or complex words.
- Think like a human: sound like a real person casually typing a thought on their phone.
- No lecturing, explaining, or summarizing what the post says.
- Style: lowercase where natural. Calm and grounded.
- Zero emojis. Never use emojis.
- Zero exclamation marks.
- No corporate buzzwords, flattery, or compliments.
- No questions at the end.
- Output ONLY the reply text directly.

Post:
"${post.text}"`);
    }

    // Clean up: remove surrounding quotes, emojis, trailing questions/exclamations
    let clean = rawReply.replace(/^["'`]|["'`]$/g, '').trim();
    clean = clean.replace(/[\p{Extended_Pictographic}\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
    clean = clean.replace(/\?\s*$/, '.').replace(/!+/g, '.').replace(/\.{2,}/g, '.').trim();

    base.draft = clean.slice(0, 280);
    if (!base.draft) throw new Error('AI provider returned empty output.');
    base.status = 'draft_ready';
    runtime.currentId = base.id;
  } catch (error) {
    const msg = error.message || '';
    const isRateLimit = msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('free-models-per-day');
    if (isRateLimit) {
      // Put post back in queue and pause gracefully to prevent failing all posts
      runtime.queue.unshift(post);
      runtime.state = 'paused';
      runtime.lastError = msg;
      await persistRuntime();
      sendUpdate();
      return;
    }
    base.status = 'failed';
    base.error = msg;
    runtime.lastError = msg;
  }
  await dbPut(base); sendUpdate();
}

// ---------------------------------------------------------------------------
//  Main Loop
// ---------------------------------------------------------------------------

async function tick() {
  if (runtime.processing || runtime.state !== 'running') return;

  const cfg = await settings();

  // ── Sleep Cycle Management (30m work -> 5m rest) ──
  if (cfg.sleepCycleEnabled) {
    const now = Date.now();
    // Phase A: Currently in 5-minute sleep break
    if (runtime.sleepUntil && now < runtime.sleepUntil) {
      return;
    }
    // Phase B: Sleep break just completed -> wake up & reset 30m work clock
    if (runtime.sleepUntil && now >= runtime.sleepUntil) {
      runtime.sleepUntil = 0;
      runtime.sessionStartTime = now;
      runtime.nextAt = 0;
      await persistRuntime(); sendUpdate();
    }
    // Phase C: If active running time reached 30 minutes, pause for 5 minutes
    if (!runtime.sessionStartTime) runtime.sessionStartTime = now;
    const activeElapsed = now - runtime.sessionStartTime;
    const THIRTY_MINS_MS = 30 * 60 * 1000;
    const FIVE_MINS_MS = 5 * 60 * 1000;

    if (activeElapsed >= THIRTY_MINS_MS && !runtime.pendingSubmitId) {
      runtime.sleepUntil = now + FIVE_MINS_MS;
      runtime.nextAt = runtime.sleepUntil;
      chrome.alarms.create('sleep-timer', { when: runtime.sleepUntil });
      setTimeout(() => tick(), FIVE_MINS_MS + 200);
      await persistRuntime(); sendUpdate();
      return;
    }
  }

  // ── Phase 1: Pending submission whose delay has elapsed ──
  if (runtime.pendingSubmitId && runtime.nextAt > 0 && Date.now() >= runtime.nextAt) {
    runtime.processing = true;
    const submitId = runtime.pendingSubmitId;
    runtime.pendingSubmitId = null;
    runtime.nextAt = 0;
    await autoSubmitDraft(submitId);
    runtime.currentId = submitId;
    await persistRuntime(); sendUpdate();
    // After submitting, scroll to load more tweets
    await scrollForMorePosts();
    runtime.processing = false;
    setTimeout(() => tick(), 2000);          // continue quickly
    return;
  }

  // ── Phase 2: Still waiting on the delay — do nothing ──
  if (runtime.pendingSubmitId && runtime.nextAt > 0 && Date.now() < runtime.nextAt) return;

  // ── Phase 3: Process next queued post ──
  const post = runtime.queue.shift();
  if (!post) {
    // Queue empty → scroll to find more tweets
    runtime.processing = true;
    await scrollForMorePosts();
    runtime.processing = false;
    await persistRuntime(); sendUpdate();
    return;
  }

  runtime.processing = true;
  await processPost(post);
  const entry = await dbGet(post.id);

  if (entry?.status === 'draft_ready') {
    // Tech tweet → schedule auto-submit after human randomized delay (1m - 3m)
    const delaySec = getHumanDelay(cfg.minIntervalSeconds, cfg.maxIntervalSeconds);
    const delayMs = Math.max(50000, delaySec * 1000);
    runtime.nextAt = Date.now() + delayMs;
    runtime.pendingSubmitId = entry.id;
    runtime.currentId = entry.id;
    runtime.processing = false;
    chrome.alarms.create('pending-submit', { when: runtime.nextAt });
    setTimeout(() => tick(), delayMs + 100);
    await persistRuntime(); sendUpdate();
    return;                                   // alarm / timeout will wake us when delay passes
  }

  // Non-tech (irrelevant) or failed → skip, move on immediately
  runtime.processing = false;
  await persistRuntime(); sendUpdate();
  setTimeout(() => tick(), 1500);             // process next quickly
}

// Alarm fires every 30 s as a heartbeat or when scheduled delay arrives
chrome.alarms.create('process-queue', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === 'process-queue' || name === 'pending-submit' || name === 'sleep-timer') tick();
});
chrome.runtime.onStartup.addListener(restoreRuntime);

// ---------------------------------------------------------------------------
//  Message Router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    // Content script reports visible posts
    if (message.type === 'VISIBLE_POSTS') {
      if (runtime.state === 'running') {
        for (const post of message.posts || []) {
          if (!runtime.queue.some(item => item.id === post.id)) {
            runtime.queue.push({ ...post, tabId: sender.tab?.id });
          }
        }
        await tick();
      }
      respond({ ok: true });
      return;
    }

    // Start / Pause / Stop
    if (message.type === 'CONTROL') {
      runtime.state = message.action === 'start' ? 'running' : message.action === 'pause' ? 'paused' : 'stopped';
      if (runtime.state === 'stopped') {
        runtime.queue = []; runtime.currentId = null; runtime.nextAt = 0;
        runtime.pendingSubmitId = null; runtime.sessionStartTime = 0; runtime.sleepUntil = 0;
      }
      if (runtime.state === 'running') {
        runtime.nextAt = 0; runtime.pendingSubmitId = null;
        if (!runtime.sessionStartTime) runtime.sessionStartTime = Date.now();
        runtime.sleepUntil = 0;
        const tabId = await getXTabId();
        if (tabId) {
          try { await chrome.tabs.sendMessage(tabId, { type: 'SCAN_NOW' }); } catch { runtime.lastError = 'Open x.com/home to start scanning.'; }
        } else {
          runtime.lastError = 'No X tab found. Open x.com/home.';
        }
        await tick();
      }
      await persistRuntime(); sendUpdate(); respond({ ok: true }); return;
    }

    // Reset Counters & History
    if (message.type === 'RESET_COUNTERS') {
      await dbClear();
      runtime.queue = [];
      runtime.currentId = null;
      runtime.pendingSubmitId = null;
      runtime.nextAt = 0;
      runtime.sessionStartTime = Date.now();
      runtime.sleepUntil = 0;
      runtime.lastError = null;
      await persistRuntime();
      sendUpdate();
      respond({ ok: true });
      return;
    }

    // Toggle Sleep Cycle On/Off
    if (message.type === 'TOGGLE_SLEEP_CYCLE') {
      await chrome.storage.sync.set({ sleepCycleEnabled: !!message.enabled });
      if (!message.enabled && runtime.sleepUntil) {
        runtime.sleepUntil = 0;
        runtime.nextAt = 0;
        chrome.alarms.clear('sleep-timer');
      }
      await persistRuntime();
      sendUpdate();
      respond({ ok: true });
      return;
    }

    // Regenerate draft for a post
    if (message.type === 'REGENERATE') {
      const post = await dbGet(message.id);
      if (!post) throw new Error('Post history was not found.');
      await processPost(post, true); await persistRuntime(); respond({ ok: true }); return;
    }

    // Manual submit from popup
    if (message.type === 'SUBMIT') {
      if (runtime.state !== 'running') throw new Error('Start the session before submitting a draft.');
      const post = await dbGet(message.id);
      if (!post?.draft || post.status !== 'draft_ready') throw new Error('No ready draft to submit.');
      const tabId = post.tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      const result = await chrome.tabs.sendMessage(tabId, { type: 'SUBMIT_REPLY', postId: post.id, draft: post.draft });
      post.status = result?.ok ? 'submitted' : 'submission_failed'; post.error = result?.error || null; post.submittedAt = Date.now(); await dbPut(post);
      if (!result?.ok) runtime.lastError = post.error; sendUpdate(); respond(result); return;
    }

    // Popup requests full state snapshot
    if (message.type === 'SNAPSHOT') {
      const posts = await dbAll(); const cfg = await settings();
      respond({
        runtime: { ...runtime, pendingSubmitId: runtime.pendingSubmitId },
        settings: cfg, posts,
        counters: {
          seen: posts.length,
          liked: posts.filter(p => p.liked).length,
          queued: posts.filter(p => p.status === 'draft_ready').length,
          submitted: posts.filter(p => p.status === 'submitted').length,
          failed: posts.filter(p => p.status === 'failed' || p.status === 'submission_failed').length
        }
      }); return;
    }

    // Save settings
    if (message.type === 'SAVE_SETTINGS') { await chrome.storage.sync.set(message.settings); respond({ ok: true }); return; }
  })().catch(error => respond({ ok: false, error: error.message }));
  return true;
});

restoreRuntime();
