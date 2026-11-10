// === State & Lifecycle ===
let observer;
let mutationObs;
let navWatcher;
let started = false;
let scrolling = false;
const announced = new Set();
let lastUrl = location.href;

function isContextValid() {
  return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
}

function cleanupOrphan() {
  if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
  if (mutationObs) { try { mutationObs.disconnect(); } catch (_) {} mutationObs = null; }
  if (navWatcher) { try { navWatcher.disconnect(); } catch (_) {} navWatcher = null; }
  if (widgetTimer) { clearInterval(widgetTimer); widgetTimer = null; }
  if (widgetEl) { try { widgetEl.remove(); } catch (_) {} widgetEl = null; }
}

function safeSendMessage(message) {
  if (!isContextValid()) {
    cleanupOrphan();
    return Promise.resolve(null);
  }
  try {
    return chrome.runtime.sendMessage(message).catch(err => {
      if (err?.message?.includes('Extension context invalidated')) {
        cleanupOrphan();
      }
    });
  } catch (err) {
    if (err?.message?.includes('Extension context invalidated')) {
      cleanupOrphan();
    }
    return Promise.resolve(null);
  }
}

// === URL Detection ===
function isHomeFeed() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  return path === '/' || path === '/home';
}

function isSupportedPage() {
  return /x\.com|twitter\.com/.test(location.hostname);
}

// === Tweet Extraction ===
function hasMediaInArticle(article, text = '') {
  // Check text content for pic.x or pic.twitter links
  if (/pic\.(?:twitter|x)\.com/i.test(text) || /\bpic\.x\b/i.test(text)) {
    return true;
  }

  // Check link targets inside the tweet article
  const hasMediaLink = !!article.querySelector('a[href*="/photo/"], a[href*="/video/"], a[href*="pic.twitter.com"], a[href*="pic.x.com"]');
  if (hasMediaLink) return true;

  // Check photo containers & images
  const hasPhoto = !!article.querySelector(
    '[data-testid="tweetPhoto"], img[src*="pbs.twimg.com/media/"], div[aria-label*="Image" i], div[aria-label*="Photo" i]'
  );
  if (hasPhoto) return true;

  // Check video/GIF players
  const hasVideo = !!article.querySelector(
    '[data-testid="videoPlayer"], [data-testid="videoComponent"], video, [data-testid="tweetVideo"], [data-testid="playButton"], div[aria-label*="video" i], div[aria-label*="gif" i], div[aria-label*="Embedded video" i], div[aria-label*="Embedded media" i]'
  );
  if (hasVideo) return true;

  return false;
}

function postFromArticle(article) {
  const link = [...article.querySelectorAll('a[href*="/status/"]')].find(a => /\/status\/\d+/.test(a.getAttribute('href') || ''));
  const id = link?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1];
  const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim();
  if (!id || !text) return null;
  const hasMedia = hasMediaInArticle(article, text);
  return { id, text, url: new URL(link.href, location.origin).href, author: article.querySelector('[data-testid="User-Name"]')?.innerText?.split('\n')[0] || '', tabId: undefined, hasMedia };
}

function elementIsVisible(element) {
  const r = element.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight;
}

function currentPost() {
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].filter(elementIsVisible);
  articles.sort((a, b) => Math.abs(a.getBoundingClientRect().top - innerHeight / 2) - Math.abs(b.getBoundingClientRect().top - innerHeight / 2));
  if (!articles[0]) return null;
  return postFromArticle(articles[0]);
}

// === Announce Posts to Service Worker ===
function announce(post) {
  if (!isContextValid()) { cleanupOrphan(); return; }
  if (!post || announced.has(post.id)) return;
  announced.add(post.id);
  safeSendMessage({ type: 'VISIBLE_POSTS', posts: [post] });
}

function announceAllVisible() {
  if (!isContextValid()) { cleanupOrphan(); return []; }
  const posts = [];
  document.querySelectorAll('article[data-testid="tweet"]').forEach(el => {
    if (elementIsVisible(el)) {
      const post = postFromArticle(el);
      if (post && !announced.has(post.id)) {
        announced.add(post.id);
        posts.push(post);
      }
    }
  });
  if (posts.length > 0) {
    safeSendMessage({ type: 'VISIBLE_POSTS', posts });
  }
  return posts;
}

// === Observer ===
function startObserver() {
  if (!isContextValid()) { cleanupOrphan(); return; }
  if (observer) return;
  observer = new IntersectionObserver(entries => {
    if (!isContextValid()) { cleanupOrphan(); return; }
    if (started) {
      entries.filter(entry => entry.isIntersecting).forEach(entry => announce(postFromArticle(entry.target)));
    }
  }, { threshold: 0.25 });
  const observeArticles = () => {
    if (!isContextValid()) { cleanupOrphan(); return; }
    document.querySelectorAll('article[data-testid="tweet"]').forEach(el => observer?.observe(el));
  };
  observeArticles();
  if (mutationObs) mutationObs.disconnect();
  mutationObs = new MutationObserver(observeArticles);
  mutationObs.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  if (observer) { observer.disconnect(); observer = null; }
  if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
}

// === SPA Navigation Watcher ===
function onNavigate() {
  if (!isContextValid()) { cleanupOrphan(); return; }
  if (started && isSupportedPage()) {
    setTimeout(() => {
      stopObserver();
      startObserver();
      announceAllVisible();
    }, 1500);
  }
}

// X uses history.pushState for navigation — watch for URL changes via DOM mutations
navWatcher = new MutationObserver(() => {
  if (!isContextValid()) { cleanupOrphan(); return; }
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    onNavigate();
  }
});
navWatcher.observe(document.body, { childList: true, subtree: true });

// Also handle back/forward
window.addEventListener('popstate', () => {
  if (!isContextValid()) { cleanupOrphan(); return; }
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    onNavigate();
  }
});

// Check on load if the extension session is already running
safeSendMessage({ type: 'SNAPSHOT' }).then(res => {
  if (res?.runtime?.state === 'running' && isSupportedPage()) {
    started = true;
    startObserver();
    setTimeout(announceAllVisible, 1000);
  }
  syncWidgetState(res?.runtime);
}).catch(() => {});

// === Floating Live Status Widget on x.com ===
let widgetEl = null;
let widgetTimer = null;
let widgetState = { active: false, status: 'Idle', nextAt: 0, text: '' };

function createStatusWidget() {
  if (widgetEl || !document.body) return;
  widgetEl = document.createElement('div');
  widgetEl.id = 'pxai-floating-widget';
  widgetEl.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 999999;
    background: rgba(11, 16, 24, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(56, 189, 248, 0.4);
    border-radius: 9999px;
    padding: 8px 16px;
    color: #e8edf5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 0 15px rgba(56, 189, 248, 0.25);
    display: flex;
    align-items: center;
    gap: 9px;
    transition: all 0.3s ease;
    user-select: none;
    pointer-events: auto;
  `;

  const dot = document.createElement('span');
  dot.id = 'pxai-dot';
  dot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 8px #38bdf8;';

  const label = document.createElement('span');
  label.id = 'pxai-label';
  label.textContent = 'Personal X AI';

  const timerSpan = document.createElement('span');
  timerSpan.id = 'pxai-timer';
  timerSpan.style.cssText = 'color: #38bdf8; font-variant-numeric: tabular-nums; font-weight: 700;';

  widgetEl.appendChild(dot);
  widgetEl.appendChild(label);
  widgetEl.appendChild(timerSpan);
  document.body.appendChild(widgetEl);

  if (!widgetTimer) {
    widgetTimer = setInterval(updateWidgetDisplay, 1000);
  }
}

function updateWidgetDisplay() {
  if (!isContextValid()) { cleanupOrphan(); return; }
  if (!widgetEl) return;
  const label = widgetEl.querySelector('#pxai-label');
  const timerSpan = widgetEl.querySelector('#pxai-timer');
  const dot = widgetEl.querySelector('#pxai-dot');

  if (!widgetState.active) {
    widgetEl.style.display = 'none';
    return;
  }
  widgetEl.style.display = 'flex';

  if (widgetState.nextAt && widgetState.nextAt > Date.now()) {
    const diff = Math.max(0, Math.floor((widgetState.nextAt - Date.now()) / 1000));
    const mins = Math.floor(diff / 60).toString().padStart(2, '0');
    const secs = (diff % 60).toString().padStart(2, '0');
    label.textContent = widgetState.text || 'Next reply in:';
    timerSpan.textContent = `${mins}:${secs}`;
    const dotColor = widgetState.isSleeping ? '#a855f7' : '#38bdf8';
    dot.style.background = dotColor;
    dot.style.boxShadow = `0 0 8px ${dotColor}`;
  } else {
    label.textContent = widgetState.status || 'Active';
    timerSpan.textContent = '';
    dot.style.background = '#22c55e';
    dot.style.boxShadow = '0 0 8px #22c55e';
  }
}

function syncWidgetState(runtime) {
  if (!runtime) return;
  widgetState.active = runtime.state === 'running';
  widgetState.nextAt = runtime.nextAt || 0;
  if (runtime.sleepUntil && runtime.sleepUntil > Date.now()) {
    widgetState.status = 'Sleeping (5m break)';
    widgetState.text = 'Sleeping · Resumes in:';
    widgetState.isSleeping = true;
    widgetState.nextAt = runtime.sleepUntil;
  } else {
    widgetState.status = runtime.processing ? 'Posting reply...' : (runtime.state === 'running' ? 'Scanning feed' : 'Paused');
    widgetState.text = runtime.pendingSubmitId ? 'Next reply in:' : 'Next action in:';
    widgetState.isSleeping = false;
  }
  createStatusWidget();
  updateWidgetDisplay();
}

// === Reply & Interaction Helpers ===
async function waitForElement(selectorOrFn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = typeof selectorOrFn === 'function' ? selectorOrFn() : document.querySelector(selectorOrFn);
    if (el) return el;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

async function clearEditor(editor) {
  editor.focus();
  await new Promise(r => setTimeout(r, 80));

  // If there is any existing text, completely wipe it (Ctrl+A -> Del)
  if (editor.textContent && editor.textContent.trim().length > 0) {
    // 1. Use Selection API to select all children inside the editor
    try {
      const selection = window.getSelection();
      selection.selectAllChildren(editor);
      document.execCommand('delete', false, null);
    } catch (_) {}

    // 2. Reinforce with execCommand selectAll and delete
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch (_) {}

    // 3. Dispatch delete input events so React / Draft.js registers the deletion
    editor.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'deleteContentBackward'
    }));
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'deleteContentBackward'
    }));

    // 4. If text still stubbornly remains, force-clear textContent
    if (editor.textContent && editor.textContent.trim().length > 0) {
      editor.textContent = '';
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'deleteContentBackward'
      }));
    }

    // 5. Trigger blur & focus to ensure React state reflects the empty box
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.blur();
    await new Promise(r => setTimeout(r, 100));
    editor.focus();
    await new Promise(r => setTimeout(r, 100));
  }
}

async function clearAndInjectText(editor, text) {
  // Step 1: FIRST clean the text box completely (Ctrl+A -> Del) so replies never overlap
  await clearEditor(editor);

  // Step 2: Inject the clean new reply text
  editor.focus();
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasteEvent = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    });
    editor.dispatchEvent(pasteEvent);
  } catch (_) {}

  // Wait 300ms to see if Draft.js inserted the text
  await new Promise(r => setTimeout(r, 300));

  // Step 3: Secondary Method: If editor is still empty, use execCommand('insertText')
  if (!editor.textContent || !editor.textContent.trim()) {
    try {
      editor.focus();
      document.execCommand('insertText', false, text);
      editor.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: text
      }));
      editor.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: text
      }));
    } catch (_) {}
  }

  // Step 4: Tertiary Method: direct textContent if still empty
  if (!editor.textContent || !editor.textContent.trim()) {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: text
    }));
  }

  // Step 5: Notify React of input change and trigger brief blur/focus cycle to refresh state
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  editor.blur();
  await new Promise(r => setTimeout(r, 100));
  editor.focus();

  return !!editor.textContent.trim();
}

async function waitForReplyButton(editor, timeout = 6000) {
  const dialog = editor?.closest('[role="dialog"]');
  // STRICT: Only search within the active reply modal dialog. NEVER search outer document.
  if (!dialog) return null;

  const start = Date.now();
  while (Date.now() - start < timeout) {
    let candidates = [
      ...dialog.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')
    ];

    if (candidates.length === 0) {
      const allButtons = [...dialog.querySelectorAll('button, [role="button"]')];
      for (const btn of allButtons) {
        const txt = btn.textContent?.trim().toLowerCase();
        if (txt === 'reply' || txt === 'post') {
          candidates.push(btn);
        }
      }
    }

    const activeBtn = candidates.find(b => {
      const ariaDisabled = b.getAttribute('aria-disabled');
      const isDisabled = b.disabled || ariaDisabled === 'true' || b.getAttribute('disabled') !== null;
      return !isDisabled;
    });

    if (activeBtn) return activeBtn;

    // React state nudge if button hasn't flipped yet after 2 seconds
    if (candidates.length > 0 && Date.now() - start > 2000) {
      editor?.focus();
      editor?.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // Fallback: Return candidate button strictly from the dialog
  const fallback = dialog.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
  if (fallback) {
    try {
      fallback.removeAttribute('disabled');
      fallback.setAttribute('aria-disabled', 'false');
    } catch (_) {}
    return fallback;
  }

  return null;
}

async function likePost(postId) {
  let article = [...document.querySelectorAll('article[data-testid="tweet"]')].find(a => postFromArticle(a)?.id === postId);
  if (!article) return { ok: false, error: 'Article not currently in DOM' };

  // If already liked (unlike button is visible), skip
  if (article.querySelector('[data-testid="unlike"]')) {
    return { ok: true, alreadyLiked: true };
  }

  const likeBtn = article.querySelector('[data-testid="like"]');
  if (!likeBtn) return { ok: false, error: 'Like button not found' };

  // Scroll gently toward the tweet like a human browsing
  try { article.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
  await new Promise(r => setTimeout(r, Math.floor(Math.random() * 350 + 350)));

  likeBtn.click();
  return { ok: true, liked: true };
}

// === Message Handlers ===
chrome.runtime.onMessage.addListener((message, _, respond) => {
  if (message.type === 'STATE_UPDATE') {
    syncWidgetState(message.runtime);
    respond({ ok: true });
    return;
  }

  if (message.type === 'LIKE_POST') {
    (async () => {
      const res = await likePost(message.postId);
      respond(res);
    })();
    return true;
  }

  if (message.type === 'SCAN_NOW') {
    if (!isSupportedPage()) return respond({ ok: false, error: 'Navigate to x.com/home to start scanning.' });
    const initial = currentPost();
    if (!initial) return respond({ ok: false, error: 'No readable X post is visible.' });
    document.querySelectorAll('article[data-testid="tweet"]').forEach(el => {
      if (elementIsVisible(el)) {
        const post = postFromArticle(el);
        if (post) announced.add(post.id);
      }
    });
    safeSendMessage({ type: 'VISIBLE_POSTS', posts: [initial] });
    startObserver();
    started = true;
    respond({ ok: true });
  }

  if (message.type === 'SCROLL_FEED') {
    (async () => {
      if (scrolling) return respond({ ok: false, posts: [], error: 'Already scrolling.' });
      scrolling = true;
      try {
        window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
        // Wait for scroll animation + new tweets to render
        await new Promise(r => setTimeout(r, 2500));
        const posts = announceAllVisible();
        respond({ ok: true, posts });
      } catch (e) {
        respond({ ok: false, posts: [], error: e.message });
      } finally {
        scrolling = false;
      }
    })();
    return true; // keep channel open for async respond
  }

  if (message.type === 'SUBMIT_REPLY') {
    (async () => {
      // Find the tweet article by post ID
      let article = [...document.querySelectorAll('article[data-testid="tweet"]')].find(a => postFromArticle(a)?.id === message.postId);
      if (!article) return respond({ ok: false, error: 'The original post is no longer visible on screen.' });

      // Scroll article into view gently to ensure interactive buttons are active
      try { article.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
      await new Promise(r => setTimeout(r, 400));

      // Click the reply icon on the tweet
      const replyBtn = article.querySelector('button[data-testid="reply"], [role="button"][data-testid="reply"]') || article.querySelector('[data-testid="reply"]');
      if (!replyBtn) return respond({ ok: false, error: 'X reply button was not found on the target tweet.' });
      replyBtn.focus();
      replyBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      replyBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      replyBtn.click();

      // Give 600ms; if dialog hasn't opened yet, click again
      await new Promise(r => setTimeout(r, 600));
      if (!document.querySelector('[role="dialog"]')) {
        replyBtn.click();
      }

      // Wait strictly for the reply modal dialog to appear (NEVER fall back to home feed composer)
      const editor = await waitForElement(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return null;
        return dialog.querySelector('[data-testid="tweetTextarea_0"]')
          || dialog.querySelector('[contenteditable="true"]');
      }, 5000);

      if (!editor || !editor.closest('[role="dialog"]')) {
        return respond({
          ok: false,
          error: 'Reply modal did not open. Aborted to prevent posting a standalone tweet on your account.'
        });
      }

      // Clean the text box and inject clean reply text
      const inserted = await clearAndInjectText(editor, message.draft);
      if (!inserted) return respond({ ok: false, error: 'Failed to insert text into the reply editor.' });

      // Human pause: wait 3 seconds after writing the reply before clicking the Post/Reply button
      await new Promise(r => setTimeout(r, 3000));

      // Wait for the active Reply/Post button in the composer
      const button = await waitForReplyButton(editor, 6000);

      // Helper for keyboard Ctrl+Enter submission with keyCode: 13
      const dispatchCtrlEnter = (el) => {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ctrlKey: true, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
      };

      if (button) {
        button.focus();
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        button.click();
      }

      // Also trigger keyboard submission
      editor.focus();
      dispatchCtrlEnter(editor);

      // Wait up to 3.5s to verify submission / modal close
      let modalClosed = false;
      for (let i = 0; i < 14; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (!document.querySelector('[role="dialog"]')) {
          modalClosed = true;
          break;
        }
      }

      // Backup: if modal is still open, trigger Ctrl+Enter once more
      if (!modalClosed) {
        const currentDialog = document.querySelector('[role="dialog"]');
        const activeEditor = currentDialog?.querySelector('[data-testid="tweetTextarea_0"]') || editor;
        if (activeEditor) {
          activeEditor.focus();
          dispatchCtrlEnter(activeEditor);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      respond({ ok: true });
    })();
    return true; // keep channel open for async respond
  }
});
