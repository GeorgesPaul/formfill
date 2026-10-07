// api.js -- the privileged half of trusted input (runs in the browser's parent
// process as a WebExtension Experiment; Firefox and forks built without
// signing enforcement, such as Floorp, load it from a temporary add-on).
//
// Events a content script dispatches are isTrusted:false and the browser runs
// no default action for them: a synthetic mousedown focuses nothing, a
// synthetic keydown inserts nothing, a synthetic Enter submits nothing. That
// ceiling is what left some widgets (menus that track their own focus, masked
// inputs, anything that checks isTrusted) beyond reach. This API goes under
// the ceiling: it drives the browser's own WebDriver input machinery. The
// remote agent's message handler forwards a `_dispatchEvent` command to its
// in-content input module, which synthesizes the event through
// nsIDOMWindowUtils / nsITextInputProcessor in the frame's own process. That
// is exactly what WebDriver BiDi's input.performActions does; no WebDriver
// session is created and navigator.webdriver stays false.
//
// Why not our own JSWindowActor: its module would have to be readable from a
// sandboxed content process, and a temporary add-on's files under the
// developer's profile are not. The remote agent's modules ship inside omni.ja
// (chrome://), which every process can read.
//
// The content script never talks to this file directly: it sends an ffInput
// message to the background page, which calls browser.ffInput.run with the
// sender's tab and frame. Coordinates are CSS pixels of that frame's
// viewport (getBoundingClientRect in the content script).
/* global ExtensionAPI, ExtensionCommon, Services, ChromeUtils, Ci */
"use strict";

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const SESSION_ID = "formfill-trusted-input";
const MAX_WAIT_MS = 3000;
const MAX_OPS = 2000;

let handlerError = null;
let rootHandler = null;
let keyData = null;

function describeError(e) {
  if (!e) return "unknown error";
  const msg = (e.message || String(e));
  const where = e.stack ? " @ " + String(e.stack).split(/\r?\n/)[0] : "";
  return msg + where;
}

function root() {
  if (rootHandler) return rootHandler;
  if (handlerError) throw new Error(handlerError);
  try {
    const { RootMessageHandlerRegistry } = ChromeUtils.importESModule(
      "chrome://remote/content/shared/messagehandler/RootMessageHandlerRegistry.sys.mjs"
    );
    ({ keyData } = ChromeUtils.importESModule("chrome://remote/content/shared/webdriver/KeyData.sys.mjs"));
    rootHandler = RootMessageHandlerRegistry.getOrCreateMessageHandler(SESSION_ID);
    return rootHandler;
  } catch (e) {
    handlerError = "remote agent message handler unavailable: " + describeError(e);
    throw new Error(handlerError);
  }
}

function releaseRoot() {
  if (!rootHandler) return;
  try { rootHandler.destroy(); } catch (_) {}
  rootHandler = null;
}

// One event through the in-content input module, in the frame's process.
function dispatch(bc, eventName, details) {
  return root().handleCommand({
    moduleName: "input",
    commandName: "_dispatchEvent",
    params: { eventName, details },
    destination: { type: "WINDOW_GLOBAL", id: bc.id },
    retryOnAbort: false,
    skipPrivilegeCheck: true,
  });
}

const SPECIAL_KEYS = new Set([
  "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab",
  "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Insert", "Space",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);

function modifiersOf(op) {
  const accel = !!op.accel;
  const mac = AppConstants.platform === "macosx";
  return {
    shiftKey: !!op.shift,
    ctrlKey: !!op.ctrl || (accel && !mac),
    altKey: !!op.alt,
    metaKey: !!op.meta || (accel && mac),
  };
}

// A key description in the shape WebDriver's Event.sendSingleKey expects.
function keyOf(name, mods) {
  const chars = Array.from(String(name));
  if (chars.length === 1) {
    const d = keyData.getData(chars[0]);
    return { ...d, ...mods, shiftKey: mods.shiftKey || !!d.shifted };
  }
  if (!SPECIAL_KEYS.has(name)) throw new Error(`unknown key ${name}`);
  return { key: name === "Space" ? " " : name, code: name === "Space" ? "Space" : name, location: 0, printable: name === "Space", ...mods };
}

async function pressKey(bc, name, mods) {
  const key = keyOf(name, mods);
  await dispatch(bc, "synthesizeKeyDown", { eventData: key });
  await dispatch(bc, "synthesizeKeyUp", { eventData: key });
}

async function runOps(bc, ops) {
  const results = [];
  let ok = true;
  for (const op of ops) {
    try {
      switch (op.kind) {
        case "ping":
          results.push({ kind: "ping" });
          break;
        case "mouse": {
          const type = String(op.type || "mousedown");
          const prevented = await dispatch(bc, "synthesizeMouseAtPoint", {
            x: Number(op.x) || 0,
            y: Number(op.y) || 0,
            eventData: {
              type,
              button: Number(op.button) || 0,
              clickCount: Number(op.clickCount) || 1,
              ...modifiersOf(op),
            },
          });
          results.push({ kind: "mouse", type, defaultPrevented: !!prevented });
          break;
        }
        case "key": {
          const name = String(op.key || "");
          if (!name) throw new Error("key op without key");
          await pressKey(bc, name, modifiersOf(op));
          results.push({ kind: "key", key: name });
          break;
        }
        case "string": {
          const text = String(op.text || "");
          // Surrogate pairs are one key press, as WebDriver sends them.
          for (const ch of Array.from(text)) await pressKey(bc, ch, modifiersOf({}));
          results.push({ kind: "string", length: text.length });
          break;
        }
        case "wait": {
          const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number(op.ms) || 0));
          await new Promise(resolve => setTimeout(resolve, ms));
          results.push({ kind: "wait", ms });
          break;
        }
        default:
          throw new Error(`unknown op kind ${op && op.kind}`);
      }
    } catch (e) {
      ok = false;
      results.push({ kind: op && op.kind, error: describeError(e) });
      break;
    }
  }
  return { ok, results };
}

this.ffInput = class extends ExtensionAPI {
  onShutdown() {
    releaseRoot();
  }

  getAPI(context) {
    const { extension } = context;
    const { ExtensionError } = ExtensionCommon;

    function frameContext(tabId, frameId) {
      const tab = extension.tabManager.get(tabId);
      const browser = tab && tab.browser;
      if (!browser || !browser.browsingContext) throw new ExtensionError(`No browser for tab ${tabId}`);
      const top = browser.browsingContext;
      if (!frameId) return top;
      const bc = top.getAllBrowsingContextsInSubtree().find(b => b.id === frameId);
      if (!bc) throw new ExtensionError(`Frame ${frameId} is not in tab ${tabId}`);
      return bc;
    }

    return {
      ffInput: {
        async probe() {
          try { root(); } catch (e) { return { available: false, reason: describeError(e) }; }
          return { available: true, backend: "gecko-experiment" };
        },

        // Errors travel as data: a thrown non-ExtensionError reaches the
        // caller only as "An unexpected error occurred".
        async run(tabId, frameId, ops) {
          try {
            const bc = frameContext(tabId, frameId);
            if (!bc.currentWindowGlobal) return { ok: false, error: "frame has no window" };
            const list = Array.isArray(ops) ? ops.slice(0, MAX_OPS) : [];
            const waits = list.reduce((a, o) => a + (o && o.kind === "wait" ? (Number(o.ms) || 0) : 0), 0);
            const limit = 3000 + waits + list.length * 25;
            const reply = await Promise.race([
              runOps(bc, list),
              new Promise(resolve => setTimeout(() => resolve({ ok: false, error: `no answer from the frame within ${limit} ms`, results: [] }), limit)),
            ]);
            return JSON.parse(JSON.stringify(reply));
          } catch (e) {
            return { ok: false, error: "ffInput.run failed: " + describeError(e), results: [] };
          }
        },
      },
    };
  }
};
