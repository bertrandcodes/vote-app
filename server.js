const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory state
let session = null; // { id, names, votes: { name: count }, createdAt }

function newSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

// ── Admin: setup page ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const hasSess = !!session;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vote App — Setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: white; border-radius: 12px; padding: 36px; width: 460px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.5rem; margin-bottom: 6px; }
  p.sub { color: #666; font-size: .9rem; margin-bottom: 24px; }
  .name-row { display: flex; gap: 8px; margin-bottom: 10px; }
  .name-row input { flex: 1; padding: 9px 12px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 1rem; }
  .name-row input:focus { outline: none; border-color: #4f46e5; }
  button.primary { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 8px; }
  button.primary:hover { background: #4338ca; }
  button.secondary { width: 100%; padding: 10px; background: white; color: #4f46e5; border: 1.5px solid #4f46e5; border-radius: 8px; font-size: .95rem; cursor: pointer; margin-top: 10px; }
  button.secondary:hover { background: #f5f3ff; }
  .active-banner { background: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px; font-size: .9rem; color: #065f46; }
  #nameFields .name-row:last-child input { }
</style>
</head>
<body>
<div class="card">
  <h1>Vote App</h1>
  <p class="sub">Enter up to 10 names, then generate a voting QR code.</p>

  ${hasSess ? `<div class="active-banner">
    ✅ A session is currently active with <strong>${session.names.length} candidates</strong>.
    Starting a new session will reset all votes.
  </div>` : ''}

  <form method="POST" action="/setup">
    <div id="nameFields">
      ${Array.from({ length: 10 }, (_, i) => `
      <div class="name-row">
        <input type="text" name="names" placeholder="Name ${i + 1}" maxlength="60"
          value="${hasSess && session.names[i] ? escapeHtml(session.names[i]) : ''}">
      </div>`).join('')}
    </div>
    <button type="submit" class="primary">Generate QR Code &amp; Start Voting</button>
  </form>

  ${hasSess ? `<a href="/results"><button class="secondary" type="button">View Live Results →</button></a>` : ''}
</div>
</body>
</html>`);
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Admin: create session ──────────────────────────────────────────────────────
app.post('/setup', (req, res) => {
  let names = (Array.isArray(req.body.names) ? req.body.names : [req.body.names])
    .map(n => (n || '').trim())
    .filter(Boolean)
    .slice(0, 10);

  if (names.length < 2) {
    return res.redirect('/?error=need2');
  }

  // Deduplicate (case-insensitive)
  const seen = new Set();
  names = names.filter(n => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  session = {
    id: newSessionId(),
    names,
    votes: Object.fromEntries(names.map(n => [n, 0])),
    createdAt: Date.now(),
    voters: new Set(), // track by IP to prevent double-vote
  };

  res.redirect('/qr');
});

// ── Admin: QR code page ────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  if (!session) return res.redirect('/');

  const host = req.headers.host || `localhost:${PORT}`;
  const voteUrl = `http://${host}/vote/${session.id}`;
  const qrDataUrl = await QRCode.toDataURL(voteUrl, { width: 280, margin: 2 });

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vote App — QR Code</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: white; border-radius: 12px; padding: 36px; width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 1.4rem; margin-bottom: 6px; }
  p.sub { color: #666; font-size: .9rem; margin-bottom: 24px; }
  .qr-wrap { display: inline-block; padding: 16px; border: 2px solid #e5e7eb; border-radius: 12px; margin-bottom: 20px; }
  .qr-wrap img { display: block; }
  .url { font-size: .8rem; color: #6b7280; word-break: break-all; margin-bottom: 24px; }
  a.url-link { color: #4f46e5; }
  .names { text-align: left; background: #f9fafb; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px; }
  .names h3 { font-size: .85rem; color: #6b7280; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .05em; }
  .names ul { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
  .names ul li { background: #ede9fe; color: #4f46e5; font-size: .85rem; padding: 3px 10px; border-radius: 999px; }
  button.primary { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; }
  button.primary:hover { background: #4338ca; }
  button.secondary { width: 100%; padding: 10px; background: white; color: #4f46e5; border: 1.5px solid #4f46e5; border-radius: 8px; font-size: .95rem; cursor: pointer; margin-top: 10px; }
</style>
</head>
<body>
<div class="card">
  <h1>Scan to Vote</h1>
  <p class="sub">Share this QR code with voters. Results update in real time.</p>
  <div class="qr-wrap"><img src="${qrDataUrl}" width="248" height="248" alt="QR Code"></div>
  <p class="url">or open: <a class="url-link" href="/vote/${session.id}" target="_blank">${voteUrl}</a></p>
  <div class="names">
    <h3>Candidates (${session.names.length})</h3>
    <ul>${session.names.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
  </div>
  <a href="/results"><button class="primary" type="button">View Live Results →</button></a>
  <a href="/"><button class="secondary" type="button">Start New Session</button></a>
</div>
</body>
</html>`);
});

// ── Voter: vote page ───────────────────────────────────────────────────────────
app.get('/vote/:id', (req, res) => {
  if (!session || session.id !== req.params.id) {
    return res.status(404).send(errorPage('This voting session is no longer active.'));
  }

  const ip = req.ip;
  const alreadyVoted = session.voters.has(ip);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cast Your Vote</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 32px; width: 100%; max-width: 420px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.4rem; margin-bottom: 6px; }
  p.sub { color: #666; font-size: .9rem; margin-bottom: 24px; }
  .choice { display: block; width: 100%; padding: 14px 18px; margin-bottom: 10px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; font-size: 1.05rem; cursor: pointer; text-align: left; transition: all .15s; }
  .choice:hover:not(:disabled) { border-color: #4f46e5; background: #f5f3ff; color: #4f46e5; }
  .choice:disabled { opacity: .5; cursor: not-allowed; }
  .voted-msg { background: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 8px; padding: 16px; color: #065f46; font-size: .95rem; margin-top: 8px; }
</style>
</head>
<body>
<div class="card">
  <h1>Cast Your Vote</h1>
  <p class="sub">${alreadyVoted ? 'You have already voted in this session.' : 'Tap a name to cast your vote. You can only vote once.'}</p>
  ${alreadyVoted
    ? `<div class="voted-msg">✅ Your vote has been recorded. Thank you!</div>`
    : `<form method="POST" action="/vote/${session.id}">
      ${session.names.map(n => `<button type="submit" name="vote" value="${escapeHtml(n)}" class="choice">${escapeHtml(n)}</button>`).join('')}
    </form>`}
</div>
</body>
</html>`);
});

// ── Voter: submit vote ─────────────────────────────────────────────────────────
app.post('/vote/:id', (req, res) => {
  if (!session || session.id !== req.params.id) {
    return res.status(404).send(errorPage('This voting session is no longer active.'));
  }

  const ip = req.ip;
  if (session.voters.has(ip)) {
    return res.redirect(`/vote/${session.id}`);
  }

  const choice = req.body.vote;
  if (!session.votes.hasOwnProperty(choice)) {
    return res.status(400).send(errorPage('Invalid vote choice.'));
  }

  session.votes[choice]++;
  session.voters.add(ip);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vote Recorded</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 36px; width: 100%; max-width: 380px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  .check { font-size: 3rem; margin-bottom: 16px; }
  h1 { font-size: 1.4rem; margin-bottom: 8px; }
  p { color: #6b7280; }
  .name { display: inline-block; margin-top: 14px; padding: 6px 18px; background: #ede9fe; color: #4f46e5; border-radius: 999px; font-weight: 600; font-size: 1rem; }
</style>
</head>
<body>
<div class="card">
  <div class="check">✅</div>
  <h1>Vote Recorded!</h1>
  <p>You voted for</p>
  <div class="name">${escapeHtml(choice)}</div>
</div>
</body>
</html>`);
});

// ── Admin: live results page ───────────────────────────────────────────────────
app.get('/results', (req, res) => {
  if (!session) return res.redirect('/');

  const total = Object.values(session.votes).reduce((a, b) => a + b, 0);
  const sorted = [...session.names].sort((a, b) => session.votes[b] - session.votes[a]);

  const bars = sorted.map((name, i) => {
    const count = session.votes[name];
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const isLeader = i === 0 && count > 0;
    return `
    <div class="row" style="--pct:${pct}%">
      <div class="label">${isLeader ? '🏆 ' : ''}${escapeHtml(name)}</div>
      <div class="bar-wrap"><div class="bar${isLeader ? ' leader' : ''}"></div></div>
      <div class="count">${count} <span class="pct">(${pct}%)</span></div>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Results</title>
<meta http-equiv="refresh" content="5">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 40px 20px; }
  .card { background: white; border-radius: 12px; padding: 36px; width: 100%; max-width: 560px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .meta { color: #6b7280; font-size: .875rem; margin-bottom: 28px; }
  .row { display: grid; grid-template-columns: 180px 1fr 80px; align-items: center; gap: 12px; margin-bottom: 16px; }
  .label { font-size: .95rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-wrap { background: #f3f4f6; border-radius: 999px; height: 20px; overflow: hidden; }
  .bar { height: 100%; width: var(--pct); background: #818cf8; border-radius: 999px; transition: width .4s ease; }
  .bar.leader { background: #4f46e5; }
  .count { font-size: .9rem; color: #374151; font-weight: 600; }
  .pct { font-weight: 400; color: #9ca3af; }
  .total { margin-top: 28px; padding-top: 20px; border-top: 1px solid #e5e7eb; font-size: .9rem; color: #6b7280; display: flex; justify-content: space-between; align-items: center; }
  .refresh-note { font-size: .78rem; color: #9ca3af; }
  button.secondary { margin-top: 20px; width: 100%; padding: 10px; background: white; color: #4f46e5; border: 1.5px solid #4f46e5; border-radius: 8px; font-size: .95rem; cursor: pointer; }
  button.secondary:hover { background: #f5f3ff; }
</style>
</head>
<body>
<div class="card">
  <h1>Live Results</h1>
  <div class="meta">Session started ${new Date(session.createdAt).toLocaleTimeString()}</div>
  ${bars}
  <div class="total">
    <span><strong>${total}</strong> vote${total !== 1 ? 's' : ''} cast</span>
    <span class="refresh-note">Auto-refreshes every 5s</span>
  </div>
  <a href="/qr"><button class="secondary" type="button">← Back to QR Code</button></a>
</div>
</body>
</html>`);
});

// ── Results JSON API (for polling if desired) ──────────────────────────────────
app.get('/api/results', (req, res) => {
  if (!session) return res.json({ error: 'no session' });
  res.json({ names: session.names, votes: session.votes, total: Object.values(session.votes).reduce((a, b) => a + b, 0) });
});

function errorPage(msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;}
.card{background:white;padding:32px;border-radius:12px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);}
p{color:#6b7280;margin-top:8px;}</style></head>
<body><div class="card"><h2>Oops</h2><p>${escapeHtml(msg)}</p></div></body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Vote app running at http://localhost:${PORT}`);
  console.log(`  Setup:   http://localhost:${PORT}/`);
  console.log(`  Results: http://localhost:${PORT}/results`);
});
