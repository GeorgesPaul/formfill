// background_test.js -- the background page's bookkeeping, run in Node:
//   node test/background_test.js
//
// Loads src/background.js with a stubbed `browser` and plays the reports the
// frames of a tab send during a fill: frames that start late, frames that
// outlive the others, a stop, a page without fields, a frame that fails, and
// the turn-taking between frames. Exits non-zero when a check fails.
const vm = require('vm'), fs = require('fs'), path = require('path');

let listener = null;
const toPanel = [];
const context = {
  console: { log() {}, warn() {}, error: console.error },
  setTimeout, clearTimeout, Date, Map, Set, JSON, Math, Object, Promise, String, Number, Array,
  browser: {
    runtime: { onMessage: { addListener: f => { listener = f; } } },
    tabs: { onRemoved: { addListener() {} } },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  },
  Compat: { notify: m => toPanel.push(m) },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8'), context);

const send = (action, frameId, extra = {}) => {
  let answer;
  listener({ action, sessionId: 'A', ...extra }, { frameId, tab: { id: 1 } }, r => { answer = r; });
  return answer;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const last = () => toPanel[toPanel.length - 1];
const completions = () => toPanel.filter(m => m.action === 'fillFormComplete').length;
let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(ok ? 'ok  ' : 'FAIL', name); };

(async () => {
  // A slow frame joins first and starts well after the fast one has finished.
  send('fillFormJoin', 0); send('fillFormJoin', 5);
  send('fillFormStart', 0); send('fillFormProgress', 0, { processed: 0, total: 1 });
  send('fillFormComplete', 0, { filled: 1, details: { llmCalls: 1, summary: 'Top done.' } });
  await wait(600);
  check('not complete while a joined frame has not started', completions() === 0);
  check('status says a fill is running', send('fillStatus', 0).filling === true);
  send('fillFormStart', 5); send('fillFormProgress', 5, { processed: 0, total: 1 });
  send('fillFormComplete', 5, { filled: 2, details: { llmCalls: 1, summary: 'Frame done.', needsUserInput: [{ label: 'CVC' }] } });
  await wait(600);
  check('one completion once both frames are through', completions() === 1 && /Filled 3 field\(s\)/.test(last().message) && /2 model calls/.test(last().message));
  check('the frames\' summaries and open points reach the panel', /Top done\. Frame done\./.test(last().message) && last().details.needsUserInput.length === 1);
  check('status is idle afterwards', send('fillStatus', 0).filling === false);

  // A frame that still reports after "complete" brings the fill back.
  send('fillFormProgress', 7, { processed: 0, total: 1 });
  check('a late report reopens the fill for the panel', toPanel.some(m => m.action === 'fillFormStart' && /Still filling/.test(m.message)) && send('fillStatus', 0).filling === true);
  send('fillFormComplete', 7, { filled: 1 });
  await wait(600);
  check('the reopened fill completes again', completions() === 2);

  // Stop: what the frames of the stopped fill still send is ignored.
  toPanel.length = 0;
  send('fillFormJoin', 0, { sessionId: 'B' }); send('fillFormStart', 0, { sessionId: 'B' });
  send('fillStop', 0, { sessionId: 'B' });
  send('fillFormProgress', 0, { sessionId: 'B', processed: 0, total: 1 });
  send('fillFormStopped', 0, { sessionId: 'B' });
  check('a stopped fill stays stopped', send('fillStatus', 0).filling === false && !toPanel.some(m => /Still filling/.test(m.message || '')));

  // Every frame says it has no fields.
  toPanel.length = 0;
  send('fillFormJoin', 0, { sessionId: 'C' }); send('fillFormJoin', 3, { sessionId: 'C' });
  send('fillFormLeave', 0, { sessionId: 'C' }); send('fillFormLeave', 3, { sessionId: 'C' });
  await wait(600);
  check('a page without fields says so and ends', completions() === 1 && /No form fields/.test(last().message));

  // A fill does not inherit the numbers of the one before; a frame's own words are passed on.
  toPanel.length = 0;
  send('fillFormStart', 0, { sessionId: 'D' });
  send('fillFormComplete', 0, { sessionId: 'D', filled: 2, message: 'Filled 2 credential field(s) from KeePass.' });
  await wait(600);
  check('fresh numbers per fill, frame message shown', /Filled 2 field\(s\)/.test(last().message) && /from KeePass/.test(last().message));

  // One frame fails while another succeeds.
  toPanel.length = 0;
  send('fillFormJoin', 0, { sessionId: 'E' }); send('fillFormJoin', 2, { sessionId: 'E' });
  send('fillFormStart', 0, { sessionId: 'E' }); send('fillFormStart', 2, { sessionId: 'E' });
  send('fillFormError', 2, { sessionId: 'E', error: 'model unreachable' });
  check('a failing frame does not end the fill while another is filling', send('fillStatus', 0).filling === true);
  send('fillFormComplete', 0, { sessionId: 'E', filled: 4 });
  await wait(600);
  check('the failure is part of the final report', last().action === 'fillFormComplete' && /model unreachable/.test(last().message));

  // The only frame fails.
  toPanel.length = 0;
  send('fillFormStart', 0, { sessionId: 'F' });
  send('fillFormError', 0, { sessionId: 'F', error: 'No profile selected.' });
  check('a lone failure ends the fill with the error', last().action === 'fillFormError' && send('fillStatus', 0).filling === false);

  // Turn-taking: the second frame waits until the first gives the turn back.
  const grants = [];
  const lock = (op, frameId, token) => listener({ action: 'ffInputLock', op, token }, { frameId, tab: { id: 9 } }, r => { if (op === 'acquire') grants.push([token, r]); });
  lock('acquire', 1, 'a'); lock('acquire', 2, 'b');
  check('first frame has the turn, second waits', grants.length === 1 && grants[0][0] === 'a');
  lock('release', 1, 'a');
  check('second frame gets it on release', grants.length === 2 && grants[1][0] === 'b' && grants[1][1].granted === true);
  lock('acquire', 3, 'c'); lock('drop', 2);
  check('a frame that drops out passes the turn on', grants.length === 3 && grants[2][0] === 'c');

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
