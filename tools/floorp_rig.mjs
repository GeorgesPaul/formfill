#!/usr/bin/env node
// floorp_rig.mjs -- run the real dev build in a scratch Floorp/Firefox and
// drive the bench pages through it, real input included, with no API key.
//
//   node tools/floorp_rig.mjs --all                    every scenario, real input then synthetic; says what failed
//   node tools/floorp_rig.mjs --scenario real          one scenario, with everything it saw and did printed
//   node tools/floorp_rig.mjs --scenario look --page test/<file>.html     only print the page as the model is shown it
//   node tools/floorp_rig.mjs --page test/<file>.html --brain <dir>       the whole loop, the model's answers read from files
//   node tools/floorp_rig.mjs --diag                   the real-input transport, stage by stage
//
//   --no-trusted   reproduce input as events (what Chrome and the store builds have)
//   --no-lock      switch off the turn-taking between frames (to see what it prevents)
//   --keep         leave the browser open afterwards
//   --browser <path>, --profile <file>, --looks <n>, --log
//
// It builds nothing (run build/build.ps1 -Target firefox first). It starts
// the browser with its own profile and WebDriver BiDi enabled, installs
// dist/firefox as a temporary add-on, opens the page from test/serve.js
// (started here if port 8123 is free) and talks to the extension through the
// `ff-selftest` hook (src/selftest.js, dev builds only).
//
// A scenario plays the model's part with a script: each "look" is a function
// from the page text to a batch of actions, reading the page by its words the
// way the model does, never by ids or selectors.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = name => args.includes(name);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'firefox');
const BROWSER = opt('--browser', process.env.FLOORP || 'C:\\Program Files\\Ablaze Floorp\\floorp.exe');
const PORT = Number(opt('--port', 9333));
const SERVE_PORT = 8123;
const SCENARIO = opt('--scenario', '');
const BRAIN_DIR = opt('--brain', '');
const KEEP = flag('--keep');
let NO_TRUSTED = flag('--no-trusted');

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Git Bash rewrites a leading slash into a Windows path; accept both forms.
const pageUrl = page => `http://localhost:${SERVE_PORT}/` + page.replace(/^.*?(test\/)/, '$1').replace(/^\/+/, '');

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

async function ensureServer() {
  if (!(await portFree(SERVE_PORT))) return null;
  const p = spawn(process.execPath, [path.join(ROOT, 'test', 'serve.js'), String(SERVE_PORT)], { stdio: 'ignore' });
  await sleep(400);
  return p;
}

function makeProfile() {
  const dir = path.join(os.tmpdir(), 'formfill-rig-profile');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user.js'), [
    'user_pref("extensions.experiments.enabled", true);',
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.startup.page", 0);',
    'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("browser.tabs.warnOnClose", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("remote.log.level", "Info");',
    'user_pref("floorp.browser.welcome.enabled", false);',
    'user_pref("floorp.welcome.completed", true);',
  ].join('\n') + '\n');
  return dir;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

// A WebDriver BiDi client: bidi(method, params) -> result.
function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id == null || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.type === 'error') reject(new Error(`${m.error}: ${m.message}`)); else resolve(m.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(bidi, ctx, expression) {
  const r = await bidi('script.evaluate', { expression, target: { context: ctx }, awaitPromise: true, resultOwnership: 'none' });
  if (r.type === 'exception') throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails && r.exceptionDetails.text));
  return r.result && r.result.value;
}

async function openPage(bidi, ctx, page) {
  await bidi('browsingContext.navigate', { context: ctx, url: pageUrl(page), wait: 'complete' });
  // Pages that pull their widgets from the network say when they are up.
  for (let i = 0; i < 80; i++) {
    if (await evaluate(bidi, ctx, `window.__ready !== undefined ? !!window.__ready : !!document.querySelector('input, iframe')`)) break;
    await sleep(250);
  }
  await sleep(900);   // the content scripts and the page's own scripts both need a moment
}

async function childFrames(bidi, ctx) {
  let kids = [];
  for (let i = 0; i < 40 && !kids.length; i++) {
    kids = ((await bidi('browsingContext.getTree', { root: ctx })).contexts[0].children) || [];
    if (!kids.length) await sleep(250);
  }
  if (!kids.length) throw new Error('no child frames');
  for (const k of kids) {
    for (let i = 0; i < 40; i++) { if (await evaluate(bidi, k.context, `!!document.querySelector('input')`)) break; await sleep(250); }
  }
  await sleep(800);
  return kids.map(k => k.context);
}

// ---------------------------------------------------------------------------
// Talking to the extension (src/selftest.js)
// ---------------------------------------------------------------------------

const postRequest = (bidi, ctx, req) => evaluate(bidi, ctx, `(() => { const r = document.documentElement; r.setAttribute('data-ff-selftest-req', ${JSON.stringify(JSON.stringify(req))}); r.removeAttribute('data-ff-selftest-res'); document.dispatchEvent(new Event('ff-selftest')); return true; })()`);
const readAttr = (bidi, ctx, name) => evaluate(bidi, ctx, `document.documentElement.getAttribute('${name}')`);

async function selftest(bidi, ctx, req, timeoutMs = 90000) {
  await postRequest(bidi, ctx, { noTrusted: NO_TRUSTED, noLock: flag('--no-lock'), ...req });
  const t0 = Date.now();
  for (;;) {
    await sleep(150);
    const res = await readAttr(bidi, ctx, 'data-ff-selftest-res');
    if (res) return JSON.parse(res);
    if (Date.now() - t0 > timeoutMs) throw new Error('selftest timed out');
  }
}

// What the page itself recorded (its own state object), and whose events it saw.
async function pageState(bidi, ctx) {
  const page = JSON.parse(await evaluate(bidi, ctx, `JSON.stringify({ state: typeof window.__state === 'function' ? window.__state() : (window.__state || window.benchState || null), events: window.__events || [] })`));
  const events = {};
  for (const e of page.events) { const k = e.type + (e.trusted ? ':real' : ':scripted'); events[k] = (events[k] || 0) + 1; }
  return { state: page.state, events };
}

// ---------------------------------------------------------------------------
// Reading the page text the way the model does
// ---------------------------------------------------------------------------

// The control that goes with the text matching `re`: the one whose own
// description holds that text, else the first number at or after it.
function near(view, re) {
  for (const line of view.split('\n')) {
    for (const part of line.split(/(?=\[\d+\] )/)) {
      const n = part.match(/^\[(\d+)\] /);
      if (n && re.test(part)) return Number(n[1]);
    }
  }
  const m = view.match(re);
  const n = m && view.slice(m.index).match(/\[(\d+)\]/);
  if (!n) throw new Error(`the page text has nothing matching ${re}:\n${view}`);
  return Number(n[1]);
}
// The number captured by `re` itself, e.g. /\[(\d+)\] button "Continuar"/.
function num(view, re) {
  const m = view.match(re);
  if (!m) throw new Error(`the page text has nothing matching ${re}:\n${view}`);
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const REAL_WIDGETS = [
  v => [
    { op: 'type', ref: near(v, /Nome completo/), value: 'Maria Fonseca Duarte' },
    { op: 'type', ref: num(v, /\[(\d+)\] number field "Day"/), value: '18' },
    { op: 'type', ref: num(v, /\[(\d+)\] number field "Month"/), value: '04' },
    { op: 'type', ref: num(v, /\[(\d+)\] number field "Year"/), value: '1985' },
    { op: 'choose', ref: near(v, /País de residência/), value: 'Portugal' },
    { op: 'choose', ref: near(v, /Nacionalidade/), value: 'Neerlandesa' },
    { op: 'choose', ref: near(v, /Tipo de documento/), value: 'Passaporte' },
  ],
  v => [{ op: 'type', ref: near(v, /Número do documento/), value: 'XN12AB345' }],
];
const REAL_WIDGETS_DONE = s => s.name === 'Maria Fonseca Duarte' && s.birth === '1985-04-18' && s.country === 'Portugal' &&
  s.nationality === 'Neerlandesa' && s.doc === 'Passaporte' && s.docNumber === 'XN12AB345';

const SCENARIOS = {
  // The real libraries: MUI X date field (three "spinbutton" parts), react-select,
  // MUI Autocomplete and Select, then the field that only exists after a choice.
  real: { page: 'test/real_widgets_test.html', looks: REAL_WIDGETS, expect: REAL_WIDGETS_DONE },

  // The date typed in one go into its first part: the field hands the cursor
  // from part to part by itself, as it does for a person.
  realrun: {
    page: 'test/real_widgets_test.html',
    looks: [v => [{ op: 'type', ref: num(v, /\[(\d+)\] number field "Day"/), value: '18041985' }]],
    expect: s => s.birth === '1985-04-18',
  },

  // A real MUI form: menus with 250 countries, radios, a checkbox.
  mui: {
    page: 'test/trusted_input_test.html',
    looks: [v => [
      { op: 'type', ref: near(v, /First name/), value: 'Maria' },
      { op: 'type', ref: near(v, /Last name/), value: 'Fonseca Duarte' },
      { op: 'choose', ref: near(v, /Country/), value: 'Portugal' },
      { op: 'type', ref: near(v, /Telephone/), value: '912345678' },
      { op: 'choose', ref: near(v, /Language/), value: 'English' },
      { op: 'check', ref: num(v, /\[(\d+)\] radio "Female"/), value: true },
      { op: 'check', ref: num(v, /\[(\d+)\] checkbox "[^"]*accept the terms/i), value: true },
    ]],
    expect: s => s.first === 'Maria' && s.last === 'Fonseca Duarte' && s.country === 'PT' && s.lang === 'EN' &&
      s.phone === '912345678' && s.terms === true && s.gender === 'female',
  },

  // The wrong verb on purpose: typing into a dropdown that takes no text. The
  // list it opens is shown as new lines, and the entry is clicked by number.
  muilook: {
    page: 'test/trusted_input_test.html',
    looks: [
      v => [{ op: 'type', ref: near(v, /Language/), value: 'English' }],
      v => [{ op: 'click', ref: num(v, /\[(\d+)\] option "English"/) }],
    ],
    expect: s => s.lang === 'EN',
  },

  // Searchable selects (one with emoji flags), a masked date, floating labels,
  // an input that replaces itself while it is typed into, and a date that
  // only its calendar can set.
  widgets: {
    page: 'test/choice_and_date_test.html',
    looks: [
      v => [
        { op: 'choose', ref: near(v, /"Country \*"/), value: 'Portugal' },
        { op: 'choose', ref: near(v, /"Nationality \*"/), value: 'Netherlands' },
        { op: 'type', ref: near(v, /Data de nascimento/), value: '18-04-1985' },
        { op: 'type', ref: near(v, /Código postal/), value: '2805-108' },
        { op: 'type', ref: near(v, /Morada/), value: 'Rua do Cabo 13' },
        { op: 'type', ref: near(v, /Localidade/), value: 'Almada' },
        { op: 'type', ref: near(v, /E-mail/), value: 'maria@example.com' },
        { op: 'click', ref: num(v, /\[(\d+)\] button "Selecionar Data"/) },
      ],
      v => [{ op: 'click', ref: num(v, /setembro de 2026[\s\S]*?\[(\d+)\] cell "3"/) }],
    ],
    expect: s => s.country === 'Portugal' && /Netherlands/.test(s.nat) && s.birth === '18-04-1985' && s.issued === '03/09/2026' && s.email === 'maria@example.com',
  },

  // A form that keeps changing: a banner on top, a country that swaps the
  // region list and adds a tax field, address suggestions that must be
  // picked, a delivery card with no markup to say it is clickable.
  dynamic: {
    page: 'test/dynamic_form_test.html',
    looks: [
      v => [
        { op: 'click', ref: num(v, /\[(\d+)\] button "Reject all"/) },
        { op: 'type', ref: near(v, /First name/), value: 'Maria' },
        { op: 'type', ref: near(v, /Last name/), value: 'Fonseca Duarte' },
        { op: 'type', ref: num(v, /\[(\d+)\] text field "Day"/), value: '18' },
        { op: 'type', ref: num(v, /\[(\d+)\] text field "Month"/), value: '04' },
        { op: 'type', ref: num(v, /\[(\d+)\] text field "Year"/), value: '1985' },
        { op: 'type', ref: num(v, /\[(\d+)\] text field = ""[^\n]*Email address/), value: 'maria.duarte@example.com' },
        { op: 'type', ref: near(v, /Mobile number/), value: '912345678' },
        { op: 'choose', ref: near(v, /"Country \*"/), value: 'Portugal' },
        { op: 'choose', ref: near(v, /Region \/ province/), value: 'Setúbal' },
        { op: 'type', ref: near(v, /Street and house number/), value: 'Rua das Flores 120' },
      ],
      v => [
        { op: 'click', ref: num(v, /\[(\d+)\] "Rua das Flores 120, 2800-010 Almada"/) },
        { op: 'type', ref: near(v, /Tax number/), value: '123456789' },
        { op: 'check', ref: num(v, /\[(\d+)\] checkbox "I accept the terms/), value: true },
        { op: 'click', value: 'Standard' },
        { op: 'click', ref: num(v, /\[(\d+)\] button "Save address"/) },   // refused: sending is the user's
      ],
    ],
    expect: s => s.cookie === 'dismissed' && s.first === 'Maria' && s.last === 'Fonseca Duarte' && s.dob === '18/04/1985' &&
      s.email === 'maria.duarte@example.com' && s.phone === '912345678' && !s.phoneError && s.country === 'PT' && s.region === 'Setúbal' &&
      s.tax === '123456789' && s.addressPicked && s.postcode === '2800-010' && s.city === 'Almada' && s.delivery === 'standard' &&
      s.terms === true && s.newsletter === false && s.saved === false,
  },

  // Hosted card fields: each in its own cross-origin frame, every frame
  // typing into its one field at the same moment.
  hosted: {
    page: 'test/hosted_fields_test.html',
    frames: [[/Número do cartão/, '4111111111111111', '4111 1111 1111 1111'], [/Nome Apelido/, 'Maria Fonseca Duarte', 'MARIA FONSECA DUARTE'],
      [/Data de validade/, '0729', '07 / 29'], [/CVC/, '123', '123']],
  },

  // The whole loop (fillAgent.js), with this script answering as the model
  // and the fill log switched on; then a press on the page's own button, to
  // see that what follows a fill is recorded too.
  loop: {
    page: 'test/real_widgets_test.html', agent: true, looks: REAL_WIDGETS, expect: REAL_WIDGETS_DONE,
    logHas: ['view', 'llmRequest', 'llmResponse', 'actions', 'results', 'finalState', 'submitCapture'],
  },

  // Only show what the model would be shown.
  look: { page: 'test/real_widgets_test.html', looks: [] },
};

// ---------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------

const say = (verbose, ...text) => { if (verbose) console.log(...text); };

function printResults(results, verbose) {
  for (const r of results || []) {
    say(verbose, `  ${r.op} ${r.ref !== undefined ? '[' + r.ref + '] ' : ''}${r.value !== undefined ? JSON.stringify(r.value) + ' ' : ''}-> ${r.ok ? 'ok' : 'NOT DONE'}` +
      `${r.now !== undefined ? ' now=' + JSON.stringify(r.now) : ''}${r.picked ? ' picked=' + JSON.stringify(r.picked) : ''}${r.input ? ' (' + r.input + ')' : ''} ${r.ms || 0}ms` +
      `${r.error ? ' : ' + r.error : ''}${r.note ? ' : ' + r.note : ''}${r.suggestions ? ' suggestions=' + JSON.stringify(r.suggestions) : ''}${r.shown ? ' entries=' + JSON.stringify(r.shown.slice(0, 12)) : ''}`);
  }
}

// Look, act, look again, with the scenario's script deciding.
async function runLooks(bidi, ctx, sc, verbose) {
  let r = await selftest(bidi, ctx, { view: true, fresh: true });
  if (r.error) throw new Error(r.error);
  say(verbose, 'input:', JSON.stringify(r.probe));
  say(verbose, `\n--- the page as the model is shown it (${r.view.length} characters, looked at in ${r.ms} ms) ---\n${r.view}\n---`);
  await evaluate(bidi, ctx, `if (window.__events) window.__events.length = 0; true`);
  const t0 = Date.now();
  let n = 0;
  for (const look of sc.looks) {
    const actions = look(r.view);
    r = await selftest(bidi, ctx, { hands: actions });
    if (r.error) throw new Error(r.error);
    say(verbose, `\nlook ${++n}: ${actions.length} action(s), ${r.ms} ms`);
    printResults(r.hands.results, verbose);
    if (r.hands.stopped) say(verbose, `  (batch ended early: ${r.hands.stopped}; not run: ${JSON.stringify(r.hands.notExecuted)})`);
    say(verbose, `\n--- the page now ---\n${r.view}\n---`);
  }
  const page = await pageState(bidi, ctx);
  say(verbose, `\n${n} look(s), ${Date.now() - t0} ms; input stats ${JSON.stringify(r.inputStats)}`);
  say(verbose, 'page state:', JSON.stringify(page.state), '\nevents:', JSON.stringify(page.events));
  return { ok: !sc.expect || sc.expect(page.state || {}), ms: Date.now() - t0, state: page.state };
}

// One field per frame, all frames at once.
async function runFrames(bidi, ctx, sc, verbose) {
  const frames = await childFrames(bidi, ctx);
  const looks = await Promise.all(frames.map(f => selftest(bidi, f, { view: true, fresh: true })));
  const plans = looks.map(r => {
    const hit = sc.frames.find(([re]) => re.test(r.view));
    return hit ? { actions: [{ op: 'type', ref: num(r.view, /\[(\d+)\]/), value: hit[1] }], want: hit[2] } : null;
  });
  const t0 = Date.now();
  const runs = await Promise.all(frames.map((f, i) => (plans[i] ? selftest(bidi, f, { hands: plans[i].actions }) : null)));
  let ok = true;
  for (let i = 0; i < frames.length; i++) {
    if (!plans[i]) continue;
    const value = JSON.parse(await evaluate(bidi, frames[i], `JSON.stringify(window.__state().value)`));
    say(verbose, `frame ${i}: ${looks[i].view.trim()}`);
    printResults(runs[i].hands.results, verbose);
    say(verbose, `  the page holds ${JSON.stringify(value)}`);
    if (value !== plans[i].want) ok = false;
  }
  say(verbose, `all frames: ${Date.now() - t0} ms${flag('--no-lock') ? ' (turn-taking OFF)' : ''}`);
  return { ok, ms: Date.now() - t0 };
}

// The whole loop. `brain(request, n)` answers each model call with the
// arguments of a form_actions call.
async function runAgent(bidi, ctx, brain, { profile, logging, maxLooks }, verbose) {
  await postRequest(bidi, ctx, { noTrusted: NO_TRUSTED, agent: { profiles: [{ name: 'Bench', data: profile }], maxLooks, logging } });
  const t0 = Date.now();
  let served = 0;
  for (;;) {
    await sleep(200);
    const done = await readAttr(bidi, ctx, 'data-ff-selftest-res');
    if (done) {
      const out = JSON.parse(done);
      if (out.error) throw new Error(out.error);
      say(verbose, `\nfinished after ${served} model call(s), ${Date.now() - t0} ms\nresult: ${JSON.stringify(out.agent && { status: out.agent.status, message: out.agent.message })}`);
      say(verbose, `\n--- the page at the end ---\n${out.view}\n---`);
      return out;
    }
    const raw = await readAttr(bidi, ctx, 'data-ff-llm-req');
    const q = raw && JSON.parse(raw);
    if (!q || q.turn <= served) continue;
    const plan = await brain(q, q.turn);
    await evaluate(bidi, ctx, `document.documentElement.setAttribute('data-ff-llm-res', ${JSON.stringify(JSON.stringify(plan))}); true`);
    served = q.turn;
  }
}

// The model's place taken by files: each request is written to
// <dir>/request-<n>.txt (the rules and profile to system.txt) and the answer
// is read from <dir>/response-<n>.json. Lets a real model, or a person, be
// the brain of a bench run.
function fileBrain(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^(request|response)-\d+\.|^system\.txt$|^result\.json$/.test(f)) fs.rmSync(path.join(dir, f));
  return async (q, n) => {
    if (q.system) fs.writeFileSync(path.join(dir, 'system.txt'), q.system);
    fs.writeFileSync(path.join(dir, `request-${n}.txt`), q.content);
    const file = path.join(dir, `response-${n}.json`);
    console.log(`model call ${n}: waiting for ${file}`);
    const t0 = Date.now();
    while (!fs.existsSync(file)) {
      await sleep(300);
      if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('no answer for model call ' + n);
    }
    await sleep(150);   // let the writer finish
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
}

// The scenario's own script as the model: look n answers with batch n.
const scriptBrain = sc => (q, n) => {
  const view = q.content.slice(q.content.lastIndexOf('PAGE: '));
  return { actions: sc.looks[n - 1] ? sc.looks[n - 1](view) : [], done: n >= sc.looks.length, summary: 'Scripted run.' };
};

async function runLoop(bidi, ctx, sc, verbose) {
  const profile = fs.readFileSync(path.join(ROOT, 'test', 'bench_profile.txt'), 'utf8');
  const t0 = Date.now();
  const out = await runAgent(bidi, ctx, scriptBrain(sc), { profile, logging: true, maxLooks: 12 }, verbose);
  // What the user does next: press the page's button. That, too, is recorded.
  await evaluate(bidi, ctx, `(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /continuar/i.test(b.textContent)); if (b) b.click(); return true; })()`);
  await sleep(500);
  const log = (await selftest(bidi, ctx, { log: true })).log;
  const types = log ? log.entries.map(e => e.type) : [];
  const missing = sc.logHas.filter(t => !types.includes(t));
  const page = await pageState(bidi, ctx);
  say(verbose, 'page state:', JSON.stringify(page.state));
  say(verbose, 'fill log:', JSON.stringify(log && log.summary), '\nentries:', types.join(' '));
  if (missing.length) say(true, '  the fill log lacks: ' + missing.join(', '));
  const filledOk = out.agent && out.agent.status === 'success';
  return { ok: filledOk && sc.expect(page.state || {}) && !missing.length, ms: Date.now() - t0 };
}

async function runScenario(bidi, ctx, name, verbose) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown scenario "${name}" (${Object.keys(SCENARIOS).join(', ')})`);
  await openPage(bidi, ctx, opt('--page', sc.page));
  if (sc.frames) return runFrames(bidi, ctx, sc, verbose);
  if (sc.agent) return runLoop(bidi, ctx, sc, verbose);
  return runLooks(bidi, ctx, sc, verbose);
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error('dist/firefox missing; run build/build.ps1 -Target firefox');
  if (!fs.existsSync(BROWSER)) throw new Error('browser not found: ' + BROWSER);
  const server = await ensureServer();
  const browser = spawn(BROWSER, ['-no-remote', '-new-instance', '-profile', makeProfile(), '--remote-debugging-port', String(PORT), '--remote-allow-system-access', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { if (!KEEP) { try { browser.kill(); } catch {} } if (server) { try { server.kill(); } catch {} } };
  process.on('exit', cleanup);
  try {
    let ws = null;
    for (let i = 0; i < 80 && !ws; i++) { try { ws = await connect(`ws://127.0.0.1:${PORT}/session`); } catch { await sleep(500); } }
    if (!ws) throw new Error('remote agent did not come up on port ' + PORT);
    const bidi = client(ws);
    await bidi('session.new', { capabilities: {} });
    await bidi('webExtension.install', { extensionData: { type: 'path', path: DIST } });
    const ctx = (await bidi('browsingContext.getTree', {})).contexts[0].context;

    if (flag('--all')) {
      let failed = 0;
      for (const mode of ['real input', 'scripted input']) {
        NO_TRUSTED = mode === 'scripted input';
        for (const name of Object.keys(SCENARIOS).filter(n => n !== 'look')) {
          let r;
          try { r = await runScenario(bidi, ctx, name, false); } catch (e) { r = { ok: false, error: String(e.message || e).split('\n')[0] }; }
          if (!r.ok) failed++;
          console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(8)} ${mode.padEnd(14)} ${r.ms !== undefined ? r.ms + ' ms' : ''}${r.error ? ' ' + r.error : ''}${!r.ok && r.state ? ' state=' + JSON.stringify(r.state) : ''}`);
        }
      }
      console.log(failed ? `\n${failed} scenario run(s) FAILED` : '\nall scenarios passed');
      process.exitCode = failed ? 1 : 0;
    } else if (flag('--diag')) {
      await openPage(bidi, ctx, opt('--page', 'test/trusted_input_test.html'));
      console.log(JSON.stringify((await selftest(bidi, ctx, { diag: true })).diag, null, 1));
    } else if (BRAIN_DIR) {
      await openPage(bidi, ctx, opt('--page', 'test/dynamic_form_test.html'));
      const profile = fs.readFileSync(opt('--profile', path.join(ROOT, 'test', 'bench_profile.txt')), 'utf8');
      const out = await runAgent(bidi, ctx, fileBrain(BRAIN_DIR), { profile, logging: flag('--log'), maxLooks: Number(opt('--looks', 12)) }, true);
      fs.writeFileSync(path.join(BRAIN_DIR, 'result.json'), JSON.stringify(out, null, 1));
      console.log('page state:', JSON.stringify((await pageState(bidi, ctx)).state));
    } else {
      const r = await runScenario(bidi, ctx, SCENARIO || 'real', true);
      console.log(r.ok ? '\nas expected' : '\nNOT as expected');
      process.exitCode = r.ok ? 0 : 1;
    }
    if (KEEP) { console.log('\n--keep: browser left open; Ctrl+C to exit'); await new Promise(() => {}); }
  } finally {
    cleanup();
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
