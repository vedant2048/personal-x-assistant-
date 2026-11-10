const $ = id => document.getElementById(id);
let snapshot;
async function call(message) { return chrome.runtime.sendMessage(message); }
function escapeHtml(value='') { const div = document.createElement('div'); div.textContent = value; return div.innerHTML; }

async function refresh() {
  snapshot = await call({ type: 'SNAPSHOT' });
  const { runtime, settings, posts, counters } = snapshot;

  let statusText = runtime.state[0].toUpperCase() + runtime.state.slice(1);
  if (runtime.sleepUntil && runtime.sleepUntil > Date.now()) statusText = 'Sleeping · 5m Rest Break';
  else if (runtime.processing) statusText += ' · Processing';
  else if (runtime.pendingSubmitId && runtime.nextAt) statusText += ` · Reply at ${new Date(runtime.nextAt).toLocaleTimeString()}`;
  else if (runtime.nextAt) statusText += ` · Next at ${new Date(runtime.nextAt).toLocaleTimeString()}`;
  $('status').textContent = statusText;

  ['seen', 'liked', 'submitted', 'failed'].forEach(id => {
    if ($(id)) $(id).textContent = counters[id] || 0;
  });

  if ($('sleep-toggle')) $('sleep-toggle').checked = settings.sleepCycleEnabled !== false;

  updateCountdownUI();

  if ($('provider')) $('provider').value = settings.provider || 'gemini';
  $('model').value = settings.model || 'gemini-3.5-flash-lite';
  $('proxy-url').value = settings.proxyUrl;
  $('min').value = settings.minIntervalSeconds;
  $('max').value = settings.maxIntervalSeconds;

  const pendingPost = runtime.pendingSubmitId ? posts.find(p => p.id === runtime.pendingSubmitId) : null;
  const lastSubmitted = posts.find(p => p.status === 'submitted');

  if (pendingPost && runtime.nextAt) {
    $('current').classList.remove('muted');
    $('current').innerHTML = `<b style="color:#79b8ff">⏳ Scheduled for ${new Date(runtime.nextAt).toLocaleTimeString()}</b><p style="margin-top:6px">${escapeHtml(pendingPost.draft)}</p>`;
  } else if (lastSubmitted) {
    $('current').classList.remove('muted');
    $('current').innerHTML = `<b style="color:#56d364">✓ Last replied:</b><p style="margin-top:6px">${escapeHtml(lastSubmitted.draft)}</p>`;
  } else {
    $('current').classList.add('muted');
    $('current').textContent = 'Waiting for tech tweets...';
  }

  $('history').innerHTML = posts.slice(0, 6).map(p => {
    let postType = p.classification?.post_type ? p.classification.post_type.replace(/_/g, ' ').toLowerCase() : '';
    if (p.classification?.post_type === 'MEDIA_POST') postType = 'photo/video - skipped';
    const badge = postType ? ` <span style="font-size:10px;font-weight:normal;color:#96a2b4;">(${escapeHtml(postType)})</span>` : '';
    return `<div class="history-item"><b>${escapeHtml(p.status.replace('_', ' '))}${badge}</b><p>${escapeHtml(p.draft || p.text || p.error || '')}</p></div>`;
  }).join('') || '<p>No posts processed yet.</p>';

  $('notice').textContent = runtime.lastError || '';
}

async function action(message) {
  const result = await call(message);
  if (!result?.ok) $('notice').textContent = result?.error || 'Action failed.';
  await refresh();
}

$('start').onclick = () => action({ type: 'CONTROL', action: 'start' });
$('pause').onclick = () => action({ type: 'CONTROL', action: 'pause' });
$('stop').onclick = () => action({ type: 'CONTROL', action: 'stop' });

if ($('reset-btn')) {
  $('reset-btn').onclick = async () => {
    if (confirm('Are you sure you want to reset all counters and clear history?')) {
      await action({ type: 'RESET_COUNTERS' });
    }
  };
}

if ($('sleep-toggle')) {
  $('sleep-toggle').onchange = () => {
    action({ type: 'TOGGLE_SLEEP_CYCLE', enabled: $('sleep-toggle').checked });
  };
}

if ($('provider')) {
  $('provider').onchange = () => {
    const p = $('provider').value;
    if (p === 'gemini') $('model').value = 'gemini-3.5-flash-lite';
    else if (p === 'openrouter') $('model').value = 'openrouter/free';
    else if (p === 'groq') $('model').value = 'llama-3.3-70b-versatile';
  };
}

$('save').onclick = () => action({
  type: 'SAVE_SETTINGS',
  settings: {
    provider: $('provider') ? $('provider').value : 'gemini',
    model: $('model').value.trim() || 'gemini-3.5-flash-lite',
    proxyUrl: $('proxy-url').value.trim() || 'http://localhost:8787',
    minIntervalSeconds: Math.max(30, Math.min(300, Number($('min').value))),
    maxIntervalSeconds: Math.max(30, Math.min(300, Number($('max').value)))
  }
});

function updateCountdownUI() {
  const cd = $('countdown');
  const label = $('timer-label');
  const icon = $('timer-icon');
  if (!cd) return;
  const runtime = snapshot?.runtime;
  if (!runtime || runtime.state !== 'running') {
    cd.textContent = '--:--';
    cd.style.color = '#96a2b4';
    if (label) label.textContent = 'NEXT ACTION IN';
    if (icon) icon.textContent = '⏱️';
    return;
  }

  // Phase A: In 5-minute sleep break
  if (runtime.sleepUntil && runtime.sleepUntil > Date.now()) {
    const diff = Math.max(0, Math.floor((runtime.sleepUntil - Date.now()) / 1000));
    const m = Math.floor(diff / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');
    cd.textContent = `${m}:${s}`;
    cd.style.color = '#c084fc'; // purple for sleep
    if (label) label.textContent = 'SLEEPING (REST BREAK)';
    if (icon) icon.textContent = '💤';
  } else if (runtime.nextAt && runtime.nextAt > Date.now()) {
    const diff = Math.max(0, Math.floor((runtime.nextAt - Date.now()) / 1000));
    const m = Math.floor(diff / 60).toString().padStart(2, '0');
    const s = (diff % 60).toString().padStart(2, '0');
    cd.textContent = `${m}:${s}`;
    cd.style.color = '#38bdf8';
    if (label) label.textContent = runtime.pendingSubmitId ? 'NEXT REPLY IN' : 'NEXT ACTION IN';
    if (icon) icon.textContent = '⏱️';
  } else if (runtime.processing) {
    cd.textContent = 'Posting...';
    cd.style.color = '#56d364';
    if (label) label.textContent = 'IN PROGRESS';
    if (icon) icon.textContent = '⚡';
  } else {
    cd.textContent = 'Scanning';
    cd.style.color = '#79b8ff';
    if (label) label.textContent = 'FEED SCANNER';
    if (icon) icon.textContent = '🔍';
  }
}

setInterval(updateCountdownUI, 1000);

chrome.runtime.onMessage.addListener(message => { if (message.type === 'UPDATE') refresh(); });
refresh();
