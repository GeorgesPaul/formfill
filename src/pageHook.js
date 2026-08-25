// pageHook.js -- runs in the PAGE's JavaScript world (manifest: world MAIN),
// not in the extension's isolated world. Its only job is to tell the fill
// logger what the page actually sent to its server when the form was
// submitted, which a content script cannot see from the outside.
//
// Dormant until the isolated-world content script dispatches
//   document.dispatchEvent(new CustomEvent('ff-record', { detail: 'on' }))
// which only happens after a fill session ran in this tab and logging is
// enabled. From then on, non-GET fetch/XHR/sendBeacon calls and programmatic
// form.submit() calls are summarised (URL, method, a capped body preview with
// password-like keys redacted) and handed back through a DOM event:
//   'ff-net-capture' with detail = JSON string
// Nothing is modified or blocked; the original call always proceeds.
(function () {
    'use strict';
    if (window.__ffHookInstalled) return;
    window.__ffHookInstalled = true;

    let active = false;
    let installed = false;
    const SECRET_KEY = /pass(word)?|pwd|secret|cvv|cvc|csc/i;
    const MAX_BODY = 20000;

    function emit(rec) {
        try {
            rec.t = Date.now();
            rec.pageUrl = location.href;
            document.dispatchEvent(new CustomEvent('ff-net-capture', { detail: JSON.stringify(rec) }));
        } catch (_) {}
    }

    function redactPairs(pairs) {
        return pairs.map(([k, v]) => [k, SECRET_KEY.test(String(k)) ? '[redacted]' : v]);
    }

    function redactJson(text) {
        try {
            const obj = JSON.parse(text);
            const walk = (o) => {
                if (!o || typeof o !== 'object') return o;
                for (const k of Object.keys(o)) {
                    if (SECRET_KEY.test(k)) o[k] = '[redacted]';
                    else o[k] = walk(o[k]);
                }
                return o;
            };
            return JSON.stringify(walk(obj));
        } catch (_) { return text; }
    }

    function preview(body) {
        try {
            if (body == null) return null;
            if (typeof body === 'string') {
                let s = body;
                if (s[0] === '{' || s[0] === '[') s = redactJson(s);
                else if (/^[^=&]+=[^&]*(&|$)/.test(s)) {
                    const p = new URLSearchParams(s);
                    s = new URLSearchParams(redactPairs(Array.from(p.entries()))).toString();
                }
                return { type: 'text', text: s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…' : s };
            }
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                const entries = [];
                for (const [k, v] of body.entries()) {
                    entries.push([k, typeof v === 'string' ? (v.length > 500 ? v.slice(0, 500) + '…' : v) : `[file ${v.name || ''} ${v.size || 0}B]`]);
                    if (entries.length >= 300) break;
                }
                return { type: 'formdata', entries: redactPairs(entries) };
            }
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                return { type: 'urlencoded', entries: redactPairs(Array.from(body.entries())) };
            }
            if (typeof Blob !== 'undefined' && body instanceof Blob) return { type: 'blob', size: body.size, mime: body.type };
            if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { type: 'binary', size: body.byteLength };
            return { type: typeof body, text: String(body).slice(0, 500) };
        } catch (e) {
            return { type: 'error', text: String(e && e.message) };
        }
    }

    function install() {
        if (installed) return;
        installed = true;

        const origFetch = window.fetch;
        if (typeof origFetch === 'function') {
            window.fetch = function (input, init) {
                if (active) {
                    try {
                        const isReq = typeof Request !== 'undefined' && input instanceof Request;
                        const url = isReq ? input.url : String(input);
                        const method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
                        if (method !== 'GET' && method !== 'HEAD') {
                            let body = init && init.body;
                            if (body == null && isReq) {
                                // Body already consumed into the Request: clone and read it async.
                                try {
                                    input.clone().text().then(t => emit({ kind: 'fetch', url, method, body: preview(t) })).catch(() => {});
                                    body = undefined;
                                } catch (_) {}
                            }
                            if (body !== undefined) emit({ kind: 'fetch', url, method, body: preview(body) });
                        }
                    } catch (_) {}
                }
                return origFetch.apply(this, arguments);
            };
        }

        const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (XP && XP.open && XP.send) {
            const origOpen = XP.open, origSend = XP.send;
            XP.open = function (method, url) {
                try { this.__ffMethod = String(method || 'GET').toUpperCase(); this.__ffUrl = String(url); } catch (_) {}
                return origOpen.apply(this, arguments);
            };
            XP.send = function (body) {
                if (active) {
                    try {
                        if (this.__ffMethod && this.__ffMethod !== 'GET' && this.__ffMethod !== 'HEAD') {
                            emit({ kind: 'xhr', url: this.__ffUrl, method: this.__ffMethod, body: preview(body) });
                        }
                    } catch (_) {}
                }
                return origSend.apply(this, arguments);
            };
        }

        if (navigator.sendBeacon) {
            const origBeacon = navigator.sendBeacon;
            navigator.sendBeacon = function (url, data) {
                if (active) { try { emit({ kind: 'beacon', url: String(url), method: 'POST', body: preview(data) }); } catch (_) {} }
                return origBeacon.apply(this, arguments);
            };
        }

        if (window.HTMLFormElement && HTMLFormElement.prototype.submit) {
            const origSubmit = HTMLFormElement.prototype.submit;
            HTMLFormElement.prototype.submit = function () {
                if (active) {
                    try { emit({ kind: 'form.submit()', url: this.action, method: (this.method || 'get').toUpperCase(), body: preview(new FormData(this)) }); } catch (_) {}
                }
                return origSubmit.apply(this, arguments);
            };
        }
    }

    document.addEventListener('ff-record', function (e) {
        const on = e && e.detail === 'on';
        if (on) install();
        active = on;
    });
})();
