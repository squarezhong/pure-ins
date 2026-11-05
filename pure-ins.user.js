// ==UserScript==
// @name         Pure Ins
// @namespace    https://github.com/squarezhong/pure-ins
// @version      0.2.0
// @description  关注优先，清理 Instagram 推荐与显式广告，保留主动搜索、帖子、Stories 和日常互动。
// @author       squarezhong
// @homepageURL  https://github.com/squarezhong/pure-ins
// @supportURL   https://github.com/squarezhong/pure-ins/issues
// @updateURL    https://raw.githubusercontent.com/squarezhong/pure-ins/main/pure-ins.user.js
// @downloadURL  https://raw.githubusercontent.com/squarezhong/pure-ins/main/pure-ins.user.js
// @match        https://instagram.com/*
// @match        https://www.instagram.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';
  const HOSTS = ['instagram.com', 'www.instagram.com'];
  if (window.top !== window.self || !HOSTS.includes(location.hostname)) return;
  const KEY = 'pure-ins-settings-v1', UI = 'pure-ins-settings', HIDDEN = 'pure-ins-hidden';
  const NOTE = 'pure-ins-notice';
  const QUIET = 'pure-ins-quiet-notifications', KEEP = 'pure-ins-notification-part';
  const OPTIONS = [
    ['followingList', '首页和 logo 打开自己的关注名单', true],
    ['hideHome', '隐藏 Home 入口', true],
    ['ads', '清理显式广告', true], ['modules', '清理推荐关注与相关推荐', true],
    ['explore', '清理发现推荐网格（保留主动搜索）', true],
    ['reels', '清理 Reels 推荐流（保留直接打开的视频）', true],
    ['navigation', '隐藏发现、Reels 和平台推广入口', true],
    ['notificationBadges', '始终隐藏通知红点和数字徽标（保留通知入口）', true]
  ];
  const defaults = Object.fromEntries(OPTIONS.map(([k, , v]) => [k, v]));
  const query = (s, root = document) => [...root.querySelectorAll(s)];
  const text = e => (e?.textContent || '').replace(/\s+/g, ' ').trim();
  const label = e => e?.getAttribute('aria-label') || e?.querySelector('svg[aria-label]')?.getAttribute('aria-label') || text(e);
  const words = {
    following: /^(Following|关注中|已关注|已關注|追蹤中|正在关注|正在追蹤|关注|追蹤)$/i,
    follow: /^(Follow|Follow back|关注|关注回去|關注|追蹤|追蹤對方|回关|回追)$/i,
    suggested: /^(Suggested for you|Suggested posts|Recommended for you|为你推荐|為你推薦|推荐帖子|推薦貼文|推薦的貼文|为你推荐的帖子|为你推荐的用户|為你推薦的用戶|为你推荐的账户)$/i,
    ad: /^(Sponsored|Ad|Advertisement|广告|廣告|赞助内容|贊助內容|赞助|贊助)$/i,
    more: /^(More options|更多选项|更多選項|更多選擇)$/i,
    like: /^(Like|Unlike|赞|讚|赞好|取消赞|取消讚|按讚|收回讚)$/i,
    share: /^(Share|分享|分享帖子|分享貼文)$/i,
    comment: /^(Comment|评论|評論|留言)$/i,
    save: /^(Save|Remove|Unsave|收藏|保存|儲存|取消收藏|取消保存|移除)$/i,
    search: /^(Search|搜索|搜尋|搜寻)$/i,
    notifications: /^(Notifications|通知)$/i,
    reelNav: /^(Reels navigation controls|Reels 导航控件|Reels 導覽控制項)$/i,
    player: /^(Video player|视频播放器|影片播放器)$/i
  };
  const EDITOR = 'form,[contenteditable="true"],textarea,[role="textbox"]';
  const OWNED = `#${UI},#${NOTE},#pure-ins-style`;
  const normalize = value => ({ version: 1, ...Object.fromEntries(OPTIONS.map(([k, , v]) => [k, typeof value?.[k] === 'boolean' ? value[k] : v])) });
  let settings;
  try { settings = normalize(typeof GM_getValue === 'function' ? GM_getValue(KEY, null) : null); }
  catch (_) { settings = normalize(null); }
  let hidden = new Set(), frame = 0, observer, timer, stopped = false, lastURL = '';
  let reelTarget = null, reelSession = false, reelAnchor = '', reelIdentity = '';
  let quietRoots = new Set(), quietParts = new Set();
  const dirtyCards = new Set(), headers = new WeakMap();
  let adCards = new Set(), fullScan = true, shellDirty = true, shellHidden = new Set();
  let pendingList = null, listAttempted = false, homeIntent = false;
  let ui, dialog, status, lastFocus, saving = false;

  function urlOf(a) {
    try { return new URL(a.getAttribute('href'), location.href); } catch (_) { return null; }
  }
  function local(u) { return u && u.protocol === 'https:' && HOSTS.includes(u.hostname); }
  function postId(path) { return path.match(/^\/(?:[\w.]+\/)?(?:p|reel|reels)\/([\w-]+)\/?$/)?.[1] || ''; }
  function profileLink(a) {
    const u = urlOf(a);
    return local(u) && /^\/[\w.]+\/$/.test(u.pathname) &&
      !/^\/(explore|reels|direct|accounts|stories|following|about|legal)\/$/.test(u.pathname);
  }
  function route() {
    const p = location.pathname;
    if (/^\/(accounts|direct|create|challenge|oauth|legal|web|stories)(\/|$)/.test(p)) return 'protected';
    if (/^\/reels\/?$/.test(p)) return 'reels';
    if (postId(p)) return /\/(reel|reels)\//.test(p) ? 'reel' : 'post';
    if (/^\/explore\/?$/.test(p)) return 'explore';
    if (p === '/' || /^\/following\/?$/.test(p)) return 'feed';
    return 'other';
  }
  function matchesInside(root, re, selector = 'svg[aria-label],[aria-label]') {
    return query(selector, root).some(e => re.test(label(e)));
  }
  function leafMatches(root, re) {
    return query('span,div,a,button', root).some(e => !e.children.length && re.test(text(e)));
  }
  function isAvatar(img) { return /profile picture|头像|頭像|大頭貼照|大頭貼/i.test(img.alt || ''); }
  function headerOf(card) {
    // Live 2026 desktop feed has no <header>; the options control, author and
    // timestamp share a small div BEFORE the media. Never classify the caption.
    const more = query('[aria-label]', card).find(e => words.more.test(label(e)));
    if (!more) return null;
    const firstMedia = query('video,img', card).find(e => e.tagName === 'VIDEO' || !isAvatar(e));
    for (let el = more.parentElement; el && el !== card; el = el.parentElement) {
      if (el.querySelector('video') || query('img', el).some(i => !isAvatar(i)) || matchesInside(el, words.like)) return null;
      if (firstMedia && !(el.compareDocumentPosition(firstMedia) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
      if (query('a[href]', el).some(profileLink) &&
          (el.querySelector('time') || query('a[href]', el).some(a => postId(urlOf(a)?.pathname || '')) || el.tagName === 'HEADER' ||
           firstMedia && query('img', el).some(isAvatar) && leafMatches(el, words.ad))) return el;
    }
    return null;
  }
  function navLinks() {
    return query('a[href]').filter(a => !a.closest(`main,[role="main"],article,[role="dialog"],${EDITOR},${OWNED}`));
  }
  function ownProfile() {
    return navLinks().find(a => profileLink(a) &&
      (/^(Profile|个人主页|個人檔案|個人主頁)$/i.test(text(a)) || query('img', a).some(isAvatar)));
  }
  function requestList() {
    pendingList = { until: Date.now() + 10000, from: location.pathname, profile: '', clicked: false };
    listAttempted = true;
    enterFollowing();
  }
  function enterFollowing() {
    if (!settings.followingList) { pendingList = null; return; }
    if (!pendingList && !listAttempted && location.pathname === '/' && !history.state?.pureInsHome && !homeIntent) requestList();
    const task = pendingList;
    if (!task) return;
    if (Date.now() > task.until) { pendingList = null; return; }
    const profile = ownProfile(), path = profile && urlOf(profile).pathname;
    if (!path) return;
    if (task.profile && task.profile !== path || ![task.from, path].includes(location.pathname)) { pendingList = null; return; }
    task.profile = path;
    if (location.pathname !== path) {
      if (!task.clicked) { task.clicked = true; profile.click(); }
      return;
    }
    if (query('[role="dialog"] h1,[role="dialog"] h2').some(e => words.following.test(text(e)))) { pendingList = null; return; }
    const entry = query('main a,main button,[role="main"] a,[role="main"] button').find(e =>
      !e.closest('article,[role="dialog"]') && /^(?:[\d,.万萬]+\s*(?:following|关注|關注|追蹤中)|(?:关注|關注|追蹤中)\s*[\d,.万萬]+)$/i.test(text(e)));
    if (entry) { pendingList = null; entry.click(); }
  }
  function navigation(desired) {
    if (settings.hideHome) for (const a of navLinks()) {
      if (/^(Home|首页|首頁|主页|主頁)$/i.test(label(a)) && urlOf(a)?.pathname === '/') desired.add(a);
    }
    if (!settings.navigation) return;
    for (const a of query('a[href]')) {
      // Profile tabs, authored links, search results and post dialogs are not nav.
      if (a.closest(`main,article,[role="main"],[role="dialog"],[role="tablist"],${EDITOR},${OWNED}`)) continue;
      const u = urlOf(a), name = label(a);
      if (words.search.test(name)) continue; // Current Search points to /explore/.
      if (local(u) && /^\/(reels|explore)\/?$/.test(u.pathname) && /^(Reels|Explore|发现|探索|探索内容|連續短片|短片)$/i.test(name) ||
          /^(Also from Meta|更多 Meta 产品|更多 Meta 產品|Meta 旗下其他產品)$/i.test(name)) desired.add(a);
    }
    for (const e of query('footer a[href],[role="contentinfo"] a[href],nav a[href],[role="navigation"] a[href]')) {
      if (e.closest(`article,[role="dialog"],${EDITOR},${OWNED}`)) continue;
      const u = urlOf(e);
      if (u && (['meta.ai', 'www.meta.ai', 'muse.ai', 'www.threads.com', 'threads.com'].includes(u.hostname) ||
          local(u) && /^\/(popular|accounts\/meta_verified)\/?$/.test(u.pathname))) desired.add(e);
    }
  }
  function reconcileClass(previous, next, name) {
    for (const el of previous) if (!next.has(el)) el.classList.remove(name);
    for (const el of next) if (!el.classList.contains(name)) el.classList.add(name);
    return next;
  }
  function notifications() {
    const roots = new Set(), parts = new Set();
    if (settings.notificationBadges) for (const icon of query('svg[aria-label]')) {
      if (!words.notifications.test(label(icon))) continue;
      const root = icon.closest('a,button,[role="link"],[role="button"]');
      if (!root || root.closest(`main,[role="main"],article,[role="dialog"],${EDITOR},${OWNED}`)) continue;
      roots.add(root);
      const keep = el => { for (; el && el !== root; el = el.parentElement) parts.add(el); };
      keep(icon);
      for (const el of query('*', icon)) parts.add(el);
      for (const el of query('span,div', root)) {
        const ownText = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
        if (words.notifications.test(ownText)) keep(el);
      }
    }
    // Preserve only the icon, label and their ancestor branches. CSS also hides
    // newly inserted badges immediately, without relying on obfuscated classes,
    // badge color, unread counts, or marking any notifications as read.
    quietParts = reconcileClass(quietParts, parts, KEEP);
    quietRoots = reconcileClass(quietRoots, roots, QUIET);
  }
  function cards(page) {
    if (fullScan) {
      for (const card of query('main article,[role="main"] article')) dirtyCards.add(card);
    }
    for (const card of dirtyCards) {
      adCards.delete(card);
      if (!card.isConnected || !settings.ads || ['protected', 'post', 'reel'].includes(page) ||
          card.parentElement.closest('article') || card.closest('[role="dialog"]')) continue;
      const header = headerOf(card); headers.set(card, header);
      if (header && leafMatches(header, words.ad)) adCards.add(card);
    }
    for (const card of adCards) if (!card.isConnected) adCards.delete(card);
    dirtyCards.clear();
  }
  function sidebars() {
    const roots = new Set(query('aside'));
    for (const button of query('main button,main [role="button"],[role="main"] button,[role="main"] [role="button"]')) {
      if (!/^(Switch|切换|切換)$/i.test(text(button)) || button.closest('article,[role="dialog"]')) continue;
      let root = button;
      while (root.parentElement && !root.parentElement.matches('main,[role="main"]') && !root.parentElement.querySelector('article')) root = root.parentElement;
      roots.add(root);
    }
    return [...roots];
  }
  function isModuleSafe(el) {
    return !el.matches('main,body,html,[role="main"]') &&
      !el.querySelector(`article,video,nav,[role="navigation"],[role="tablist"],${EDITOR}`) &&
      !matchesInside(el, words.more) && !matchesInside(el, words.like);
  }
  function modules(desired, page) {
    if (!settings.modules) return;
    const related = /^(More posts from|More from|Related posts|Suggested reels|更多帖子|更多貼文|相关帖子|相關貼文|推荐短视频|推薦連續短片)$/i;
    for (const title of (page === 'feed' ? sidebars() : [document]).flatMap(root => query('h2,h3,h4,span,div', root))) {
      if (title.closest(`article,a,button,[role="button"],[role="dialog"],${EDITOR},${OWNED}`)) continue;
      // The current detail heading is a text node followed by an author <a>.
      if (title.children.length && ![...title.children].every(e => e.matches('a[href]') && profileLink(e))) continue;
      const heading = [...title.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
      const suggest = words.suggested.test(heading), detail = ['post', 'reel'].includes(page) && related.test(heading);
      if (!suggest && !detail) continue;
      for (let el = title.parentElement, depth = 0; el && depth < 6; el = el.parentElement, depth++) {
        if (!isModuleSafe(el)) break;
        const links = query('a[href]', el);
        const follows = query('button,[role="button"]', el).filter(b => words.follow.test(text(b)));
        const grid = links.filter(a => postId(urlOf(a)?.pathname || '') && a.querySelector('img,svg'));
        if (suggest && follows.length && links.filter(profileLink).length >= 2 || detail && grid.length >= 2) {
          desired.add(el); break;
        }
      }
    }
    // "Similar accounts" is an explicit profile recommendation control.
    for (const b of page === 'feed' ? [] : query('main button,main [role="button"]')) {
      if (!b.closest(`article,[role="dialog"],${EDITOR}`) && /^(Similar accounts|类似账户|類似帳號|类似账号|推薦用戶)$/i.test(label(b))) desired.add(b);
    }
  }
  function searchActive() {
    if (['q', 'query', 'search'].some(k => new URL(location.href).searchParams.get(k)?.trim())) return true;
    return query('main input,[role="main"] input').some(e => e.value?.trim() &&
      /search|搜索|搜尋|搜寻/i.test([e.type, e.getAttribute('aria-label'), e.placeholder].join(' ')));
  }
  function explore(desired, page) {
    if (page !== 'explore' || !settings.explore || searchActive()) return;
    // Hide media tiles and their grid wrappers. Do not hide the search container, history,
    // autocomplete, or intentional /explore/tags and /explore/locations pages.
    for (const a of query('main a[href],[role="main"] a[href]')) {
      if (a.closest(`[role="dialog"],article,${EDITOR}`)) continue;
      if (!postId(urlOf(a)?.pathname || '') || !a.querySelector('img,video,svg')) continue;
      let grid = a;
      for (let el = a.parentElement; el && !el.matches('main,[role="main"]'); el = el.parentElement) {
        if (el.querySelector(`input,select,article,[role="dialog"],${EDITOR}`) ||
            query('a[href]', el).some(link => !postId(urlOf(link)?.pathname || ''))) break;
        grid = el;
      }
      desired.add(grid);
    }
  }
  function reelCards(main) {
    const groups = query('[role="group"][aria-label]', main).filter(g => words.player.test(label(g)));
    return groups.map(g => {
      for (let el = g.parentElement; el && el !== main; el = el.parentElement) {
        if (query('[role="group"][aria-label]', el).filter(x => words.player.test(label(x))).length > 1) break;
        const author = query('a[href]', el).some(a => profileLink(a) || local(urlOf(a)) && /^\/[\w.]+\/reels\/$/.test(urlOf(a).pathname));
        // Sharing may be disabled by the author; another interaction still bounds the card.
        if (author && matchesInside(el, words.like) &&
            [words.share, words.comment, words.save].some(rule => matchesInside(el, rule))) return el;
      }
      return null;
    }).filter(Boolean);
  }
  function reelWrapper(el, main) {
    // Hide the empty scroll slot too, but keep target identity on the minimum
    // card. A list containing one item can grow; it must never become the target.
    while (el.parentElement && el.parentElement !== main && el.parentElement.children.length === 1 &&
      ![...el.parentElement.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) el = el.parentElement;
    return el;
  }
  function identityOfReel(el) {
    return query('a[href]', el).map(urlOf).find(u => local(u) && /^\/[\w.]+\/reels\/$/.test(u.pathname))?.pathname ||
      query('a[href]', el).find(profileLink)?.getAttribute('href') || '';
  }
  function showNotice(main, message) {
    let note = document.getElementById(NOTE);
    if (!note) {
      note = document.createElement('section'); note.id = NOTE;
      note.innerHTML = '<p></p><a href="/">返回首页</a>';
    }
    note.querySelector('p').textContent = message;
    if (note.parentElement !== main) main.prepend(note);
  }
  function reels(desired, page) {
    const main = document.querySelector('main,[role="main"]');
    if (!main) { document.getElementById(NOTE)?.remove(); return; }
    const hall = page === 'reels';
    if (!hall && page !== 'reel') { document.getElementById(NOTE)?.remove(); return; }
    const items = reelCards(main);
    if (!settings.reels) {
      document.getElementById(NOTE)?.remove();
      if (settings.ads) for (const el of items) {
        const badge = query('span,div', el).some(e => !e.children.length && words.ad.test(text(e)) && !e.closest('button,[role="button"],a,article'));
        const adLink = query('a[href]', el).some(a => { const u = urlOf(a); return ['www.facebook.com', 'facebook.com'].includes(u?.hostname) && u.pathname === '/ads/ig_redirect/'; });
        if (badge && adLink && (hall || el !== items[0])) desired.add(reelWrapper(el, main));
      }
      return;
    }
    if (hall || reelSession) {
      // Keep blocking a hall session even when native autoplay updates the URL.
      reelSession = true;
      for (const child of main.children) if (child.id !== NOTE && !child.matches('[role="dialog"]') && !child.querySelector('[role="dialog"]')) desired.add(child);
      showNotice(main, '已隐藏 Reels 推荐流。你仍可从个人主页或链接打开具体短视频。');
      return;
    }
    document.getElementById(NOTE)?.remove();
    for (const control of query('[role="toolbar"][aria-label]', main)) if (words.reelNav.test(label(control))) desired.add(control);
    if (!items.length) return; // Classic single-post player: leave its media alone.
    const id = reelAnchor || postId(location.pathname);
    // An exact permalink is preferred; otherwise the visible native first item
    // on entry is the requested video. Retain that element across virtual updates.
    if (!reelTarget) {
      reelTarget = items.find(el => query('a[href]', el).some(a => postId(urlOf(a)?.pathname || '') === id)) ||
        items.find(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top < innerHeight && r.bottom > 0; }) || items[0];
      reelIdentity = identityOfReel(reelTarget);
    }
    const recycled = reelIdentity && identityOfReel(reelTarget) !== reelIdentity;
    for (const el of items) if (el !== reelTarget || recycled) desired.add(reelWrapper(el, main));
    if (!reelTarget.isConnected || recycled) showNotice(main, '当前短视频已结束或离开页面，后续推荐已隐藏。');
  }
  function stopHiddenMedia(root = document) {
    for (const video of (root.matches?.('video') ? [root] : query('video', root))) if (video.closest(`.${HIDDEN}`) && !video.paused) video.pause();
  }
  function injectStyle() {
    if (document.getElementById('pure-ins-style')) return;
    const s = document.createElement('style'); s.id = 'pure-ins-style';
    s.textContent = `.${HIDDEN}{display:none!important}#${UI}{color-scheme:light dark}
      .${QUIET} :not(.${KEEP}){display:none!important}
      .${QUIET}::before,.${QUIET}::after,.${QUIET} *::before,.${QUIET} *::after{content:none!important;display:none!important}
      #${NOTE}{font:15px/1.7 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:24px;border:1px solid #8885;border-radius:16px;color:inherit}#${NOTE} a{color:#517ee8}`;
    document.documentElement.append(s);
  }
  function apply() {
    frame = 0;
    if (stopped || !document.documentElement) return;
    observer?.disconnect();
    try {
      injectStyle(); const page = route();
      if (lastURL !== location.href) {
        fullScan = shellDirty = true;
        if (homeIntent && location.pathname === '/') {
          history.replaceState({ ...history.state, pureInsHome: true }, ''); homeIntent = false;
        }
        if (location.pathname !== '/') listAttempted = false;
        const nextId = postId(location.pathname);
        // Explicit clicks/popstate reset the anchor separately; automatic changes
        // within a reel session must not promote a recommended video to the target.
        if (!['reel', 'reels'].includes(page)) { reelSession = false; reelTarget = null; reelAnchor = ''; reelIdentity = ''; }
        if (!reelAnchor && page === 'reel') reelAnchor = nextId;
        lastURL = location.href;
      }
      if (shellDirty) {
        shellHidden = new Set();
        navigation(shellHidden);
        if (page !== 'protected') { modules(shellHidden, page); explore(shellHidden, page); reels(shellHidden, page); }
        else document.getElementById(NOTE)?.remove();
        notifications();
      }
      cards(page);
      const desired = new Set([...shellHidden, ...adCards].filter(e => e.isConnected));
      for (const el of hidden) if (!desired.has(el)) el.classList.remove(HIDDEN);
      for (const el of desired) if (!hidden.has(el)) { el.classList.add(HIDDEN); stopHiddenMedia(el); }
      hidden = desired;
      fullScan = shellDirty = false;
    } finally { observe(); }
    enterFollowing();
  }
  function schedule(all = true) {
    if (all) fullScan = shellDirty = true;
    if (!frame && !stopped) frame = requestAnimationFrame(apply);
  }
  function observe() {
    if (!stopped && document.documentElement) observer?.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['href', 'aria-label', 'role', 'class', 'alt', 'value', 'aria-current', 'aria-selected']
    });
  }
  function ensureUI() {
    if (ui) { if (!ui.isConnected) document.body.append(ui); return; }
    ui = document.createElement('span'); ui.id = UI;
    const shadow = ui.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font:14px/1.6 system-ui,sans-serif}*{box-sizing:border-box}
      dialog{color:var(--pure-ins-text,#24354b);background:var(--pure-ins-background,#fff);width:min(520px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #8886;border-radius:16px;padding:24px;font:14px/1.6 system-ui,sans-serif;box-shadow:0 20px 80px #0004}
      dialog::backdrop{background:#18202c88}h2{margin:0 0 8px;font-size:22px}p{margin:8px 0 16px}.grid{display:grid;gap:8px}
      label{display:flex;align-items:center;gap:10px;padding:7px;border-radius:6px;background:#8881}input{accent-color:#7651cf;width:16px;height:16px}
      button{font:inherit;color:inherit;background:transparent;border:1px solid #8887;border-radius:8px;padding:7px 13px;cursor:pointer}
      button:focus-visible,input:focus-visible{outline:3px solid #9674e7;outline-offset:2px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.save{margin-left:auto;background:#6840b4;color:#fff}.note{font-size:12px;opacity:.8}.status{min-height:22px}.error{color:#d25536}
      @media(prefers-color-scheme:dark){dialog{color:var(--pure-ins-text,#eee);background:var(--pure-ins-background,#242424)}}
    </style><dialog aria-labelledby="pi-title"><h2 id="pi-title">Pure Ins</h2><p>让关注成为首页，让浏览由你决定。</p>
      <form><div class="grid"></div><p class="note">首页只过滤明确广告，不按关注关系过滤。可见视频使用原生播放；隐藏视频暂停。关注名单不可用时保留当前页面。</p>
      <div class="actions"><button type="button" class="reset">恢复默认</button><button type="button" class="cancel">取消</button><button type="submit" class="save">保存</button></div>
      <p class="status" role="status" aria-live="polite"></p></form></dialog>`;
    dialog = shadow.querySelector('dialog'); status = shadow.querySelector('.status');
    for (const [key, title] of OPTIONS) {
      const row = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.name = key; row.append(input, document.createTextNode(title)); shadow.querySelector('.grid').append(row);
    }
    shadow.querySelector('.cancel').addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    shadow.querySelector('.reset').addEventListener('click', () => { fill(defaults); setStatus('已填入默认选项，保存后生效。'); });
    shadow.querySelector('form').addEventListener('submit', save);
    let outsideDown = false;
    const outside = e => { const r = dialog.getBoundingClientRect(); return e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
    dialog.addEventListener('pointerdown', e => { outsideDown = outside(e); });
    dialog.addEventListener('click', e => { if (outsideDown && outside(e)) dialog.close(); outsideDown = false; });
    dialog.addEventListener('close', () => lastFocus?.focus?.());
    document.body.append(ui);
  }
  function fill(value) { query('input', ui.shadowRoot).forEach(e => { e.checked = value[e.name]; }); }
  function setStatus(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
  function openSettings() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', openSettings, { once: true }); return; }
    ensureUI();
    if (dialog.open) return;
    lastFocus = document.activeElement; fill(settings); setStatus(''); dialog.showModal();
  }
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const next = normalize(Object.fromEntries(query('input', ui.shadowRoot).map(e => [e.name, e.checked])));
    saving = true;
    query('button,input', ui.shadowRoot).forEach(e => { e.disabled = true; });
    try {
      if (typeof GM_setValue !== 'function') throw new Error('Storage unavailable');
      await GM_setValue(KEY, next);
      settings = next; resetReel(); setStatus('已保存；支持的油猴管理器会同步到其他 Instagram 标签页。');
    } catch (_) { setStatus('保存失败，当前规则未改变。请检查油猴存储后重试。', true); }
    finally { saving = false; query('button,input', ui.shadowRoot).forEach(e => { e.disabled = false; }); }
  }
  function start() {
    stopped = false;
    if (!document.documentElement) { document.addEventListener('DOMContentLoaded', start, { once: true }); return; }
    observer ||= new MutationObserver(records => {
      for (const r of records) {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        if (!el || el.closest(`${OWNED},canvas,video,${EDITOR}`)) continue;
        const card = el.closest('article');
        if (card) {
          if (r.type === 'attributes' && r.attributeName === 'class') continue;
          const header = headers.get(card);
          if (!header || !header.isConnected || el === card || header.contains(el) || el.contains(header)) dirtyCards.add(card);
        } else {
          const added = [...r.addedNodes || []].filter(n => n.nodeType === 1);
          for (const node of r.removedNodes || []) if (node.nodeType === 1) {
            if (node.matches('article')) dirtyCards.add(node);
            else for (const card of query('article', node)) dirtyCards.add(card);
          }
          for (const node of added) {
            if (node.matches('article')) dirtyCards.add(node);
            else for (const c of query('article', node)) dirtyCards.add(c);
          }
          if (route() !== 'feed' || !el.closest('main,[role="main"]') ||
              added.some(n => !n.matches('article') && !n.querySelector('article')) ||
              r.type !== 'childList') shellDirty = true;
        }
      }
      if (dirtyCards.size || shellDirty) schedule(false);
      if (pendingList) enterFollowing();
    });
    observe(); schedule(); clearInterval(timer);
    // Sandbox-safe route detection; no interception of Instagram's private APIs.
    timer = setInterval(() => { if (lastURL !== location.href) schedule(); if (pendingList) enterFollowing(); }, 500);
  }
  function resetReel() { reelTarget = null; reelSession = false; reelAnchor = ''; reelIdentity = ''; schedule(); }
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Pure Ins：设置', openSettings);
      GM_registerMenuCommand('Pure Ins：重新应用规则', schedule);
    }
    if (typeof GM_addValueChangeListener === 'function') GM_addValueChangeListener(KEY, (_key, _old, value, remote) => {
      if (!remote) return;
      settings = normalize(value); resetReel();
      if (dialog?.open) setStatus('其他页面已更新设置。当前草稿保留；重开可载入，保存会覆盖为当前选项。');
    });
  } catch (error) { console.warn('[Pure Ins] 菜单或同步不可用', error); }
  document.addEventListener('input', schedule, true);
  document.addEventListener('play', e => {
    if (e.target.matches?.('video') && e.target.closest(`.${HIDDEN}`)) e.target.pause();
  }, true);
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    const u = a && urlOf(a);
    if (e.isTrusted && pendingList) pendingList = null;
    if (a && local(u) && u.pathname === '/' && !a.closest(`main,[role="main"],article,[role="dialog"]`) && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.button === 0) {
      if (label(a) === 'Instagram' && settings.followingList) { e.preventDefault(); e.stopImmediatePropagation(); requestList(); return; }
      if (/^(Home|首页|首頁|主页|主頁)$/i.test(label(a))) {
        pendingList = null; homeIntent = true; listAttempted = true;
        if (location.pathname === '/') { history.replaceState({ ...history.state, pureInsHome: true }, ''); homeIntent = false; }
      }
    }
    if (local(u) && !u.hash && (postId(u.pathname) || /^\/reels\/?$/.test(u.pathname)) && !a.closest(`.${HIDDEN}`)) resetReel();
  }, true);
  window.addEventListener('popstate', resetReel); window.addEventListener('hashchange', schedule);
  window.addEventListener('pagehide', () => { stopped = true; observer?.disconnect(); clearInterval(timer); cancelAnimationFrame(frame); frame = 0; });
  window.addEventListener('pageshow', () => { if (stopped) start(); else schedule(); });
  start();
})();
