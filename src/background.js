// background.js -- what only the background page can do for a fill.
//
// The filling itself happens in the page (fillAgent.js, one run per frame).
// This file gives those runs four services:
//
//   1. screenshots of the tab
//   2. real input: forwarding a frame's clicks and keys to the browser
//      (experiments/input, where the browser allows it)
//   3. turn-taking: one frame of a tab acts at a time
//   4. the panel's view of a fill: every frame reports here, and the panel
//      is told when the whole thing has started, how far it is, and when
//      the last frame is done
// ff:logs:start
//   5. the fill logs (development builds only): one stored record per fill
// ff:logs:end

// ---------------------------------------------------------------------------
// 1. Screenshots
// ---------------------------------------------------------------------------

function captureScreenshot(sender, sendResponse) {
  const windowId = sender.tab ? sender.tab.windowId : null;
  Compat.captureVisibleTab(windowId, { format: 'jpeg', quality: 80 })
    .then(dataUrl => sendResponse({ dataUrl }), () => sendResponse({ dataUrl: null }));
  return true;
}

// ---------------------------------------------------------------------------
// 2. Real input (see trustedInput.js and experiments/input/)
//
// The frame asks; the background knows which tab and frame asked; the
// experiment performs the input there. Absent on Chrome, in store builds and
// in a Firefox that refuses experiments: the frame then reproduces the input
// as events instead.
// ---------------------------------------------------------------------------

function forwardInput(message, sender, sendResponse) {
  const api = browser.ffInput;
  if (!api) { sendResponse({ available: false, reason: 'no experiment API' }); return false; }
  if (message.op === 'probe') {
    api.probe().then(sendResponse, e => sendResponse({ available: false, reason: String(e) }));
    return true;
  }
  if (message.op === 'run' && sender.tab) {
    api.run(sender.tab.id, sender.frameId || 0, message.ops || [])
      .then(sendResponse, e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  sendResponse({ ok: false, error: sender.tab ? 'unknown op' : 'no tab' });
  return false;
}

// ---------------------------------------------------------------------------
// 3. Turn-taking
//
// Keyboard focus belongs to the tab, not to a frame, and every frame with
// fields runs its own fill. Two frames typing at once interleave their
// keystrokes (hosted card fields: the CVC digits landed in the expiry box).
// So a frame takes the tab's turn for each action (hands.js) and gives it
// back when the action is done. The holder renews its lease while it works;
// a frame that died loses the turn when the lease runs out.
// ---------------------------------------------------------------------------

const TURN_LEASE_MS = 20000;
const turns = new Map();   // tabId -> { holder: { frameId, token, until } | null, queue: [{ frameId, token, grant }], timer }

function passTurn(tabId) {
  const t = turns.get(tabId);
  if (!t) return;
  clearTimeout(t.timer);
  if (t.holder && t.holder.until <= Date.now()) t.holder = null;   // lease ran out
  if (!t.holder && t.queue.length) {
    const next = t.queue.shift();
    t.holder = { frameId: next.frameId, token: next.token, until: Date.now() + TURN_LEASE_MS };
    next.grant({ granted: true });
  }
  if (!t.holder && !t.queue.length) turns.delete(tabId);
  else if (t.queue.length) t.timer = setTimeout(() => passTurn(tabId), Math.max(50, t.holder.until - Date.now()));
}

function turnMessage(message, sender, sendResponse) {
  // Nothing to coordinate without a tab: let the caller go ahead.
  if (!sender.tab) { sendResponse({ granted: true }); return false; }
  const tabId = sender.tab.id, frameId = sender.frameId || 0;
  if (!turns.has(tabId)) turns.set(tabId, { holder: null, queue: [], timer: null });
  const t = turns.get(tabId);
  const holds = t.holder && t.holder.token === message.token;
  switch (message.op) {
    case 'acquire':
      t.queue.push({ frameId, token: message.token, grant: sendResponse });
      passTurn(tabId);
      return true;   // answered when the turn comes
    case 'renew':
      if (holds) t.holder.until = Date.now() + TURN_LEASE_MS;
      break;
    case 'release':
      if (holds) t.holder = null;
      break;
    case 'drop':
      // The frame stopped or is leaving: its turn and its place in the queue go.
      if (t.holder && t.holder.frameId === frameId) t.holder = null;
      t.queue = t.queue.filter(q => {
        if (q.frameId === frameId) q.grant({ granted: false });
        return q.frameId !== frameId;
      });
      break;
  }
  passTurn(tabId);
  sendResponse({ ok: true });
  return false;
}

browser.tabs.onRemoved.addListener(tabId => {
  const t = turns.get(tabId);
  if (t) clearTimeout(t.timer);
  turns.delete(tabId);
});

// ---------------------------------------------------------------------------
// 4. The panel's view of a fill
//
// Every frame of the tab gets the fill request and reports here on its own:
//   fillFormJoin      it has the request and is getting ready
//   fillFormLeave     it has no fields
//   fillFormStart     it is filling
//   fillFormProgress  { processed, total, message }
//   fillFormComplete  { filled, message, details } / fillFormStopped / fillFormError
// The panel is shown one fill: started when the first frame starts, over when
// no frame is filling and none is still getting ready.
// ---------------------------------------------------------------------------

const JOIN_MAX_MS = 20000;   // a frame that joined and never reported again stops counting
const SETTLE_MS = 400;       // another frame's first report may still be on its way

// The fill in progress: { id, startedAt, frames: Map(frameId -> frame), lastMessage, timer }
// frame: { state: 'joined' | 'filling' | 'done', since, done, total, filled, details, message }
let fill = null;
const ended = new Map();     // fill id -> 'done' | 'stopped', the last few

function progressBar(fraction) {
  const filled = Math.round(fraction * 20);
  return '[' + '█'.repeat(filled) + '░'.repeat(20 - filled) + '] ' + Math.round(fraction * 100) + '%';
}

function tellPanel(msg) {
  if (msg.message) fill.lastMessage = msg.message;
  Compat.notify({ sessionId: fill.id, startedAt: fill.startedAt, ...msg });
}

function beginFill(id) {
  if (fill) clearTimeout(fill.timer);
  fill = { id, startedAt: Date.now(), frames: new Map(), lastMessage: '', timer: null };
}

function endFill(how) {
  clearTimeout(fill.timer);
  ended.delete(fill.id);
  ended.set(fill.id, how);
  if (ended.size > 20) ended.delete(ended.keys().next().value);
  fill = null;
}

const framesIn = state => Array.from(fill.frames.values()).filter(f => f.state === state);

// Is every frame through? Frames still getting ready count for a while.
function busy() {
  const now = Date.now();
  return framesIn('filling').length > 0 || framesIn('joined').some(f => now - f.since <= JOIN_MAX_MS);
}

// Check whether the fill is over, now and once more a moment later.
function settle() {
  if (!fill || busy()) return;
  const id = fill.id;
  clearTimeout(fill.timer);
  fill.timer = setTimeout(() => {
    if (!fill || fill.id !== id || busy()) return;
    const done = framesIn('done');
    const filled = done.reduce((n, f) => n + (f.filled || 0), 0);
    const calls = done.reduce((n, f) => n + ((f.details && f.details.llmCalls) || 0), 0);
    const seconds = ((Date.now() - fill.startedAt) / 1000).toFixed(1);
    const lines = done.length
      ? [`Form processing complete.\n${progressBar(1)}\nFilled ${filled} field(s) in ${seconds} seconds${calls ? ` (${calls} model call${calls === 1 ? '' : 's'})` : ''}.`]
      : ['No form fields found on this page.'];
    // What each frame has to say: the model's summary, or the frame's own words.
    const said = done.map(f => (f.details ? f.details.summary : f.message)).filter(Boolean);
    if (said.length) lines.push(said.join(' '));
    const details = { needsUserInput: [], stillInvalid: [], emptyRequired: [] };
    for (const f of done) {
      for (const key of Object.keys(details)) if (f.details && Array.isArray(f.details[key])) details[key].push(...f.details[key]);
    }
    tellPanel({ action: 'fillFormComplete', filled, message: lines.join('\n'), details });
    endFill('done');
  }, SETTLE_MS);
}

// One report from one frame.
function frameReport(message, sender) {
  const id = message.sessionId, action = message.action;
  if (!id) return;
  const opens = action === 'fillFormJoin' || action === 'fillFormStart';

  if (!fill || fill.id !== id) {
    const was = ended.get(id);
    if (was === 'stopped') return;                 // stragglers of a fill the user stopped
    if (was === 'done') {
      // A frame is still working on a fill the panel was told is over (it
      // started late, or outlived the others): bring progress and Stop back.
      if (fill || !(opens || action === 'fillFormProgress')) return;
      beginFill(id);
      tellPanel({ action: 'fillFormStart', message: 'Still filling another part of the page...' });
    } else if (opens) {
      beginFill(id);                               // a new fill (replacing one that never finished)
    } else if (!fill) {
      // Chrome can evict this service worker between messages, taking the
      // fill with it. Pick it up again from the frame's report.
      beginFill(id);
    } else {
      return;                                      // a report from some older fill
    }
  }

  const frameId = sender.frameId || 0;
  if (!fill.frames.has(frameId)) fill.frames.set(frameId, { state: 'joined', since: Date.now(), done: 0, total: 0, filled: 0 });
  const frame = fill.frames.get(frameId);
  clearTimeout(fill.timer);

  switch (action) {
    case 'fillFormJoin':
      // Should this frame never be heard from again, look once its time is up.
      setTimeout(settle, JOIN_MAX_MS + 100);
      return;

    case 'fillFormLeave':
      fill.frames.delete(frameId);
      break;

    case 'fillFormStart':
      frame.state = 'filling';
      tellPanel({ action, message: 'Starting to fill form...\n' + progressBar(0) });
      return;

    case 'fillFormProgress': {
      frame.state = 'filling';
      frame.total = message.total || 0;
      frame.done = Math.min(Math.max(0, message.processed || 0), frame.total);
      const frames = Array.from(fill.frames.values());
      const total = frames.reduce((n, f) => n + f.total, 0), done = frames.reduce((n, f) => n + f.done, 0);
      const parts = framesIn('filling').length;
      tellPanel({
        action, filled: done, total,
        message: `${message.message || 'Processing form...'}\n${progressBar(total ? Math.min(0.99, done / total) : 0)}` +
          (parts > 1 ? `\n(${parts} parts of the page are being filled)` : ''),
      });
      return;
    }

    case 'fillFormComplete':
      Object.assign(frame, { state: 'done', done: frame.total, filled: message.filled || 0, details: message.details, message: message.message });
      break;

    case 'fillFormStopped':
      frame.state = 'done';
      if (framesIn('filling').length === 0) {
        tellPanel({ action, message: 'Form filling stopped by user.' });
        endFill('stopped');
      }
      return;

    case 'fillFormError':
      Object.assign(frame, { state: 'done', message: `One part of the page failed: ${message.error || 'unknown error'}.` });
      // With nothing else running this is how the fill ends; otherwise the
      // other frames carry on and the failure is part of the final report.
      if (!busy() && framesIn('done').length === 1) {
        tellPanel({ action, message: `Error filling form: ${message.error || 'unknown error'}` });
        endFill('done');
        return;
      }
      break;
  }
  settle();
}

// ff:logs:start
// ---------------------------------------------------------------------------
// 5. Fill logs: one storage key per fill, writes one after another.
// ---------------------------------------------------------------------------
const LOG_INDEX_KEY = 'ffLogIndex';
const LOG_PREFIX = 'ffLog:';
const DEFAULT_MAX_SESSIONS = 30;
let logQueue = Promise.resolve();

function queued(fn) {
  const p = logQueue.then(fn, fn);
  logQueue = p.catch(() => {});
  return p;
}

const logList = async () => (await browser.storage.local.get(LOG_INDEX_KEY))[LOG_INDEX_KEY] || [];

// Change one row of the index (what the panel lists).
async function updateLogIndex(sessionId, change) {
  const index = await logList();
  const row = index.find(r => r.id === sessionId);
  if (!row) return;
  change(row);
  await browser.storage.local.set({ [LOG_INDEX_KEY]: index });
}

function logStart(sessionId, meta) {
  return queued(async () => {
    const key = LOG_PREFIX + sessionId;
    const existing = (await browser.storage.local.get(key))[key];
    if (existing) {
      // Another frame already opened this session: add this frame to it.
      existing.frames.push(meta);
      await browser.storage.local.set({ [key]: existing });
      return;
    }
    const session = { id: sessionId, meta, frames: [meta], entries: [], startedAt: Date.now(), bytes: 0 };
    const index = await logList();
    index.push({ id: sessionId, url: meta.url, title: meta.title, startedAt: session.startedAt });
    const max = Number((await browser.storage.local.get('ffLogMaxSessions')).ffLogMaxSessions) || DEFAULT_MAX_SESSIONS;
    const dropped = index.splice(0, Math.max(0, index.length - max));
    await browser.storage.local.set({ [key]: session, [LOG_INDEX_KEY]: index });
    if (dropped.length) await browser.storage.local.remove(dropped.map(r => LOG_PREFIX + r.id));
  });
}

function logAppend(sessionId, entry) {
  return queued(async () => {
    const key = LOG_PREFIX + sessionId;
    const session = (await browser.storage.local.get(key))[key];
    if (!session) return;
    session.entries.push(entry);
    session.bytes += JSON.stringify(entry).length;
    session.updatedAt = Date.now();
    await browser.storage.local.set({ [key]: session });
    await updateLogIndex(sessionId, row => { row.bytes = session.bytes; row.entries = session.entries.length; row.updatedAt = session.updatedAt; });
  });
}

function logEnd(sessionId, summary, frameUrl) {
  return queued(async () => {
    const key = LOG_PREFIX + sessionId;
    const session = (await browser.storage.local.get(key))[key];
    if (!session) return;
    session.endedAt = Date.now();
    // Every frame with fields ends its own part; keep them all and add up.
    session.frameSummaries = (session.frameSummaries || []).concat([{ frameUrl, ...summary }]);
    const parts = session.frameSummaries;
    session.summary = parts.length === 1 ? summary : {
      status: parts.some(p => p.status === 'error') ? 'error' : summary.status,
      filled: parts.reduce((n, p) => n + (p.filled || 0), 0),
      frames: parts.length,
      durationMs: session.endedAt - session.startedAt,
    };
    await browser.storage.local.set({ [key]: session });
    await updateLogIndex(sessionId, row => { row.status = session.summary.status; row.filled = session.summary.filled; });
  });
}

async function logGet(ids) {
  const wanted = ids && ids.length ? ids : (await logList()).map(r => r.id);
  const data = await browser.storage.local.get(wanted.map(id => LOG_PREFIX + id));
  return wanted.map(id => data[LOG_PREFIX + id]).filter(Boolean);
}

function logClear() {
  return queued(async () => {
    const index = await logList();
    await browser.storage.local.remove(index.map(r => LOG_PREFIX + r.id).concat([LOG_INDEX_KEY]));
  });
}

function logMessage(message, sender, sendResponse) {
  const answer = promise => promise.then(result => sendResponse({ ok: true, ...result }), e => sendResponse({ ok: false, error: String(e) }));
  switch (message.action) {
    case 'ffLog':
      if (message.op === 'start') answer(logStart(message.sessionId, message.meta));
      else if (message.op === 'append') answer(logAppend(message.sessionId, message.entry));
      else answer(logEnd(message.sessionId, message.summary || {}, sender.url));
      break;
    case 'ffLogList': answer(logList().then(list => ({ list }))); break;
    case 'ffLogGet': answer(logGet(message.ids).then(sessions => ({ sessions }))); break;
    case 'ffLogClear': answer(logClear()); break;
  }
  return true;
}
// ff:logs:end

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = typeof message.action === 'string' ? message.action : '';
  if (action === 'captureScreenshot') return captureScreenshot(sender, sendResponse);
  if (action === 'ffInput') return forwardInput(message, sender, sendResponse);
  if (action === 'ffInputLock') return turnMessage(message, sender, sendResponse);
  // ff:logs:start
  if (action.startsWith('ffLog')) return logMessage(message, sender, sendResponse);
  // ff:logs:end

  // The panel's Stop. The frames report as they notice, but the fill ends
  // now, so their stragglers cannot bring it back.
  if (action === 'fillStop') {
    if (fill && (!message.sessionId || message.sessionId === fill.id)) endFill('stopped');
    sendResponse({ ok: true });
    return false;
  }
  // The panel asks, when it opens, whether a fill is running: a reopened
  // popup, or a fill started from the context menu, still shows progress and Stop.
  if (action === 'fillStatus') {
    sendResponse(fill ? { filling: true, sessionId: fill.id, startedAt: fill.startedAt, message: fill.lastMessage } : { filling: false });
    return false;
  }
  if (action.startsWith('fillForm')) frameReport(message, sender);
});

// Settings of features that no longer exist.
browser.storage.local.remove(['ffSiteMemory', 'ffEngine']);
