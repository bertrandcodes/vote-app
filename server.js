const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const os = require('os');

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

const POLL_DEFS = [
  { title: 'Best Table Topic', key: 'p0', max: 10 },
  { title: 'Best Speaker',     key: 'p1', max: 4  },
  { title: 'Best Evaluator',   key: 'p2', max: 4  },
];

let session = null;

function newSessionId() {
  return crypto.randomBytes(8).toString('hex');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Admin: setup page ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const hasSess = !!session;

  const sections = POLL_DEFS.map((def, i) => {
    const pollNames = hasSess ? session.polls[i].names : [];
    const inputs = Array.from({ length: def.max }, (_, j) => `
      <div class="name-row">
        <input type="text" name="${def.key}" placeholder="Name ${j + 1}" maxlength="60"
          value="${pollNames[j] ? escapeHtml(pollNames[j]) : ''}">
      </div>`).join('');
    return `
    <div class="poll-section">
      <h3 class="poll-title">${escapeHtml(def.title)} <span class="max-label">(up to ${def.max})</span></h3>
      ${inputs}
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vote App — Setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 40px 20px; }
  .card { background: white; border-radius: 12px; padding: 36px; width: 100%; max-width: 500px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.5rem; margin-bottom: 6px; }
  p.sub { color: #666; font-size: .9rem; margin-bottom: 24px; }
  .poll-section { margin-bottom: 28px; }
  .poll-title { font-size: 1rem; font-weight: 700; color: #374151; margin-bottom: 10px; }
  .max-label { font-weight: 400; color: #9ca3af; font-size: .85rem; }
  .name-row { display: flex; gap: 8px; margin-bottom: 8px; }
  .name-row input { flex: 1; padding: 9px 12px; border: 1.5px solid #ddd; border-radius: 8px; font-size: .95rem; }
  .name-row input:focus { outline: none; border-color: #4f46e5; }
  button.primary { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 8px; }
  button.primary:hover { background: #4338ca; }
  button.secondary { width: 100%; padding: 10px; background: white; color: #4f46e5; border: 1.5px solid #4f46e5; border-radius: 8px; font-size: .95rem; cursor: pointer; margin-top: 10px; }
  button.secondary:hover { background: #f5f3ff; }
  .active-banner { background: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px; font-size: .9rem; color: #065f46; }
</style>
</head>
<body>
<div class="card">
  <h1>Vote App</h1>
  <p class="sub">Enter candidates for each category, then generate a voting QR code.</p>

  ${hasSess ? `<div class="active-banner">
    ✅ A session is currently active. Starting a new session will reset all votes.
  </div>` : ''}

  <form method="POST" action="/setup">
    ${sections}
    <button type="submit" class="primary">Generate QR Code &amp; Start Voting</button>
  </form>

  ${hasSess ? `<a href="/results"><button class="secondary" type="button">View Live Results →</button></a>` : ''}
</div>
</body>
</html>`);
});

// ── Admin: create session ──────────────────────────────────────────────────────
app.post('/setup', (req, res) => {
  const parseNames = (key, max) => {
    let names = (Array.isArray(req.body[key]) ? req.body[key] : [req.body[key]])
      .map(n => (n || '').trim())
      .filter(Boolean)
      .slice(0, max);
    const seen = new Set();
    return names.filter(n => {
      const k = n.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const polls = POLL_DEFS.map(def => {
    const names = parseNames(def.key, def.max);
    return { title: def.title, names, votes: Object.fromEntries(names.map(n => [n, 0])) };
  });

  session = {
    id: newSessionId(),
    polls,
    voters: new Set(),
    createdAt: Date.now(),
  };

  res.redirect('/qr');
});

// ── Admin: QR code page ────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  if (!session) return res.redirect('/');

  const requestHost = req.headers.host || `localhost:${PORT}`;
  const host = requestHost.startsWith('localhost') ? `${getLocalIP()}:${PORT}` : requestHost;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const voteUrl = `${protocol}://${host}/vote/${session.id}`;
  const qrDataUrl = await QRCode.toDataURL(voteUrl, { width: 280, margin: 2 });

  const pollLists = session.polls.map(p => `
    <div class="poll-block">
      <h3>${escapeHtml(p.title)}</h3>
      <ul>${p.names.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
    </div>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vote App — QR Code</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 36px; width: 100%; max-width: 460px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 1.4rem; margin-bottom: 6px; }
  p.sub { color: #666; font-size: .9rem; margin-bottom: 24px; }
  .qr-wrap { display: inline-block; padding: 16px; border: 2px solid #e5e7eb; border-radius: 12px; margin-bottom: 20px; }
  .qr-wrap img { display: block; }
  .url { font-size: .8rem; color: #6b7280; word-break: break-all; margin-bottom: 24px; }
  a.url-link { color: #4f46e5; }
  .candidates { text-align: left; background: #f9fafb; border-radius: 8px; padding: 14px 16px; margin-bottom: 24px; }
  .poll-block { margin-bottom: 12px; }
  .poll-block:last-child { margin-bottom: 0; }
  .poll-block h3 { font-size: .8rem; color: #6b7280; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .05em; }
  .poll-block ul { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
  .poll-block ul li { background: #ede9fe; color: #4f46e5; font-size: .85rem; padding: 3px 10px; border-radius: 999px; }
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
  <div class="candidates">${pollLists}</div>
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

  const cookies = parseCookies(req);
  const voterId = cookies[`voter_${session.id}`];
  const alreadyVoted = !!voterId && session.voters.has(voterId);

  const pollSections = session.polls.map((poll, i) => `
    <div class="poll-section">
      <h2 class="poll-heading">${escapeHtml(poll.title)}</h2>
      ${poll.names.map(n => `
        <label class="choice">
          <input type="radio" name="vote_${i}" value="${escapeHtml(n)}" required>
          <span>${escapeHtml(n)}</span>
        </label>`).join('')}
    </div>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cast Your Vote</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f0f2f5; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 32px; width: 100%; max-width: 460px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.4rem; margin-bottom: 6px; }
  p.sub { color: #666; font-size: .9rem; margin-bottom: 28px; }
  .poll-section { margin-bottom: 28px; }
  .poll-heading { font-size: 1.05rem; font-weight: 700; color: #111; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 2px solid #e5e7eb; }
  .choice { display: flex; align-items: center; width: 100%; padding: 13px 16px; margin-bottom: 8px; background: #f9fafb; border: 2px solid #e5e7eb; border-radius: 10px; font-size: 1rem; cursor: pointer; color: #111; transition: all .15s; }
  .choice:hover { border-color: #4f46e5; background: #f5f3ff; color: #4f46e5; }
  .choice:has(input:checked) { border-color: #4f46e5; background: #ede9fe; color: #4f46e5; }
  .choice input[type="radio"] { display: none; }
  button.primary { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 4px; }
  button.primary:hover { background: #4338ca; }
  .voted-msg { background: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 8px; padding: 16px; color: #065f46; font-size: .95rem; }
</style>
</head>
<body>
<div class="card">
  <h1>Cast Your Vote</h1>
  <p class="sub">${alreadyVoted ? 'You have already voted in this session.' : 'Select one name per category, then submit.'}</p>
  ${alreadyVoted
    ? `<div class="voted-msg">✅ Your votes have been recorded. Thank you!</div>`
    : `<form method="POST" action="/vote/${session.id}">
        ${pollSections}
        <button type="submit" class="primary">Submit All Votes</button>
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

  const cookies = parseCookies(req);
  const existingVoterId = cookies[`voter_${session.id}`];
  if (existingVoterId && session.voters.has(existingVoterId)) {
    return res.redirect(`/vote/${session.id}`);
  }

  const choices = session.polls.map((_, i) => req.body[`vote_${i}`]);

  for (let i = 0; i < session.polls.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(session.polls[i].votes, choices[i])) {
      return res.status(400).send(errorPage('Invalid vote choice.'));
    }
  }

  const newVoterId = crypto.randomBytes(16).toString('hex');
  for (let i = 0; i < session.polls.length; i++) {
    session.polls[i].votes[choices[i]]++;
  }
  session.voters.add(newVoterId);
  res.setHeader('Set-Cookie', `voter_${session.id}=${newVoterId}; HttpOnly; SameSite=Lax; Max-Age=86400`);

  const choiceItems = session.polls.map((poll, i) => `
    <div class="choice-item">
      <div class="category">${escapeHtml(poll.title)}</div>
      <div class="name-pill">${escapeHtml(choices[i])}</div>
    </div>`).join('');

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
  p { color: #6b7280; margin-bottom: 20px; }
  .choice-item { margin-bottom: 14px; }
  .category { font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; color: #9ca3af; margin-bottom: 8px; }
  .name-pill { display: inline-block; padding: 6px 18px; background: #ede9fe; color: #4f46e5; border-radius: 999px; font-weight: 600; font-size: 1rem; }
</style>
</head>
<body>
<div class="card">
  <div class="check">✅</div>
  <h1>Votes Recorded!</h1>
  <p>Your votes have been submitted.</p>
  ${choiceItems}
</div>
</body>
</html>`);
});

// ── Admin: live results page ───────────────────────────────────────────────────
app.get('/results', (req, res) => {
  if (!session) return res.redirect('/');

  const pollBlocks = session.polls.map(poll => {
    const total = Object.values(poll.votes).reduce((a, b) => a + b, 0);
    const sorted = [...poll.names].sort((a, b) => poll.votes[b] - poll.votes[a]);

    const bars = sorted.map((name, i) => {
      const count = poll.votes[name];
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      const isLeader = i === 0 && count > 0;
      return `
      <div class="row" style="--pct:${pct}%">
        <div class="label">${isLeader ? '🏆 ' : ''}${escapeHtml(name)}</div>
        <div class="bar-wrap"><div class="bar${isLeader ? ' leader' : ''}"></div></div>
        <div class="count">${count} <span class="pct">(${pct}%)</span></div>
      </div>`;
    }).join('');

    return `
    <div class="poll-block">
      <h2 class="poll-title">${escapeHtml(poll.title)}</h2>
      ${bars}
      <div class="subtotal"><strong>${total}</strong> vote${total !== 1 ? 's' : ''} cast</div>
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
  .card { background: white; border-radius: 12px; padding: 36px; width: 100%; max-width: 600px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 1.5rem; margin-bottom: 4px; }
  .meta { color: #6b7280; font-size: .875rem; margin-bottom: 32px; }
  .poll-block { margin-bottom: 36px; padding-bottom: 32px; border-bottom: 1px solid #e5e7eb; }
  .poll-block:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .poll-title { font-size: 1.1rem; font-weight: 700; color: #111; margin-bottom: 16px; }
  .row { display: grid; grid-template-columns: 160px 1fr 90px; align-items: center; gap: 12px; margin-bottom: 12px; }
  .label { font-size: .95rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-wrap { background: #f3f4f6; border-radius: 999px; height: 20px; overflow: hidden; }
  .bar { height: 100%; width: var(--pct); background: #818cf8; border-radius: 999px; transition: width .4s ease; }
  .bar.leader { background: #4f46e5; }
  .count { font-size: .9rem; color: #374151; font-weight: 600; }
  .pct { font-weight: 400; color: #9ca3af; }
  .subtotal { font-size: .85rem; color: #6b7280; margin-top: 8px; }
  .footer { margin-top: 28px; padding-top: 20px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; }
  .refresh-note { font-size: .78rem; color: #9ca3af; }
  button.secondary { padding: 10px 20px; background: white; color: #4f46e5; border: 1.5px solid #4f46e5; border-radius: 8px; font-size: .95rem; cursor: pointer; }
  button.secondary:hover { background: #f5f3ff; }
</style>
</head>
<body>
<div class="card">
  <h1>Live Results</h1>
  <div class="meta">Session started ${new Date(session.createdAt).toLocaleTimeString()}</div>
  ${pollBlocks}
  <div class="footer">
    <a href="/qr"><button class="secondary" type="button">← Back to QR Code</button></a>
    <span class="refresh-note">Auto-refreshes every 5s</span>
  </div>
</div>
</body>
</html>`);
});

// ── Results JSON API ───────────────────────────────────────────────────────────
app.get('/api/results', (req, res) => {
  if (!session) return res.json({ error: 'no session' });
  res.json({
    polls: session.polls.map(p => ({
      title: p.title,
      names: p.names,
      votes: p.votes,
      total: Object.values(p.votes).reduce((a, b) => a + b, 0),
    }))
  });
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
