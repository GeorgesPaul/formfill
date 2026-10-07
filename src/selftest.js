// selftest.js -- the bench hook: lets tools/floorp_rig.mjs drive the real
// extension, real input included, with no model and no panel.
// Development builds only (the store build leaves this file out), and only on
// pages served from this machine.
//
// A test page, or the rig through it, puts a JSON request in
// data-ff-selftest-req on <html> and dispatches an `ff-selftest` event; the
// answer lands in data-ff-selftest-res. A request may ask for any of:
//
//   view: true          the page as the model would be shown it (fresh: true
//                       to mark nothing as new)
//   hands: [actions]    run a batch of actions on the numbers of that view
//   agent: {profiles}   run the whole loop; each model call is put in
//                       data-ff-llm-req and answered through data-ff-llm-res
//   log: true           the fill log of the last session, as stored
//   diag: true          the real-input transport, stage by stage
//   noTrusted, noLock   switch real input / the turn-taking between frames off
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  document.addEventListener('ff-selftest', async () => {
    const root = document.documentElement;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    let req = {};
    try { req = JSON.parse(root.getAttribute('data-ff-selftest-req') || '{}'); } catch (_) {}
    const out = { startedAt: Date.now() };
    try {
      if (req.noTrusted) window.__ffNoTrustedInput = true; else delete window.__ffNoTrustedInput;
      if (req.noLock) window.__ffNoInputLock = true; else delete window.__ffNoInputLock;
      out.probe = await TrustedInput.probe(true);

      if (req.diag) out.diag = await transportDiagnostics();

      const look = fresh => {
        const view = PageView.capture(fresh ? { baseline: null } : {});
        PageView.commit(view);
        out.view = view.text;
        out.viewHasNew = view.hasNew;
      };
      if (req.view) look(req.fresh);
      if (Array.isArray(req.hands) && req.hands.length) {
        out.hands = await Hands.run(req.hands);
        await Hands.atRest(250, 2000);
        if (!out.hands.stopped && Hands.letGo()) await Hands.atRest(200, 1200);
        look(false);
      }

      if (req.agent) {
        // The rig answers in the model's place.
        let calls = 0;
        const bridge = async messages => {
          const n = ++calls;
          const lastMessage = messages[messages.length - 1];
          const content = typeof lastMessage.content === 'string' ? lastMessage.content : lastMessage.content.map(p => p.text || '').join(' ');
          root.removeAttribute('data-ff-llm-res');
          root.setAttribute('data-ff-llm-req', JSON.stringify({ turn: n, system: n === 1 ? messages[0].content : undefined, content }));
          let answer = null;
          while (!(answer = root.getAttribute('data-ff-llm-res'))) await wait(150);
          root.removeAttribute('data-ff-llm-res');
          root.removeAttribute('data-ff-llm-req');
          const id = 'bridge' + n;
          return {
            text: '', toolCalls: [{ id, name: 'form_actions', args: JSON.parse(answer) }],
            assistantMessage: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'form_actions', arguments: answer } }] },
            usage: null, latencyMs: 0, model: 'bridge', provider: 'bridge',
          };
        };
        out.agent = await FillAgent.run({
          profiles: req.agent.profiles || [], customPrompt: req.agent.customPrompt || '',
          sessionId: 'selftest-' + Date.now(), llm: bridge, logging: !!req.agent.logging, maxLooks: req.agent.maxLooks,
        });
        out.view = PageView.capture({ baseline: null }).text;
      }

      if (req.log) {
        await wait(400);   // let the background finish writing
        const list = (await browser.runtime.sendMessage({ action: 'ffLogList' })).list || [];
        const stored = list.length ? (await browser.runtime.sendMessage({ action: 'ffLogGet', ids: [list[list.length - 1].id] })).sessions[0] : null;
        out.log = stored && { summary: stored.summary, entries: stored.entries.map(e => ({ type: e.type, frame: e.frame, look: e.look, trigger: e.trigger })) };
      }
      out.inputStats = { ...TrustedInput.stats };
    } catch (e) {
      out.error = String((e && e.stack) || e);
    }
    out.ms = Date.now() - out.startedAt;
    root.setAttribute('data-ff-selftest-res', JSON.stringify(out));
  });

  // Each stage of real input on its own, timed, so a stall names its stage.
  async function transportDiagnostics() {
    const diag = {};
    const stage = async (name, ops) => { const t = Date.now(); const r = await TrustedInput.run(ops); diag[name] = { ms: Date.now() - t, r }; };
    await stage('ping', [{ kind: 'ping' }]);
    await stage('wait', [{ kind: 'wait', ms: 10 }]);
    const el = document.querySelector('input[type=email]') || document.querySelector('input:not([type=hidden]), [role=combobox]');
    const p = el && TrustedInput.pointFor(el);
    if (!p) return diag;
    diag.point = { x: p.x, y: p.y, hit: p.hit && p.hit.tagName + '#' + p.hit.id };
    await stage('move', [{ kind: 'mouse', type: 'mousemove', x: p.x, y: p.y }]);
    await stage('click', [{ kind: 'mouse', type: 'mousedown', x: p.x, y: p.y }, { kind: 'mouse', type: 'mouseup', x: p.x, y: p.y }]);
    diag.active = document.activeElement && (document.activeElement.tagName + '#' + document.activeElement.id);
    await stage('key', [{ kind: 'key', key: 'a' }]);
    const landed = [];
    const record = e => landed.push(e.target.tagName + '#' + e.target.id + ':' + e.key + ':' + (e.isTrusted ? 'T' : 'S'));
    document.addEventListener('keydown', record, true);
    await stage('string', [{ kind: 'string', text: 'b@ex-am.ple_c+o' }]);
    document.removeEventListener('keydown', record, true);
    diag.landed = landed;
    diag.value = TypingEngine.live(el).value;
    return diag;
  }
}
