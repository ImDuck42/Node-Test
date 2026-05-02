import { createClient, OsosedkiError } from './api/api.mjs';
import { GitHubDB } from './api/github-db.js';

/* ── Config ──────────────────────────────────────────────────────────────── */
const DB_CONFIG = {
  owner:        'ImDuck42',
  repo:         'Node-Test',
  publicTokens: ['ghdb_enc_ICEwKjIqGzImPBtzdgoFcBQOcAN3HRYYAwYjJQAsJisgFyoJCTwIASQQChc+ACwsKCIDdgoLLRAhAwMIMwE3Kn4HdgQ1IRUlCwIMFD0echEVGnEGFyI+GwQCDjQf'],
  basePath:     'data',
  useRaw:       true,
  rawBranches:  ['main', 'master', 'refs/heads/main'],
};

const PROXY_HOSTS    = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const PROXY_TIMEOUT  = 2500;
const TARGET_ORIGIN  = 'https://ososedki.com';

const ICON_HEART_EMPTY  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const ICON_HEART_FILLED = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;

/* ── App ─────────────────────────────────────────────────────────────────── */
class App {
  constructor() {
    this.api = createClient({
      baseUrl:          TARGET_ORIGIN,
      retries:          3,
      retryDelayMs:     500,
      probeConcurrency: 20,
    });

    this.proxyUrl = null;

    // Gallery state
    this.imgList       = [];
    this.imgIndex      = 0;
    this.galleryTitle  = '';

    // Infinite scroll state
    this.listState = { type: null, page: 1, hasMore: false, loading: false, params: {} };
    this.sentinel  = null;
    this.sentinelObs = null;

    this.scrollPos    = new Map();
    this.searchTimer  = null;

    // DOM refs — app
    this.appEl        = document.getElementById('app');
    this.breadcrumbEl = document.getElementById('breadcrumb');
    this.backTopBtn   = document.getElementById('backToTop');
    this.toastWrap    = document.getElementById('toastContainer');

    // DOM refs — lightbox
    this.lbEl      = document.getElementById('lightbox');
    this.lbImg     = document.getElementById('lightboxImg');
    this.lbClose   = document.getElementById('lightboxClose');
    this.lbPrev    = document.getElementById('lightboxPrev');
    this.lbNext    = document.getElementById('lightboxNext');
    this.lbCounter = document.getElementById('lightboxCounter');
    this.lbCopy    = document.getElementById('lightboxCopy');

    // Auth / likes
    this.db         = null;
    this.dbReady    = false;
    this.likes      = new Map();
    this.imgLikes   = new Map();
    this.authBtn    = document.getElementById('authBtn');
    this.profileSort = 'liked-new';
    this.profileTab  = 'galleries';
    this.viewingUser = null;

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.detectProxy();
    await this.initDb();
    this.handleRoute();
    this.initObservers();
  }

  /* ── Database ────────────────────────────────────────────────────────────── */

  async initDb() {
    if (DB_CONFIG.owner.includes('YOUR_')) {
      this.dbReady = false;
      this.syncAuthUI();
      return;
    }
    try {
      this.db = await GitHubDB.public(DB_CONFIG);
      this.db.permissions ({
        imageLikes: { read: 'public', write: 'users' },
        likes:      { read: 'public', write: 'users' },
      })
      await this.db.validateConnection();
      this.dbReady = true;
      if (this.db.auth.isLoggedIn) await this.loadLikes();
      this.syncAuthUI();
    } catch (err) {
      console.error('[DB] Init failed:', err);
      this.dbReady = false;
      this.syncAuthUI();
    }
  }

  async loadLikes() {
    if (!this.db?.auth.isLoggedIn) return;
    const uid = this.db.auth.currentUser.id;
    try {
      const likes    = await this.db.collection('likes').query(r => r.userId === uid);
      const imgLikes = await this.db.collection('imageLikes').query(r => r.userId === uid);
      this.likes    = new Map(likes.map(l => [l.galleryId, l]));
      this.imgLikes = new Map(imgLikes.map(l => [l.imageUrl, l]));
    } catch (err) {
      console.error('Failed to load likes:', err);
    }
  }

  async loadLikesByUsername(username) {
    if (!this.dbReady) return { likes: new Map(), imgLikes: new Map() };
    try {
      const users = await this.db.auth.listUsers();
      const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase());
      if (!user) return { likes: new Map(), imgLikes: new Map() };

      const likes    = await this.db.collection('likes').query(r => r.userId === user.id);
      const imgLikes = await this.db.collection('imageLikes').query(r => r.userId === user.id);
      return {
        likes:    new Map(likes.map(l => [l.galleryId, l])),
        imgLikes: new Map(imgLikes.map(l => [l.imageUrl, l])),
      };
    } catch (err) {
      console.error('Failed to load user likes:', err);
      return { likes: new Map(), imgLikes: new Map() };
    }
  }

  isLikedGallery(id)  { return this.likes.has(id); }
  isLikedImage(url)   { return this.imgLikes.has(url); }

  async toggleGalleryLike(galleryId, meta = {}) {
    if (!this.dbReady) { this.toast('Database not configured', 'warning'); return; }
    if (!this.db.auth.isLoggedIn) { this.setHash('/profile'); return; }

    const uid      = this.db.auth.currentUser.id;
    const likeId   = `like_${uid}_${galleryId}`;
    const existing = this.likes.get(galleryId);

    try {
      if (existing) {
        await this.db.collection('likes').remove(existing.id);
        this.likes.delete(galleryId);
        this.toast('Removed from liked galleries', 'info');
      } else {
        let { images, title = '', thumbnail = '' } = meta;
        if (!images?.length) {
          try {
            const data = await this.api.getGallery(galleryId);
            images    = data.allImageUrls.length ? data.allImageUrls : data.images.map(i => i.url);
            title     = data.meta.title     || title;
            thumbnail = data.meta.thumbnail || images[0] || thumbnail;
          } catch (err) { console.warn('Could not fetch gallery images:', err); }
        }
        const record = { id: likeId, userId: uid, galleryId, title, thumbnail, images: images || [], likedAt: new Date().toISOString() };
        await this.db.collection('likes').upsert(likeId, record);
        this.likes.set(galleryId, record);
        this.toast('Added to liked galleries', 'success');
      }
      this.syncLikeBtns();
      this.updateTabCounts?.();
    } catch (err) {
      this.toast('Failed to update like', 'error');
      console.error(err);
    }
  }

  async toggleImageLike(imgUrl, galleryId = null) {
    if (!this.dbReady) { this.toast('Database not configured', 'warning'); return; }
    if (!this.db.auth.isLoggedIn) { this.setHash('/profile'); return; }

    const uid      = this.db.auth.currentUser.id;
    const likeId   = `imglike_${uid}_${this.hashStr(imgUrl)}`;
    const existing = this.imgLikes.get(imgUrl);

    try {
      if (existing) {
        await this.db.collection('imageLikes').remove(existing.id);
        this.imgLikes.delete(imgUrl);
        this.toast('Unliked image', 'info');
      } else {
        const record = { id: likeId, userId: uid, imageUrl: imgUrl, galleryId, likedAt: new Date().toISOString() };
        await this.db.collection('imageLikes').upsert(likeId, record);
        this.imgLikes.set(imgUrl, record);
        this.toast('Liked image', 'success');
      }
      this.syncLikeBtns();
      this.updateTabCounts?.();
    } catch (err) {
      this.toast('Failed to update like', 'error');
      console.error(err);
    }
  }

  hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return Math.abs(h).toString(36);
  }

  syncLikeBtns() {
    document.querySelectorAll('[data-like-gallery]').forEach(btn => {
      const liked = this.isLikedGallery(btn.dataset.likeGallery);
      btn.innerHTML = liked ? ICON_HEART_FILLED : ICON_HEART_EMPTY;
      btn.classList.toggle('liked', liked);
    });
    document.querySelectorAll('[data-like-image]').forEach(btn => {
      const liked = this.isLikedImage(btn.dataset.likeImage);
      btn.innerHTML = liked ? ICON_HEART_FILLED : ICON_HEART_EMPTY;
      btn.classList.toggle('liked', liked);
    });
  }

  /* ── Proxy ───────────────────────────────────────────────────────────────── */

  async detectProxy() {
    for (const host of PROXY_HOSTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT);
        const res = await fetch(`${host}/proxy?url=${encodeURIComponent(`${TARGET_ORIGIN}/`)}`, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok || res.status === 404) {
          this.proxyUrl = host;
          this.patchFetch();
          return;
        }
      } catch { /* try next */ }
    }
  }

  patchFetch() {
    const orig  = window.fetch;
    const base  = this.proxyUrl;
    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith(TARGET_ORIGIN)) return orig(`${base}/proxy?url=${encodeURIComponent(url)}`, init);
      return orig(input, init);
    };
  }

  proxify(url) {
    if (!this.proxyUrl || !url) return url;
    if (url.startsWith('/')) url = TARGET_ORIGIN + url;
    if (url.startsWith(TARGET_ORIGIN)) return `${this.proxyUrl}/proxy?url=${encodeURIComponent(url)}`;
    return url;
  }

  /* ── Router ──────────────────────────────────────────────────────────────── */

  parseHash() {
    const raw = window.location.hash.slice(1) || '/';
    const [path, qs] = raw.split('?');
    return { path, params: new URLSearchParams(qs || '') };
  }

  setHash(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    window.location.hash = qs ? `${path}?${qs}` : path;
  }

  handleRoute() {
    const { path, params } = this.parseHash();

    this.resetScroll();

    document.querySelectorAll('.site-nav a').forEach(a => a.classList.remove('active'));
    if (path === '/' || path === '/home') {
      document.querySelector('[data-route="home"]')?.classList.add('active');
    } else if (path === '/cosplays') {
      document.querySelector('[data-route="cosplays"]')?.classList.add('active');
    }

    this.syncBreadcrumb(path, params);

    const routes = [
      { re: /^\/$|^\/home$/,     fn: ()  => this.viewHome() },
      { re: /^\/search$/,        fn: ()  => { const q = params.get('q'); return q ? this.viewSearch(q) : this.viewHome(); } },
      { re: /^\/cosplays$/,      fn: ()  => this.viewCosplays() },
      { re: /^\/cosplay\/(.+)$/, fn: m   => this.viewCharacter(decodeURIComponent(m[1])) },
      { re: /^\/model\/(.+)$/,   fn: m   => this.viewModel(decodeURIComponent(m[1])) },
      { re: /^\/fandom\/(.+)$/,  fn: m   => this.viewFandom(decodeURIComponent(m[1])) },
      { re: /^\/gallery\/(.+)$/, fn: m   => this.viewGallery(decodeURIComponent(m[1])) },
      { re: /^\/profile\/(.+)$/, fn: m   => this.viewProfile(decodeURIComponent(m[1])) },
      { re: /^\/profile$/,       fn: ()  => this.viewProfile(null) },
    ];

    const match = routes.find(r => r.re.test(path));
    match ? match.fn(path.match(match.re)) : this.viewHome();
  }

  syncBreadcrumb(path, params) {
    const parts = [{ label: 'Home', href: '#/' }];

    if      (path === '/cosplays')         parts.push({ label: 'Cosplays', current: true });
    else if (path === '/search')           parts.push({ label: `Search: ${params.get('q') || ''}`, current: true });
    else if (path.startsWith('/cosplay/')) { parts.push({ label: 'Cosplays', href: '#/cosplays' }); parts.push({ label: decodeURIComponent(path.split('/')[2] || ''), current: true }); }
    else if (path.startsWith('/model/'))   { parts.push({ label: 'Model', current: true }); parts.push({ label: decodeURIComponent(path.split('/')[2] || ''), current: true }); }
    else if (path.startsWith('/fandom/'))  { parts.push({ label: 'Fandom', current: true }); parts.push({ label: decodeURIComponent(path.split('/')[2] || ''), current: true }); }
    else if (path.startsWith('/gallery/')) parts.push({ label: 'Gallery', current: true });
    else if (path.startsWith('/profile/')) { parts.push({ label: 'Profile', href: '#/profile' }); parts.push({ label: `@${decodeURIComponent(path.split('/')[2] || '')}`, current: true }); }
    else if (path === '/profile')          parts.push({ label: 'Profile', current: true });

    this.breadcrumbEl.innerHTML = parts.map(p =>
      p.current
        ? `<span class="current">${this.esc(p.label)}</span>`
        : `<a href="${p.href}" data-nav>${this.esc(p.label)}</a>`
    ).join('<span class="sep">/</span>');
  }

  /* ── Events ──────────────────────────────────────────────────────────────── */

  bindEvents() {
    window.addEventListener('hashchange', () => this.handleRoute());
    window.addEventListener('scroll', () => {
      this.backTopBtn.classList.toggle('visible', window.scrollY > 600);
    }, { passive: true });

    this.backTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    const searchInput = document.getElementById('searchInput');
    document.getElementById('searchForm').addEventListener('submit', e => {
      e.preventDefault();
      clearTimeout(this.searchTimer);
      const q = searchInput.value.trim();
      if (q) this.setHash('/search', { q, page: 1 });
    });

    this.authBtn.addEventListener('click', () => {
      this.saveScroll();
      window.location.hash = '/profile';
    });

    // App area delegation
    this.appEl.addEventListener('click', e => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        const href = nav.getAttribute('href') || nav.dataset.href;
        if (href) {
          e.preventDefault();
          this.saveScroll();
          window.location.hash = href.startsWith('#') ? href.slice(1) : href;
        }
      }

      const cell = e.target.closest('.image-cell');
      if (cell && !e.target.closest('.img-download-btn') && !e.target.closest('.img-like-btn')) {
        const src = cell.dataset.img;
        const idx = parseInt(cell.dataset.idx, 10);
        if (src && !isNaN(idx)) this.openLightbox(src, idx);
      }

      const dlBtn = e.target.closest('.img-download-btn');
      if (dlBtn) {
        e.stopPropagation();
        const idx = parseInt(dlBtn.closest('.image-cell').dataset.idx, 10);
        const url = this.imgList[idx];
        if (!url) return;
        const ext     = url.split('.').pop().split('?')[0] || 'jpg';
        const safeName = (this.galleryTitle || 'image').replace(/[^a-z0-9]/gi, '_').substring(0, 40);
        this.downloadImg(url, `${safeName}_${String(idx + 1).padStart(3, '0')}.${ext}`);
        return;
      }

      const imgLikeBtn = e.target.closest('.img-like-btn');
      if (imgLikeBtn) {
        e.stopPropagation();
        this.toggleImageLike(imgLikeBtn.dataset.likeImage, imgLikeBtn.dataset.galleryId || null);
        return;
      }

      const cardLikeBtn = e.target.closest('.like-btn');
      if (cardLikeBtn) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleGalleryLike(cardLikeBtn.dataset.likeGallery, {
          title:     cardLikeBtn.dataset.title     || '',
          thumbnail: cardLikeBtn.dataset.thumbnail || '',
        });
        return;
      }

      const bulkBtn = e.target.closest('#bulkDownloadBtn');
      if (bulkBtn) { e.stopPropagation(); this.bulkDownload(); }

      const profileTabBtn = e.target.closest('[data-profile-tab]');
      if (profileTabBtn) {
        e.preventDefault();
        document.querySelectorAll('[data-profile-tab]').forEach(t => t.classList.remove('active'));
        profileTabBtn.classList.add('active');
        this.profileTab = profileTabBtn.dataset.profileTab;
        this.renderProfileTab(this.profileTab);
      }

      const sortSel = e.target.closest('#sortSelect');
      if (sortSel) {
        this.profileSort = sortSel.value;
        this.renderProfileTab(this.profileTab);
      }

      const galleryLikeBtn = e.target.closest('#galleryLikeBtn');
      if (galleryLikeBtn) {
        e.stopPropagation();
        this.toggleGalleryLike(galleryLikeBtn.dataset.likeGallery, { title: galleryLikeBtn.dataset.title || '' });
      }
    });

    // Lightbox
    this.lbClose.addEventListener('click', () => this.closeLightbox());
    this.lbCopy.addEventListener('click',  e => { e.stopPropagation(); this.copyLightboxUrl(); });
    this.lbPrev.addEventListener('click',  e => { e.stopPropagation(); this.prevImg(); });
    this.lbNext.addEventListener('click',  e => { e.stopPropagation(); this.nextImg(); });

    this.lbEl.addEventListener('click', e => {
      if (e.target === this.lbEl || e.target.classList.contains('lightbox-backdrop')) this.closeLightbox();
    });

    document.addEventListener('keydown', e => {
      if (!this.lbEl.classList.contains('active')) return;
      if (e.key === 'Escape')     this.closeLightbox();
      if (e.key === 'ArrowLeft')  this.prevImg();
      if (e.key === 'ArrowRight') this.nextImg();
    });

    let touchStartX = 0;
    this.lbEl.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
    this.lbEl.addEventListener('touchend',   e => {
      const diff = touchStartX - e.changedTouches[0].screenX;
      if (Math.abs(diff) > 50) diff > 0 ? this.nextImg() : this.prevImg();
    }, { passive: true });
  }

  /* ── Auth UI ─────────────────────────────────────────────────────────────── */

  syncAuthUI() {
    if (this.dbReady && this.db.auth.isLoggedIn) {
      this.authBtn.classList.add('logged-in');
      this.authBtn.title = `@${this.db.auth.currentUser.username}`;
    } else {
      this.authBtn.classList.remove('logged-in');
      this.authBtn.title = 'Profile';
    }
  }

  async handleLogin(username, password) {
    const errEl = document.getElementById('authError');
    try {
      await this.db.auth.login(username, password);
      await this.loadLikes();
      this.syncAuthUI();
      this.toast(`Welcome, @${username}!`, 'success');
      this.viewProfile();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Login failed';
    }
  }

  async handleRegister(username, password) {
    const errEl = document.getElementById('regError');
    try {
      await this.db.auth.register(username, password);
      await this.loadLikes();
      this.syncAuthUI();
      this.toast('Account created!', 'success');
      this.viewProfile();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Registration failed';
    }
  }

  handleLogout() {
    this.db.auth.logout();
    this.likes.clear();
    this.imgLikes.clear();
    this.syncAuthUI();
    this.toast('Logged out', 'info');
    this.viewProfile();
  }

  /* ── Observers ───────────────────────────────────────────────────────────── */

  initObservers() {
    const fadeObs = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (!entry.isIntersecting) return;
        setTimeout(() => {
          entry.target.style.animationDelay = '0s';
          entry.target.classList.add('fade-in');
        }, i * 50);
        fadeObs.unobserve(entry.target);
      });
    }, { threshold: 0.05, rootMargin: '50px' });

    new MutationObserver(() => {
      this.appEl.querySelectorAll('.card, .image-cell').forEach(el => {
        if (!el.classList.contains('fade-in')) fadeObs.observe(el);
      });
    }).observe(this.appEl, { childList: true, subtree: true });
  }

  /* ── Scroll ──────────────────────────────────────────────────────────────── */

  saveScroll() {
    const { path } = this.parseHash();
    this.scrollPos.set(path, window.scrollY);
  }

  restoreScroll() {
    const { path } = this.parseHash();
    const saved = this.scrollPos.get(path);
    if (saved != null) {
      setTimeout(() => window.scrollTo({ top: saved, behavior: 'instant' }), 0);
      this.scrollPos.delete(path);
    }
  }

  /* ── Infinite Scroll ─────────────────────────────────────────────────────── */

  resetScroll() {
    this.sentinelObs?.disconnect();
    this.sentinelObs = null;
    this.sentinel?.remove();
    this.sentinel  = null;
    this.listState = { type: null, page: 1, hasMore: false, loading: false, params: {} };
  }

  setupInfiniteScroll() {
    this.sentinel?.remove();
    this.sentinel = document.createElement('div');
    this.sentinel.className = 'load-sentinel';
    this.sentinel.innerHTML = '<div class="sentinel-spinner"></div><span>Loading more...</span>';
    this.appEl.appendChild(this.sentinel);

    this.sentinelObs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && this.listState.hasMore && !this.listState.loading) this.loadMore();
    }, { rootMargin: '400px' });

    this.sentinelObs.observe(this.sentinel);
  }

  setSentinelLoading() {
    if (!this.sentinel) return;
    this.sentinel.innerHTML = '<div class="sentinel-spinner"></div><span>Loading more...</span>';
    this.sentinel.classList.remove('end', 'error');
  }

  setSentinelEnd() {
    if (!this.sentinel) return;
    this.sentinel.innerHTML = '<span>You\'ve reached the end</span>';
    this.sentinel.classList.add('end');
  }

  setSentinelError() {
    if (!this.sentinel) return;
    this.sentinelObs?.disconnect();
    this.sentinel.classList.add('error');
    this.sentinel.innerHTML = `
      <span style="color:var(--danger)">Failed to load more</span>
      <button class="btn btn-sm" id="sentinelRetry" style="margin-left:.75rem">Retry</button>`;
    this.sentinel.querySelector('#sentinelRetry')?.addEventListener('click', () => {
      this.sentinel.classList.remove('error');
      this.sentinelObs?.observe(this.sentinel);
      this.loadMore();
    }, { once: true });
  }

  async loadMore() {
    if (!this.listState.hasMore || this.listState.loading) return;
    this.listState.loading = true;
    this.setSentinelLoading();

    const nextPage = this.listState.page + 1;
    let itemsHtml  = '';
    let hasMore    = false;

    try {
      switch (this.listState.type) {
        case 'home': {
          const data = await this.api.getHome(nextPage);
          hasMore = data.pagination.hasMore;
          itemsHtml = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'search': {
          const data = await this.api.search(this.listState.params.q, nextPage);
          hasMore = data.pagination.hasMore;
          itemsHtml = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'cosplays': {
          const data = await this.api.getCosplayCharacters(nextPage);
          hasMore = data.pagination.hasMore;
          itemsHtml = data.characters.map((c, i) => this.charCard(c, i)).join('');
          break;
        }
        case 'character': {
          const data = await this.api.getCharacter(this.listState.params.name, nextPage);
          hasMore = data.pagination.hasMore;
          itemsHtml = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'model': {
          const data = await this.api.getModel(this.listState.params.name, nextPage);
          hasMore = data.pagination.hasMore;
          itemsHtml = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'fandom': {
          const data = await this.api.getFandom(this.listState.params.name, nextPage);
          hasMore = data.pagination.hasMore;
          itemsHtml = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
      }

      this.listState.page    = nextPage;
      this.listState.hasMore = hasMore;

      const grid = this.appEl.querySelector('.grid');
      if (grid && itemsHtml) {
        const tmp = document.createElement('div');
        tmp.innerHTML = itemsHtml;
        for (const node of tmp.children) {
          node.style.animationDelay = '0s';
          node.classList.add('fade-in');
          grid.appendChild(node);
        }
      }

      if (!hasMore) { this.setSentinelEnd(); this.sentinelObs?.disconnect(); }
    } catch (err) {
      console.error(err);
      this.setSentinelError();
      this.toast('Failed to load more content', 'error');
    } finally {
      this.listState.loading = false;
    }
  }

  /* ── Lightbox ────────────────────────────────────────────────────────────── */

  openLightbox(src, idx = 0) {
    this.imgIndex = idx;
    this.lbImg.src = src;
    this.lbEl.classList.add('active');
    document.body.style.overflow = 'hidden';
    this.syncLightbox();
    this.preload(idx, 2);
    setTimeout(() => this.lbEl.focus(), 50);
  }

  closeLightbox() {
    this.lbEl.classList.remove('active');
    this.lbImg.src = '';
    document.body.style.overflow = '';
  }

  prevImg() {
    if (this.imgList.length <= 1) return;
    this.imgIndex = (this.imgIndex - 1 + this.imgList.length) % this.imgList.length;
    this.lbImg.style.opacity = '0.7';
    setTimeout(() => { this.lbImg.src = this.imgList[this.imgIndex]; this.lbImg.style.opacity = '1'; }, 100);
    this.syncLightbox();
    this.preload(this.imgIndex, 2);
  }

  nextImg() {
    if (this.imgList.length <= 1) return;
    this.imgIndex = (this.imgIndex + 1) % this.imgList.length;
    this.lbImg.style.opacity = '0.7';
    setTimeout(() => { this.lbImg.src = this.imgList[this.imgIndex]; this.lbImg.style.opacity = '1'; }, 100);
    this.syncLightbox();
    this.preload(this.imgIndex, 2);
  }

  syncLightbox() {
    const total = this.imgList.length;
    this.lbCounter.textContent = `${this.imgIndex + 1} / ${total}`;
    this.lbPrev.classList.toggle('hidden', total <= 1);
    this.lbNext.classList.toggle('hidden', total <= 1);
  }

  async copyLightboxUrl() {
    const url = this.imgList[this.imgIndex];
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Image URL copied!', 'success');
    } catch {
      this.toast('Failed to copy URL', 'error');
    }
  }

  preload(centerIdx, radius) {
    for (let i = -radius; i <= radius; i++) {
      const idx = (centerIdx + i + this.imgList.length) % this.imgList.length;
      if (idx !== centerIdx) new Image().src = this.imgList[idx];
    }
  }

  /* ── Download ────────────────────────────────────────────────────────────── */

  async downloadImg(url, filename, silent = false) {
    try {
      const res     = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob    = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a       = Object.assign(document.createElement('a'), { href: blobUrl, download: filename });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      if (!silent) this.toast(`Downloaded ${filename}`, 'success');
      return true;
    } catch (err) {
      console.error(err);
      if (!silent) this.toast('Download failed', 'error');
      return false;
    }
  }

  async bulkDownload() {
    const btn = document.getElementById('bulkDownloadBtn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const origHTML = btn.innerHTML;
    const total    = this.imgList.length;
    const safeName = (this.galleryTitle || 'gallery').replace(/[^a-z0-9]/gi, '_').substring(0, 40);
    let failed     = 0;

    for (let i = 0; i < total; i++) {
      btn.innerHTML = `<span class="dl-spinner"></span> Downloading ${i + 1}/${total}…`;
      const url     = this.imgList[i];
      const ext     = url.split('.').pop().split('?')[0] || 'jpg';
      const ok      = await this.downloadImg(url, `${safeName}_${String(i + 1).padStart(3, '0')}.${ext}`, true);
      if (!ok) failed++;
      if (i < total - 1) await new Promise(r => setTimeout(r, 400));
    }

    btn.innerHTML = origHTML;
    btn.disabled  = false;
    this.toast(
      failed ? `Downloaded ${total - failed}/${total} images` : `All ${total} images downloaded`,
      failed ? 'warning' : 'success',
    );
  }

  /* ── Views ───────────────────────────────────────────────────────────────── */

  async viewHome() {
    this.renderSkel();
    try {
      const data = await this.api.getHome(1);
      this.listState = { type: 'home', page: 1, hasMore: data.pagination.hasMore, loading: false, params: {} };
      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums found.</div>';
      this.render(`<div class="page-header"><h1>Home</h1></div><div class="grid">${albums}</div>`);
      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (err) { this.renderErr(err); }
  }

  async viewSearch(query) {
    this.renderSkel();
    try {
      const data = await this.api.search(query, 1);
      this.listState = { type: 'search', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { q: query } };
      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No results found.</div>';
      this.render(`
        <div class="page-header">
          <h1>Search: "${this.esc(query)}"</h1>
          ${data.totalResults != null ? `<p>${data.totalResults} results</p>` : ''}
        </div>
        <div class="grid">${albums}</div>
      `);
      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (err) { this.renderErr(err); }
  }

  async viewCosplays() {
    this.renderSkel();
    try {
      const data = await this.api.getCosplayCharacters(1);
      this.listState = { type: 'cosplays', page: 1, hasMore: data.pagination.hasMore, loading: false, params: {} };
      const chars = data.characters.length
        ? data.characters.map((c, i) => this.charCard(c, i)).join('')
        : '<div class="empty">No characters found.</div>';
      this.render(`
        <div class="page-header">
          <h1>Cosplay Characters</h1>
          ${data.totalCharacters != null ? `<p>${data.totalCharacters} characters</p>` : ''}
        </div>
        <div class="grid char-grid">${chars}</div>
      `);
      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (err) { this.renderErr(err); }
  }

  async viewCharacter(name) {
    this.renderSkel();
    try {
      const data = await this.api.getCharacter(name, 1);
      this.listState = { type: 'character', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { name } };
      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums for this character.</div>';
      this.render(`
        <div class="page-header">
          <h1>${this.esc(data.character.name)}</h1>
          <p>${data.character.albumCount} albums</p>
        </div>
        <div class="grid">${albums}</div>
      `);
      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (err) { this.renderErr(err); }
  }

  async viewModel(name) {
    this.renderSkel();
    try {
      const data = await this.api.getModel(name, 1);
      this.listState = { type: 'model', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { name } };
      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums for this model.</div>';
      this.render(`
        <div class="page-header">
          <h1>Model: ${this.esc(data.model.name)}</h1>
          <p>${data.model.albumCount} albums</p>
        </div>
        <div class="grid">${albums}</div>
      `);
      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (err) { this.renderErr(err); }
  }

  async viewFandom(name) {
    this.renderSkel();
    try {
      const data = await this.api.getFandom(name, 1);
      this.listState = { type: 'fandom', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { name } };
      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums for this fandom.</div>';
      this.render(`
        <div class="page-header">
          <h1>Fandom: ${this.esc(data.fandom.name)}</h1>
          <p>${data.fandom.albumCount} albums</p>
        </div>
        <div class="grid">${albums}</div>
      `);
      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (err) { this.renderErr(err); }
  }

  async viewGallery(id) {
    this.renderLoad();
    try {
      const data   = await this.api.getGallery(id);
      const meta   = data.meta;
      const images = data.allImageUrls.length ? data.allImageUrls : data.images.map(i => i.url);

      this.galleryTitle = meta.title;
      this.imgList      = images.map(url => this.proxify(url));
      this.imgIndex     = 0;

      const tags = [];
      if (meta.model)     tags.push(`<a href="#/model/${encodeURIComponent(meta.model.name)}" class="tag model" data-nav>${this.esc(meta.model.name)}</a>`);
      if (meta.character) tags.push(`<a href="#/cosplay/${encodeURIComponent(meta.character.name)}" class="tag" data-nav>${this.esc(meta.character.name)}</a>`);
      if (meta.fandom)    tags.push(`<a href="#/fandom/${encodeURIComponent(meta.fandom.name)}" class="tag fandom" data-nav>${this.esc(meta.fandom.name)}</a>`);

      const liked = this.isLikedGallery(id);
      const galleryLikeBtn = this.dbReady && this.db.auth.isLoggedIn
        ? `<button class="bulk-download-btn" id="galleryLikeBtn" data-like-gallery="${this.esc(id)}" data-title="${this.esc(meta.title)}" style="border-color:${liked ? 'var(--red)' : ''};color:${liked ? 'var(--red)' : ''}">${liked ? ICON_HEART_FILLED : ICON_HEART_EMPTY} ${liked ? 'Liked' : 'Like Gallery'}</button>`
        : '';

      const imagesHtml = images.length
        ? images.map((url, idx) => {
            const proxied  = this.proxify(url);
            const imgLiked = this.isLikedImage(url);
            const likeBtn  = this.dbReady && this.db.auth.isLoggedIn
              ? `<button class="img-like-btn ${imgLiked ? 'liked' : ''}" data-like-image="${this.esc(url)}" data-gallery-id="${this.esc(id)}" title="Like image">${imgLiked ? ICON_HEART_FILLED : ICON_HEART_EMPTY}</button>`
              : '';
            return `
              <div class="image-cell" data-img="${this.esc(proxied)}" data-idx="${idx}">
                <img src="${this.esc(proxied)}" alt="${idx + 1}" loading="lazy">
                ${likeBtn}
                <button class="img-download-btn" title="Download image" aria-label="Download image">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
              </div>`;
          }).join('')
        : '<div class="empty">No images found.</div>';

      this.render(`
        <div class="gallery-meta">
          <h1>${this.esc(meta.title)}</h1>
          ${meta.description ? `<p class="desc">${this.esc(meta.description)}</p>` : ''}
          <div class="gallery-meta-row">
            <div class="tags">${tags.join('')}</div>
            <div class="gallery-actions">
              ${galleryLikeBtn}
              <button class="bulk-download-btn" id="bulkDownloadBtn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Download All
              </button>
            </div>
          </div>
        </div>
        <div class="image-grid masonry">${imagesHtml}</div>
      `);

      this.preload(0, 3);
    } catch (err) { this.renderErr(err); }
  }

  /* ── Profile View ────────────────────────────────────────────────────────── */

  async viewProfile(username = null) {
    this.viewingUser = username;

    if (!this.dbReady) {
      this.renderErr(new Error('Database not configured. Set up GitHubDB in app.js to use profiles.'));
      return;
    }

    let user         = null;
    let isOwn        = false;
    let profileLikes = new Map();
    let profileImgLikes = new Map();

    if (username) {
      try {
        const users = await this.db.auth.listUsers();
        user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
        if (!user) {
          this.render(`
            <div class="page-header"><h1>Profile</h1></div>
            <div class="empty"><p>User <strong>@${this.esc(username)}</strong> not found.</p></div>
          `);
          return;
        }
        const data = await this.loadLikesByUsername(username);
        profileLikes    = data.likes;
        profileImgLikes = data.imgLikes;
      } catch (err) { this.renderErr(err); return; }
    } else {
      if (!this.db.auth.isLoggedIn) {
        this.render(`
          <div class="page-header"><h1>Profile</h1></div>
          <div class="profile-auth">
            <div class="auth-forms-grid">
              <form class="auth-form" id="loginForm">
                <h3>Log In</h3>
                <input type="text" name="username" placeholder="Username" required autocomplete="username">
                <input type="password" name="password" placeholder="Password" required autocomplete="current-password">
                <button type="submit" class="btn">Log In</button>
                <div class="auth-error" id="authError"></div>
              </form>
              <form class="auth-form" id="registerForm">
                <h3>Create Account</h3>
                <input type="text" name="username" placeholder="Username" required autocomplete="username">
                <input type="password" name="password" placeholder="Password" required autocomplete="new-password">
                <input type="password" name="confirm" placeholder="Confirm Password" required autocomplete="new-password">
                <button type="submit" class="btn">Create Account</button>
                <div class="auth-error" id="regError"></div>
              </form>
            </div>
          </div>
        `);
        
        document.getElementById('loginForm')?.addEventListener('submit', e => {
          e.preventDefault();
          const fd = new FormData(e.target);
          this.handleLogin(fd.get('username'), fd.get('password'));
        });
        
        document.getElementById('registerForm')?.addEventListener('submit', e => {
          e.preventDefault();
          const fd = new FormData(e.target);
          if (fd.get('password') !== fd.get('confirm')) {
            const el = document.getElementById('regError');
            if (el) el.textContent = 'Passwords do not match';
            return;
          }
          this.handleRegister(fd.get('username'), fd.get('password'));
        });
        return;
      }
      user  = this.db.auth.currentUser;
      isOwn = true;
      await this.loadLikes();
      profileLikes    = this.likes;
      profileImgLikes = this.imgLikes;
    }

    this.render(`
      <div class="page-header">
        <h1>@${this.esc(user.username)}${isOwn ? ' <span style="font-size:0.6em;color:var(--txt-3)">(you)</span>' : ''}</h1>
        ${isOwn ? `<button class="btn secondary" id="logoutBtn">Log Out</button>` : ''}
      </div>
      <div class="profile-tabs">
        <button class="profile-tab ${this.profileTab === 'galleries' ? 'active' : ''}" data-profile-tab="galleries">
          Liked Galleries <span class="tab-count" id="tabCountGalleries">${profileLikes.size}</span>
        </button>
        <button class="profile-tab ${this.profileTab === 'images' ? 'active' : ''}" data-profile-tab="images">
          Liked Images <span class="tab-count" id="tabCountImages">${profileImgLikes.size}</span>
        </button>
        <button class="profile-tab ${this.profileTab === 'all' ? 'active' : ''}" data-profile-tab="all">All Images</button>
      </div>
      <div class="profile-sort" id="profileSortBar">
        <label>Sort by</label>
        <select id="sortSelect">
          <option value="liked-new"  ${this.profileSort === 'liked-new'  ? 'selected' : ''}>Date Liked (Newest)</option>
          <option value="liked-old"  ${this.profileSort === 'liked-old'  ? 'selected' : ''}>Date Liked (Oldest)</option>
          <option value="alpha-asc"  ${this.profileSort === 'alpha-asc'  ? 'selected' : ''}>Title A-Z</option>
          <option value="alpha-desc" ${this.profileSort === 'alpha-desc' ? 'selected' : ''}>Title Z-A</option>
          <option value="random"     ${this.profileSort === 'random'     ? 'selected' : ''}>Random</option>
        </select>
      </div>
      <div class="profile-content" id="profileContent"></div>
    `);

    if (isOwn) {
      document.getElementById('logoutBtn')?.addEventListener('click', () => this.handleLogout());
    }

    this.updateTabCounts = () => {
      const g = document.getElementById('tabCountGalleries');
      const i = document.getElementById('tabCountImages');
      if (g) g.textContent = profileLikes.size;
      if (i) i.textContent = profileImgLikes.size;
    };

    this.profileData = { profileLikes, profileImgLikes, user, isOwn };
    this.renderProfileTab(this.profileTab);
  }

  renderProfileTab(tab) {
    const container = document.getElementById('profileContent');
    if (!container) return;
    const sort = document.getElementById('sortSelect')?.value || this.profileSort;
    this.profileSort = sort;

    const { profileLikes, profileImgLikes } = this.profileData || { profileLikes: new Map(), profileImgLikes: new Map() };

    if (tab === 'galleries') {
      const items  = Array.from(profileLikes.values());
      const sorted = this.sortItems(items, sort);
      if (!sorted.length) { container.innerHTML = '<div class="profile-empty">No liked galleries yet.</div>'; return; }
      const cards = sorted.map((like, i) => this.albumCard({ id: like.galleryId, title: like.title, thumbnail: like.thumbnail, modelName: '', imageCount: like.images?.length || 0, isNew: false }, i)).join('');
      container.innerHTML = `<div class="grid">${cards}</div>`;

    } else if (tab === 'images') {
      const items  = Array.from(profileImgLikes.values());
      const sorted = this.sortItems(items, sort);
      if (!sorted.length) { container.innerHTML = '<div class="profile-empty">No liked images yet.</div>'; return; }
      const normalized = sorted.map(l => ({ ...l, url: l.imageUrl }));
      this.imgList = normalized.map(i => this.proxify(i.url));
      container.innerHTML = `<div class="image-grid masonry">${this.renderImgGrid(normalized)}</div>`;

    } else if (tab === 'all') {
      const allImgs = [];
      profileLikes.forEach(like => {
        (like.images || []).forEach((url, idx) => allImgs.push({ url, title: like.title || `Image ${idx + 1}`, galleryId: like.galleryId, likedAt: like.likedAt }));
      });
      profileImgLikes.forEach(like => {
        const filename = like.imageUrl.split('/').pop().split('?')[0] || 'Image';
        allImgs.push({ url: like.imageUrl, title: filename, galleryId: like.galleryId, likedAt: like.likedAt });
      });
      const seen   = new Set();
      const unique = allImgs.filter(img => { if (seen.has(img.url)) return false; seen.add(img.url); return true; });
      const sorted = this.sortItems(unique, sort);
      if (!sorted.length) { container.innerHTML = '<div class="profile-empty">No liked images yet.</div>'; return; }
      this.imgList = sorted.map(i => this.proxify(i.url));
      container.innerHTML = `<div class="image-grid masonry">${this.renderImgGrid(sorted, true)}</div>`;
    }
  }

  renderImgGrid(items, showTitle = false) {
    return items.map((item, idx) => {
      const url   = this.proxify(item.url);
      const label = showTitle ? this.esc(item.title) : String(idx + 1);
      return `<div class="image-cell" data-img="${this.esc(url)}" data-idx="${idx}"><img src="${this.esc(url)}" alt="${label}" loading="lazy"></div>`;
    }).join('');
  }

  sortItems(items, sort) {
    const arr = [...items];
    switch (sort) {
      case 'liked-new':  arr.sort((a, b) => new Date(b.likedAt) - new Date(a.likedAt)); break;
      case 'liked-old':  arr.sort((a, b) => new Date(a.likedAt) - new Date(b.likedAt)); break;
      case 'alpha-asc':  arr.sort((a, b) => (a.title || a.imageUrl || '').toLowerCase().localeCompare((b.title || b.imageUrl || '').toLowerCase())); break;
      case 'alpha-desc': arr.sort((a, b) => (b.title || b.imageUrl || '').toLowerCase().localeCompare((a.title || a.imageUrl || '').toLowerCase())); break;
      case 'random':     arr.sort(() => Math.random() - 0.5); break;
    }
    return arr;
  }

  /* ── Render Helpers ──────────────────────────────────────────────────────── */

  render(html) {
    this.appEl.innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderLoad() {
    this.render(`<div class="loading"><div class="spinner"></div><p>Loading content...</p></div>`);
  }

  renderSkel(count = 12) {
    const cards = Array.from({ length: count }, () => `
      <div class="card skeleton-card">
        <div class="thumb-wrap skeleton"></div>
        <div class="info">
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-meta"></div>
        </div>
      </div>`).join('');
    this.appEl.innerHTML = `<div class="page-header"><h1>Loading...</h1></div><div class="grid">${cards}</div>`;
  }

  renderErr(err) {
    const msg = err instanceof OsosedkiError ? `${err.message} (${err.status})` : err.message || String(err);
    this.render(`
      <div class="error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>
        </svg>
        <h2>Something went wrong</h2>
        <p>${this.esc(msg)}</p>
        ${err.stack ? `<pre>${this.esc(err.stack)}</pre>` : ''}
        <button class="btn" style="margin-top:1rem" onclick="window.location.reload()">Retry</button>
      </div>
    `);
  }

  /* ── Components ──────────────────────────────────────────────────────────── */

  albumCard(a, idx = 0) {
    const thumb  = this.proxify(a.thumbnail);
    const liked  = this.isLikedGallery(a.id);
    const likeBtn = this.dbReady && this.db.auth.isLoggedIn
      ? `<button class="like-btn ${liked ? 'liked' : ''}" data-like-gallery="${this.esc(a.id)}" data-title="${this.esc(a.title)}" data-thumbnail="${this.esc(a.thumbnail || '')}" title="${liked ? 'Unlike' : 'Like'} gallery">${liked ? ICON_HEART_FILLED : ICON_HEART_EMPTY}</button>`
      : '';
    return `
      <div class="card" data-nav data-href="#/gallery/${encodeURIComponent(a.id)}" style="animation-delay:${idx * 0.05}s">
        <div class="thumb-wrap">
          ${thumb ? `<img src="${this.esc(thumb)}" alt="" loading="lazy">` : ''}
          ${a.isNew ? '<span class="badge new">New</span>' : ''}
          ${likeBtn}
        </div>
        <div class="info">
          <div class="title">${this.esc(a.title)}</div>
          <div class="meta">
            <span>${this.esc(a.modelName)}</span>
            <span>${a.imageCount} photos</span>
          </div>
        </div>
      </div>`;
  }

  charCard(c, idx = 0) {
    return `
      <a href="#/cosplay/${encodeURIComponent(c.name)}" class="card char-card" data-nav style="animation-delay:${idx * 0.05}s">
        <div class="name">${this.esc(c.name)}</div>
        ${c.fandom     ? `<div class="fandom">${this.esc(c.fandom)}</div>`         : ''}
        ${c.albumCount != null ? `<div class="count">${c.albumCount} albums</div>` : ''}
      </a>`;
  }

  /* ── Utilities ───────────────────────────────────────────────────────────── */

  esc(str) {
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  toast(msg, type = 'info', duration = 3000) {
    const el = document.createElement('div');
    el.className  = `toast ${type}`;
    el.textContent = msg;
    this.toastWrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-out');
      el.addEventListener('animationend', () => el.remove());
    }, duration);
  }
}

new App();