/* ==========================================================================
   Oriental Weavers — Standalone (static-host) storage adapter
   --------------------------------------------------------------------------
   The platform normally reads and writes through the Table API at relative
   URLs such as `tables/projects`. Those endpoints only exist on the platform
   runtime. On a plain static host (GitHub Pages, Netlify, S3, file://) every
   one of them returns 404, so `loadAll()` would swallow the error and boot
   with eleven empty tables — the app "runs" but shows nothing.

   This file detects that situation and transparently swaps the Table API for
   a browser-local store backed by localStorage, then lets the normal bootstrap
   seed it. The result is a fully working copy of the platform with no backend.

   IMPORTANT, and surfaced in the UI banner: localStorage is per browser and
   per device. Each visitor to the static host gets their own private copy of
   the seed data, and edits are never shared. For one shared live database use
   the platform's Hosted Deploy instead.
   ========================================================================== */
'use strict';

const Standalone = (function () {

  const NS = 'ow_sa_v1__';          // key prefix for every table
  const FLAG_DISMISSED = 'ow_sa_v1_banner_dismissed';

  let mode = 'unknown';             // 'unknown' | 'remote' | 'local'
  let readyP = null;
  let installed = false;

  /* In-memory cache is the source of truth; localStorage is the durable copy.
     Writing the whole table back to localStorage on every single insert would
     be O(n²) during seeding, so flushes are coalesced on a microtask. */
  const mem = new Map();
  const dirty = new Set();
  let flushT = null;
  let quotaHit = false;

  /* ------------------------------------------------------------------ */
  /*  Storage primitives                                                 */
  /* ------------------------------------------------------------------ */
  function load(table) {
    if (mem.has(table)) return mem.get(table);
    let rows = [];
    try {
      const raw = localStorage.getItem(NS + table);
      if (raw) rows = JSON.parse(raw) || [];
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      console.warn('standalone: unreadable local table', table, e.message);
      rows = [];
    }
    mem.set(table, rows);
    return rows;
  }

  function mark(table) { dirty.add(table); scheduleFlush(); }

  function scheduleFlush() {
    if (flushT) return;
    flushT = setTimeout(() => { flushT = null; flush(); }, 0);
  }

  function flush() {
    if (!dirty.size) return;
    dirty.forEach(t => {
      try {
        localStorage.setItem(NS + t, JSON.stringify(mem.get(t) || []));
      } catch (e) {
        if (!quotaHit) {
          quotaHit = true;
          console.warn('standalone: storage quota exceeded', t, e.message);
          quotaNotice();
        }
      }
    });
    dirty.clear();
  }

  function flushNow() { if (flushT) { clearTimeout(flushT); flushT = null; } flush(); }

  function nowISO() { return new Date().toISOString(); }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /* ------------------------------------------------------------------ */
  /*  Table API-equivalent surface                                       */
  /* ------------------------------------------------------------------ */
  const local = {
    async all(table) { return load(table).slice(); },

    async list(table, params) {
      const rows = load(table).slice();
      const p = params || {};
      const page = Math.max(1, parseInt(p.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(p.limit, 10) || 100));
      const start = (page - 1) * limit;
      return { data: rows.slice(start, start + limit), total: rows.length };
    },

    async get(table, id) {
      const row = load(table).find(x => String(x.id) === String(id));
      if (!row) throw new Error('Record not found');
      return row;
    },

    async create(table, data) {
      const rows = load(table);
      const row = Object.assign({}, data);
      if (!row.id) row.id = uid();
      row.created_at = row.created_at || nowISO();
      row.updated_at = row.updated_at || nowISO();
      rows.push(row);
      mark(table);
      return row;
    },

    async update(table, id, data) {
      const rows = load(table);
      const i = rows.findIndex(x => String(x.id) === String(id));
      if (i < 0) throw new Error('Record not found');
      rows[i] = Object.assign({}, data, {
        id: rows[i].id,
        created_at: rows[i].created_at,
        updated_at: nowISO()
      });
      mark(table);
      return rows[i];
    },

    async patch(table, id, data) {
      const rows = load(table);
      const i = rows.findIndex(x => String(x.id) === String(id));
      if (i < 0) throw new Error('Record not found');
      rows[i] = Object.assign({}, rows[i], data, { updated_at: nowISO() });
      mark(table);
      return rows[i];
    },

    async remove(table, id) {
      const rows = load(table);
      const i = rows.findIndex(x => String(x.id) === String(id));
      if (i >= 0) { rows.splice(i, 1); mark(table); }
      return null;
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Mode detection                                                     */
  /* ------------------------------------------------------------------ */
  async function detect() {
    /* Explicit override, used for testing and for hosts that answer unknown
       paths with a 200 HTML fallback instead of a 404. */
    if (window.OW_FORCE_STANDALONE === true) { mode = 'local'; return mode; }
    if (location.protocol === 'file:') { mode = 'local'; return mode; }

    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 4000) : null;
      const res = await fetch('tables/projects?limit=1', {
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      /* A real Table API answers JSON. A static host answers 404, or 200 with
         index.html — the content-type check catches that fallback case. */
      mode = (res.ok && ct.indexOf('json') > -1) ? 'remote' : 'local';
    } catch (e) {
      mode = 'local';
    }
    return mode;
  }

  function ready() {
    if (!readyP) readyP = detect();
    return readyP;
  }

  /* ------------------------------------------------------------------ */
  /*  Install the adapter                                                */
  /* ------------------------------------------------------------------ */
  function install() {
    if (installed || typeof API === 'undefined') return;
    installed = true;

    ['list', 'all', 'get', 'create', 'update', 'patch', 'remove'].forEach(function (m) {
      const orig = API[m].bind(API);
      API[m] = async function () {
        await ready();
        if (mode === 'local') {
          const out = await local[m].apply(null, arguments);
          /* Reads are free; writes mark the table dirty and a coalesced
             microtask flush persists it (seeding issues 20 rows per batch,
             so this writes each table once per batch, not once per row). */
          return out;
        }
        return orig.apply(null, arguments);
      };
    });

    window.addEventListener('beforeunload', flushNow);
    window.addEventListener('pagehide', flushNow);
  }

  /* ------------------------------------------------------------------ */
  /*  User-facing notice                                                 */
  /* ------------------------------------------------------------------ */
  function arabic() {
    return typeof I18N !== 'undefined' && I18N.isArabic;
  }

  function notice() {
    if (mode !== 'local') return;
    if (document.getElementById('saNote')) return;
    try { if (localStorage.getItem(FLAG_DISMISSED) === '1') return; } catch (e) { /* ignore */ }

    const host = document.querySelector('.main') || document.body;
    if (!host) return;

    const ar = arabic();
    const el = document.createElement('div');
    el.id = 'saNote';
    el.className = 'banner banner-warn no-print';
    el.style.cssText = 'margin:12px 22px 0;align-items:center';

    el.innerHTML =
      '<i class="fa-solid fa-circle-info"></i>' +
      '<div style="flex:1">' +
        '<strong>' + (ar ? 'وضع العرض الساكن.' : 'Static demo mode.') + '</strong> ' +
        (ar
          ? 'هذه النسخة مُستضافة على GitHub Pages التي لا توفر قاعدة بيانات، لذلك يعمل التطبيق داخل هذا المتصفح فقط: '
          : 'This copy is hosted on a static file host with no database, so the app runs entirely in this browser: ') +
        (ar
          ? 'تُحفظ بياناتك محليًا و<strong>لا تُشارك</strong> مع زوار آخرين أو أجهزة أخرى. لقاعدة بيانات مشتركة استخدم النشر المُستضاف.'
          : 'your data is stored locally and is <strong>not shared</strong> with other visitors or devices. For a shared live database, use the platform\'s Hosted Deploy.') +
      '</div>' +
      '<button class="btn btn-sm" id="saReset"><i class="fa-solid fa-rotate-left"></i>' +
        (ar ? 'إعادة تعيين البيانات' : 'Reset demo data') + '</button>' +
      '<button class="icon-btn" id="saClose" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>';

    host.insertBefore(el, host.firstChild);
    if (host === document.body) el.style.cssText += ';margin:8px';

    const reset = el.querySelector('#saReset');
    if (reset) reset.addEventListener('click', function () {
      const ok = window.confirm(ar
        ? 'سيتم حذف جميع البيانات المحلية في هذا المتصفح وإعادة تحميل المشروعات الأصلية. هل تريد المتابعة؟'
        : 'This clears all locally stored data in this browser and reloads the original project records. Continue?');
      if (!ok) return;
      resetAll();
    });

    const close = el.querySelector('#saClose');
    if (close) close.addEventListener('click', function () {
      try { localStorage.setItem(FLAG_DISMISSED, '1'); } catch (e) { /* ignore */ }
      el.remove();
    });
  }

  function quotaNotice() {
    const host = document.querySelector('.main') || document.body;
    if (!host || document.getElementById('saQuota')) return;
    const el = document.createElement('div');
    el.id = 'saQuota';
    el.className = 'banner banner-warn no-print';
    el.style.cssText = 'margin:12px 22px 0';
    el.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i><div><strong>Browser storage is full.</strong> ' +
      'Recent changes may not have been saved. Reset the demo data to recover, or use Hosted Deploy for a shared database.</div>';
    host.insertBefore(el, host.firstChild);
  }

  function resetAll() {
    try {
      const kill = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(NS) === 0 && k !== FLAG_DISMISSED) kill.push(k);
      }
      kill.forEach(k => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
    location.reload();
  }

  /* ------------------------------------------------------------------ */
  /*  Boot                                                               */
  /* ------------------------------------------------------------------ */
  function boot() {
    install();
    ready().then(function () {
      document.documentElement.setAttribute('data-storage', mode);
      if (mode === 'local') {
        document.body && document.body.classList.add('standalone');
        /* Give the app shell a moment to render, then show the notice. */
        setTimeout(notice, 900);
      }
    });
  }

  /* Install synchronously as soon as this file executes, so the very first
     loadAll() already goes through the adapter. Every wrapped call awaits
     ready(), so mode detection resolves before any real request is made. */
  if (typeof API !== 'undefined') boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  return {
    get mode() { return mode; },
    isLocal() { return mode === 'local'; },
    ready: ready,
    reset: resetAll,
    flush: flushNow
  };
})();
