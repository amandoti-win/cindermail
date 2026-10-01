// Self-contained HTML for the public counter page, served by src/worker.ts.
// No external assets: inline CSS/JS, matches the Worker's own
// bundle-everything constraint.
export function renderCounterPage(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cindermail Status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(ellipse at 50% 20%, #2a1508 0%, #120a06 55%, #0a0605 100%);
    color: #ffe8d6;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: center;
  }
  main { padding: 2rem; position: relative; }
  .embers { position: fixed; inset: 0; pointer-events: none; overflow: hidden; }
  .ember {
    position: absolute;
    bottom: -1rem;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #ff9d52;
    box-shadow: 0 0 6px 1px rgba(255,140,50,0.8);
    animation: rise linear infinite;
    opacity: 0;
  }
  @keyframes rise {
    0% { transform: translateY(0) translateX(0); opacity: 0; }
    10% { opacity: 0.8; }
    100% { transform: translateY(-100vh) translateX(var(--drift, 20px)); opacity: 0; }
  }
  .flame {
    font-size: 3rem;
    display: inline-block;
    filter: drop-shadow(0 0 18px rgba(255,120,40,0.6));
    animation: flicker 2.6s ease-in-out infinite;
  }
  @keyframes flicker {
    0%, 100% { transform: scale(1) rotate(0deg); filter: drop-shadow(0 0 18px rgba(255,120,40,0.6)); }
    25% { transform: scale(1.05) rotate(-2deg); filter: drop-shadow(0 0 24px rgba(255,140,50,0.75)); }
    50% { transform: scale(0.97) rotate(1deg); filter: drop-shadow(0 0 14px rgba(255,100,30,0.5)); }
    75% { transform: scale(1.03) rotate(-1deg); filter: drop-shadow(0 0 22px rgba(255,150,60,0.7)); }
  }
  h1 {
    margin: 0.25rem 0 2rem;
    font-size: 1.75rem;
    letter-spacing: 0.02em;
    color: #ff9d52;
    animation: glow 2.6s ease-in-out infinite;
  }
  @keyframes glow {
    0%, 100% { text-shadow: 0 0 12px rgba(255,140,50,0.3); }
    50% { text-shadow: 0 0 22px rgba(255,140,50,0.6); }
  }
  .panel { width: min(360px, 88vw); margin: 2rem auto 0; text-align: left; }
  .status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-bottom: 0.9rem;
    margin-bottom: 0.9rem;
    border-bottom: 1px solid #3a2013;
    font-size: 0.9rem;
    color: #e8c4a3;
  }
  .status .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 6px 1px rgba(74,222,128,0.6);
    flex-shrink: 0;
  }
  .status.down .dot {
    background: #f87171;
    box-shadow: 0 0 6px 1px rgba(248,113,113,0.6);
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.6rem 0;
    border-bottom: 1px solid #241209;
    font-size: 0.9rem;
  }
  .row:last-of-type { border-bottom: none; }
  .row .label { color: #c99b7a; }
  .row .n {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    color: #ffb877;
    transition: color 0.3s;
  }
  .row .n.bump { color: #fff2e2; }
  .links {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.25rem;
    margin-top: 1.25rem;
  }
  .links a {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: #a8785a;
    text-decoration: none;
    font-size: 0.8rem;
    transition: color 0.15s;
  }
  .links a:hover { color: #ffcaa1; }
  .links a svg { width: 0.9rem; height: 0.9rem; fill: currentColor; }
  .version { margin-top: 0.5rem; font-size: 0.7rem; color: #5c4432; }
  .note { margin: 1rem auto 0; font-size: 0.75rem; color: #7a5b41; max-width: 320px; }
</style>
</head>
<body>
<div class="embers" id="embers"></div>
<main>
  <div class="flame">🔥</div>
  <h1>Cindermail Status</h1>
  <div class="panel">
    <div class="status" id="status"><span class="dot"></span><span id="statusText">Connecting…</span></div>
    <div class="row"><span class="label">Addresses created</span><span class="n" id="created">-</span></div>
    <div class="row"><span class="label">Emails received</span><span class="n" id="received">-</span></div>
    <div class="row"><span class="label">Torched</span><span class="n" id="torched">-</span></div>
    <div class="row"><span class="label">Users with active addresses</span><span class="n" id="users">-</span></div>
  </div>
  <div class="links">
    <a href="https://github.com/amandoti-win/cindermail" target="_blank" rel="noopener">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
      Source
    </a>
    <a href="https://bsky.app/profile/amandoti.win" target="_blank" rel="noopener">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 6.5C7.2 4.9 5.1 1.9 3.1.5 1.2-.9.4-.1.1.4c-.4.6-.1 3.3.1 3.8.6 1.9 2.7 2.5 4.6 2.3-3 .4-5.6 1.6-2.1 5.5 3.7 4 5.1-.9 5.7-2.9.5 2 2.4 6.5 5.6 2.9 3.3-3.9.9-5.1-2.1-5.5 1.9.2 4-.4 4.6-2.3.2-.5.5-3.2.1-3.8-.3-.5-1.1-1.3-3-.1C10.9 1.9 8.8 4.9 8 6.5Z"/></svg>
      Bluesky
    </a>
  </div>
  <div class="version">v${version}</div>
  <p class="note">Live status for private hosted instance.</p>
</main>
<script>
  // 30 minutes: how long a fetched result is trusted for, and the minimum
  // gap between hits to /counters. Cached in localStorage rather than just
  // relying on setInterval, since a plain interval resets on every page
  // load/refresh, letting someone who keeps reloading poll far more often
  // than intended. The cache makes that impossible: a reload within the
  // window renders instantly from what's stored and only schedules the next
  // real fetch for whatever time is left.
  const POLL_INTERVAL_MS = 30 * 60 * 1000;
  const CACHE_KEY = 'cindermail-counters-v1';

  let last = { created: null, torched: null, received: null, users: null };

  function setStat(id, value) {
    const el = document.getElementById(id);
    el.textContent = value.toLocaleString();
    if (last[id] !== null && last[id] !== value) {
      el.classList.remove('bump');
      void el.offsetWidth; // restart the animation if it's still running
      el.classList.add('bump');
    }
    last[id] = value;
  }

  function setStatus(ok) {
    const status = document.getElementById('status');
    const text = document.getElementById('statusText');
    status.classList.toggle('down', !ok);
    text.textContent = ok ? 'All systems operational' : 'Unable to reach the service';
  }

  function renderData(data) {
    setStat('created', data.created);
    setStat('torched', data.torched);
    setStat('received', data.received);
    setStat('users', data.users);
    setStatus(true);
  }

  // Both wrapped in try/catch: localStorage throws in some private-browsing
  // modes rather than just being empty, and a failure here should degrade to
  // "always fetch", never break the page.
  function loadCache() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_KEY));
      return typeof parsed.timestamp === 'number' && parsed.data ? parsed : null;
    } catch {
      return null;
    }
  }

  function saveCache(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
    } catch {
      // Nothing cached this round; next load just fetches fresh instead.
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/counters');
      if (!res.ok) {
        setStatus(false);
        return;
      }
      const data = await res.json();
      renderData(data);
      saveCache(data);
    } catch {
      // Next tick retries, status pill already reflects the failure.
      setStatus(false);
    }
  }

  const cached = loadCache();
  if (cached) {
    renderData(cached.data);
    const remaining = Math.max(0, POLL_INTERVAL_MS - (Date.now() - cached.timestamp));
    setTimeout(() => {
      refresh();
      setInterval(refresh, POLL_INTERVAL_MS);
    }, remaining);
  } else {
    refresh();
    setInterval(refresh, POLL_INTERVAL_MS);
  }

  // A handful of embers drifting up from the bottom of the screen, spaced
  // out on a stagger so they don't all rise in lockstep.
  const embers = document.getElementById('embers');
  for (let i = 0; i < 14; i++) {
    const ember = document.createElement('div');
    ember.className = 'ember';
    ember.style.left = Math.random() * 100 + 'vw';
    ember.style.setProperty('--drift', (Math.random() * 60 - 30) + 'px');
    ember.style.animationDuration = 6 + Math.random() * 6 + 's';
    ember.style.animationDelay = Math.random() * 10 + 's';
    embers.appendChild(ember);
  }
</script>
</body>
</html>`;
}
