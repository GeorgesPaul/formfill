let formFillProgress = {};
let formFillStart = null;
let totalFields = 0;
let isFilling = false;
let currentSessionId = null;
let activeFrames = new Set(); // Track frames that are actively filling
let completionTimer = null;  // Grace-period timer before signalling fillFormComplete to popup
let frameDetails = {};       // frameId -> details object from FillAgent (needs-input, skipped, ...)

function generateLoadingBar(percentage) {
  const barLength = 20;
  const filledLength = Math.round(percentage * barLength);
  const emptyLength = barLength - filledLength;
  return '[' + '█'.repeat(filledLength) + '░'.repeat(emptyLength) + ']';
}

function mergeDetails(all) {
  const out = { needsUserInput: [], skipped: [], stillInvalid: [], emptyRequired: [], summaries: [], llmCalls: 0, memoryApplied: 0 };
  for (const d of Object.values(all)) {
    if (!d) continue;
    for (const k of ['needsUserInput', 'skipped', 'stillInvalid', 'emptyRequired']) if (Array.isArray(d[k])) out[k].push(...d[k]);
    if (d.summary) out.summaries.push(d.summary);
    out.llmCalls += d.llmCalls || 0;
    out.memoryApplied += d.memoryApplied || 0;
  }
  return out;
}

// ff:logs:start
// ---------------------------------------------------------------------------
// Fill logs: one storage key per session, serialized writes.
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

async function logStart(sessionId, meta) {
  return queued(async () => {
    const key = LOG_PREFIX + sessionId;
    const existing = (await browser.storage.local.get(key))[key];
    if (existing) {
      // Another frame already opened this session: record its frame meta.
      existing.frames = existing.frames || [];
      existing.frames.push(meta);
      await browser.storage.local.set({ [key]: existing });
      return;
    }
    const session = { id: sessionId, meta, frames: [meta], entries: [], startedAt: Date.now(), bytes: 0 };
    const idxData = await browser.storage.local.get([LOG_INDEX_KEY, 'ffLogMaxSessions']);
    const index = idxData[LOG_INDEX_KEY] || [];
    index.push({ id: sessionId, url: meta.url, title: meta.title, startedAt: session.startedAt });
    const max = Number(idxData.ffLogMaxSessions) || DEFAULT_MAX_SESSIONS;
    const toRemove = [];
    while (index.length > max) toRemove.push(index.shift());
    await browser.storage.local.set({ [key]: session, [LOG_INDEX_KEY]: index });
    if (toRemove.length) await browser.storage.local.remove(toRemove.map(r => LOG_PREFIX + r.id));
  });
}

async function logAppend(sessionId, entry) {
  return queued(async () => {
    const key = LOG_PREFIX + sessionId;
    const session = (await browser.storage.local.get(key))[key];
    if (!session) return;
    session.entries.push(entry);
    let size = 0;
    try { size = JSON.stringify(entry).length; } catch (_) {}
    session.bytes = (session.bytes || 0) + size;
    session.updatedAt = Date.now();
    await browser.storage.local.set({ [key]: session });
    const idxData = await browser.storage.local.get(LOG_INDEX_KEY);
    const index = idxData[LOG_INDEX_KEY] || [];
    const row = index.find(r => r.id === sessionId);
    if (row) { row.bytes = session.bytes; row.entries = session.entries.length; row.updatedAt = session.updatedAt; await browser.storage.local.set({ [LOG_INDEX_KEY]: index }); }
  });
}

async function logEnd(sessionId, summary) {
  return queued(async () => {
    const key = LOG_PREFIX + sessionId;
    const session = (await browser.storage.local.get(key))[key];
    if (!session) return;
    session.endedAt = Date.now();
    session.summary = summary;
    await browser.storage.local.set({ [key]: session });
    const idxData = await browser.storage.local.get(LOG_INDEX_KEY);
    const index = idxData[LOG_INDEX_KEY] || [];
    const row = index.find(r => r.id === sessionId);
    if (row) { row.status = summary && summary.status; row.filled = summary && summary.filled; row.total = summary && summary.total; await browser.storage.local.set({ [LOG_INDEX_KEY]: index }); }
  });
}

async function logList() {
  const idxData = await browser.storage.local.get(LOG_INDEX_KEY);
  return idxData[LOG_INDEX_KEY] || [];
}

async function logGet(ids) {
  const index = await logList();
  const wanted = ids && ids.length ? ids : index.map(r => r.id);
  const keys = wanted.map(id => LOG_PREFIX + id);
  const data = await browser.storage.local.get(keys);
  return wanted.map(id => data[LOG_PREFIX + id]).filter(Boolean);
}

async function logClear() {
  return queued(async () => {
    const index = await logList();
    await browser.storage.local.remove(index.map(r => LOG_PREFIX + r.id).concat([LOG_INDEX_KEY]));
  });
}

// ff:logs:end

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Screenshot on behalf of a content script (only background can capture).
  if (message.action === "captureScreenshot") {
    const winId = sender && sender.tab ? sender.tab.windowId : null;
    Compat.captureVisibleTab(winId, { format: 'jpeg', quality: 80 })
      .then(dataUrl => sendResponse({ dataUrl }))
      .catch(err => {
        console.error("captureScreenshot failed:", err);
        sendResponse({ dataUrl: null });
      });
    return true;
  }

  // ff:logs:start
  if (message.action === "ffLog") {
    let p;
    if (message.op === 'start') p = logStart(message.sessionId, message.meta);
    else if (message.op === 'append') p = logAppend(message.sessionId, message.entry);
    else if (message.op === 'end') p = logEnd(message.sessionId, message.summary);
    else p = Promise.resolve();
    p.then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (message.action === "ffLogList") {
    logList().then(list => sendResponse({ list })).catch(e => sendResponse({ list: [], error: String(e) }));
    return true;
  }
  if (message.action === "ffLogGet") {
    logGet(message.ids).then(sessions => sendResponse({ sessions })).catch(e => sendResponse({ sessions: [], error: String(e) }));
    return true;
  }
  if (message.action === "ffLogClear") {
    logClear().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  // ff:logs:end

  // Chrome MV3 can evict this service worker between messages, taking the
  // session state with it. Adopt the session the content script reports on.
  const isFillMessage = typeof message.action === 'string' && message.action.startsWith('fillForm');
  if (isFillMessage && currentSessionId === null && message.sessionId) {
    currentSessionId = message.sessionId;
    if (message.action !== "fillFormStart") {
      console.log("[Background] Adopting in-flight session after restart:", message.sessionId);
      isFilling = true;
      if (!formFillStart) formFillStart = Date.now();
      if (sender && sender.frameId !== undefined) activeFrames.add(sender.frameId);
    }
  }

  let computedMessage = '';
  let totalFilled = 0;
  let totalProcessed = 0;
  let percentage = 0;

  if (message.action !== "fillFormStart" && message.sessionId && message.sessionId !== currentSessionId) {
    return;
  }

  switch (message.action) {
    case "fillFormStart":
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      if (message.sessionId !== currentSessionId) {
        currentSessionId = message.sessionId;
        formFillProgress = {};
        formFillStart = Date.now();
        totalFields = 0;
        activeFrames = new Set();
        frameDetails = {};
      }
      isFilling = true;
      activeFrames.add(sender.frameId);
      computedMessage = "Starting to fill form...\n" + generateLoadingBar(0) + " 0%";
      break;

    case "fillFormStopped": {
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      activeFrames.delete(sender.frameId);
      formFillProgress[sender.frameId] = {
        processed: message.processed || (formFillProgress[sender.frameId] || {}).processed || 0,
        filled: message.filled || (formFillProgress[sender.frameId] || {}).filled || 0,
        total: message.total || (formFillProgress[sender.frameId] || {}).total || 0
      };
      if (activeFrames.size > 0) return;
      isFilling = false;
      currentSessionId = null;
      const fill_duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
      totalFilled = Object.values(formFillProgress).reduce((sum, p) => sum + (p.filled || 0), 0);
      totalProcessed = Object.values(formFillProgress).reduce((sum, p) => sum + (p.processed || 0), 0);
      percentage = totalFields > 0 ? totalProcessed / totalFields : 0;
      computedMessage = `Form filling stopped by user.\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%\nFilled ${totalFilled} out of ${totalFields} fields in ${fill_duration} seconds.`;
      break;
    }

    case "fillFormProgress":
      if (!isFilling) return;
      if (!formFillProgress[sender.frameId]) {
        totalFields += message.total;
      } else if (formFillProgress[sender.frameId].total !== message.total) {
        totalFields -= formFillProgress[sender.frameId].total;
        totalFields += message.total;
      }
      {
        const t = message.total || 0;
        formFillProgress[sender.frameId] = {
          processed: Math.min(Math.max(0, message.processed || 0), t),
          filled: Math.min(Math.max(0, message.filled || 0), t),
          total: t
        };
      }
      totalProcessed = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.processed, 0);
      totalFilled = Object.values(formFillProgress).reduce((sum, progress) => sum + progress.filled, 0);
      totalProcessed = Math.min(totalProcessed, totalFields);
      totalFilled = Math.min(totalFilled, totalFields);
      percentage = totalFields > 0 ? Math.min(0.99, totalProcessed / totalFields) : 0;
      computedMessage = `${message.message || 'Processing form...'}\n${generateLoadingBar(percentage)} ${Math.round(percentage * 100)}%`;
      break;

    case "fillFormComplete": {
      activeFrames.delete(sender.frameId);
      if (message.details) frameDetails[sender.frameId] = message.details;
      const prev = formFillProgress[sender.frameId] || {};
      const t = message.total || prev.total || 0;
      if (!formFillProgress[sender.frameId]) totalFields += t;
      else if (prev.total !== t) totalFields += t - prev.total;
      formFillProgress[sender.frameId] = { processed: t, filled: message.filled || prev.filled || 0, total: t };
      if (activeFrames.size > 0) return;

      // Grace period: a concurrent frame's fillFormStart may still be in flight.
      const _sid = currentSessionId;
      if (completionTimer) clearTimeout(completionTimer);
      completionTimer = setTimeout(() => {
        completionTimer = null;
        if (activeFrames.size > 0 || currentSessionId !== _sid) return;
        isFilling = false;
        const _filled = Object.values(formFillProgress).reduce((sum, p) => sum + (p.filled || 0), 0);
        const _duration = ((Date.now() - formFillStart) / 1000).toFixed(2);
        const merged = mergeDetails(frameDetails);
        const lines = [`Form processing complete.\n${generateLoadingBar(1)} 100%\nFilled ${_filled} out of ${totalFields} fields in ${_duration} seconds (${merged.llmCalls} model call${merged.llmCalls === 1 ? '' : 's'}).`];
        if (merged.summaries.length) lines.push(merged.summaries.join(' '));
        Compat.notify({
          action: "fillFormComplete",
          filled: _filled,
          total: totalFields,
          message: lines.join('\n'),
          details: merged,
          sessionId: _sid
        });
        currentSessionId = null;
      }, 400);
      return;
    }

    case "fillFormError":
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      activeFrames.delete(sender.frameId);
      if (activeFrames.size > 0) return;
      isFilling = false;
      currentSessionId = null;
      computedMessage = `Error filling form: ${message.error || "undefined"}`;
      break;
  }

  if (computedMessage) {
    Compat.notify({
      action: message.action,
      filled: totalFilled,
      total: totalFields,
      message: computedMessage || message.message,
      sessionId: currentSessionId || message.sessionId
    });
  }
});
