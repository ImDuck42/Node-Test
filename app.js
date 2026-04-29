import { createClient, OsosedkiError } from './api.mjs';

const PROXY_HOSTS         = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const PROXY_CHECK_TIMEOUT = 2500;
const TARGET_ORIGIN       = 'https://ososedki.com';

class App {
  constructor() {
    this.api = createClient({
      baseUrl:          TARGET_ORIGIN,
      retries:          3,
      retryDelayMs:     500,
      probeConcurrency: 20,
    });

    this.proxyUrl = null;

    this.galleryImages       = [];
    this.currentImageIndex   = 0;
    this.currentGalleryTitle = '';

    this.listState        = { type: null, page: 1, hasMore: false, loading: false, params: {} };
    this.sentinel         = null;
    this.sentinelObserver = null;

    this.scrollPositions    = new Map();
    this.searchDebounceTimer = null;

    this.appEl          = document.getElementById('app');
    this.breadcrumbEl   = document.getElementById('breadcrumb');
    this.backToTop      = document.getElementById('backToTop');
    this.toastContainer = document.getElementById('toastContainer');

    this.lightbox        = document.getElementById('lightbox');
    this.lightboxImg     = document.getElementById('lightboxImg');
    this.lightboxClose   = document.getElementById('lightboxClose');
    this.lightboxPrev    = document.getElementById('lightboxPrev');
    this.lightboxNext    = document.getElementById('lightboxNext');
    this.lightboxCounter = document.getElementById('lightboxCounter');
    this.lightboxCopy    = document.getElementById('lightboxCopy');

    this.init();
  }

  async init() {
    this.bindEvents();
    await this.detectProxy();
    this.handleRoute();
    this.initObservers();
  }

  /* ─── Proxy ──────────────────────────────────────────────────────────────── */

  async detectProxy() {
    for (const host of PROXY_HOSTS) {
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), PROXY_CHECK_TIMEOUT);
        const testUrl = `${host}/proxy?url=${encodeURIComponent(`${TARGET_ORIGIN}/`)}`;
        const res   = await fetch(testUrl, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(timer);

        if (res.ok || res.status === 404) {
          this.proxyUrl = host;
          this.patchFetch();
          console.log(`[Proxy] Connected via ${host}`);
          return;
        }
      } catch {
        // try next host
      }
    }
    console.log('[Proxy] No proxy detected — run `node proxy.js` then refresh.');
  }

  patchFetch() {
    const originalFetch = window.fetch;
    const proxyBase     = this.proxyUrl;

    window.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith(TARGET_ORIGIN)) {
        return originalFetch(`${proxyBase}/proxy?url=${encodeURIComponent(url)}`, init);
      }
      return originalFetch(input, init);
    };
  }

  proxify(url) {
    if (!this.proxyUrl || !url) return url;
    if (url.startsWith('/')) url = TARGET_ORIGIN + url;
    if (url.startsWith(TARGET_ORIGIN)) {
      return `${this.proxyUrl}/proxy?url=${encodeURIComponent(url)}`;
    }
    return url;
  }

  /* ─── Router ─────────────────────────────────────────────────────────────── */

  parseHash() {
    const raw        = window.location.hash.slice(1) || '/';
    const [path, qs] = raw.split('?');
    return { path, params: new URLSearchParams(qs || '') };
  }

  setHash(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    window.location.hash = qs ? `${path}?${qs}` : path;
  }

  handleRoute() {
    const { path, params } = this.parseHash();

    this.resetInfiniteScroll();

    document.querySelectorAll('.site-nav a').forEach(a => a.classList.remove('active'));
    if (path === '/' || path === '/home') {
      document.querySelector('[data-route="home"]')?.classList.add('active');
    } else if (path === '/cosplays') {
      document.querySelector('[data-route="cosplays"]')?.classList.add('active');
    }

    this.updateBreadcrumb(path, params);

    const routes = [
      { match: /^\/$|^\/home$/,      handler: ()  => this.homeView() },
      { match: /^\/search$/,         handler: ()  => {
        const q = params.get('q');
        return q ? this.searchView(q) : this.homeView();
      }},
      { match: /^\/cosplays$/,       handler: ()  => this.cosplaysView() },
      { match: /^\/cosplay\/(.+)$/,  handler: m   => this.characterView(decodeURIComponent(m[1])) },
      { match: /^\/model\/(.+)$/,    handler: m   => this.modelView(decodeURIComponent(m[1])) },
      { match: /^\/fandom\/(.+)$/,   handler: m   => this.fandomView(decodeURIComponent(m[1])) },
      { match: /^\/gallery\/(.+)$/,  handler: m   => this.galleryView(decodeURIComponent(m[1])) },
    ];

    const route = routes.find(r => r.match.test(path));
    if (route) {
      route.handler(path.match(route.match));
    } else {
      this.homeView();
    }
  }

  updateBreadcrumb(path, params) {
    const parts = [{ label: 'Home', href: '#/' }];

    if (path === '/cosplays') {
      parts.push({ label: 'Cosplays', current: true });
    } else if (path === '/search') {
      parts.push({ label: `Search: ${params.get('q') || ''}`, current: true });
    } else if (path.startsWith('/cosplay/')) {
      parts.push({ label: 'Cosplays', href: '#/cosplays' });
      parts.push({ label: decodeURIComponent(path.split('/')[2] || ''), current: true });
    } else if (path.startsWith('/model/')) {
      parts.push({ label: 'Model', current: true });
      parts.push({ label: decodeURIComponent(path.split('/')[2] || ''), current: true });
    } else if (path.startsWith('/fandom/')) {
      parts.push({ label: 'Fandom', current: true });
      parts.push({ label: decodeURIComponent(path.split('/')[2] || ''), current: true });
    } else if (path.startsWith('/gallery/')) {
      parts.push({ label: 'Gallery', current: true });
    }

    this.breadcrumbEl.innerHTML = parts.map(p =>
      p.current
        ? `<span class="current">${this.escapeHtml(p.label)}</span>`
        : `<a href="${p.href}" data-nav>${this.escapeHtml(p.label)}</a>`
    ).join('<span class="sep">/</span>');
  }

  /* ─── Events ─────────────────────────────────────────────────────────────── */

  bindEvents() {
    window.addEventListener('hashchange', () => this.handleRoute());

    window.addEventListener('scroll', () => {
      this.backToTop.classList.toggle('visible', window.scrollY > 600);
    }, { passive: true });

    this.backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const searchInput = document.getElementById('searchInput');

    document.getElementById('searchForm').addEventListener('submit', e => {
      e.preventDefault();
      clearTimeout(this.searchDebounceTimer);
      const q = searchInput.value.trim();
      if (q) this.setHash('/search', { q, page: 1 });
    });

    this.appEl.addEventListener('click', e => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        const href = nav.getAttribute('href') || nav.dataset.href;
        if (href) {
          e.preventDefault();
          this.saveScrollPosition();
          window.location.hash = href.startsWith('#') ? href.slice(1) : href;
        }
      }

      const cell = e.target.closest('.image-cell');
      if (cell && !e.target.closest('.img-download-btn')) {
        const src = cell.dataset.img;
        const idx = parseInt(cell.dataset.idx, 10);
        if (src) this.openLightbox(src, idx);
      }

      const dlBtn = e.target.closest('.img-download-btn');
      if (dlBtn) {
        e.stopPropagation();
        const parentCell = dlBtn.closest('.image-cell');
        const idx        = parseInt(parentCell.dataset.idx, 10);
        const url        = this.galleryImages[idx];
        if (!url) return;
        const ext      = url.split('.').pop().split('?')[0] || 'jpg';
        const safeName = (this.currentGalleryTitle || 'image').replace(/[^a-z0-9]/gi, '_').substring(0, 40);
        this.downloadImage(url, `${safeName}_${String(idx + 1).padStart(3, '0')}.${ext}`);
        return;
      }

      const bulkBtn = e.target.closest('#bulkDownloadBtn');
      if (bulkBtn) {
        e.stopPropagation();
        this.bulkDownload();
      }
    });

    this.lightboxClose.addEventListener('click', () => this.closeLightbox());
    this.lightboxCopy.addEventListener('click',  e => { e.stopPropagation(); this.copyLightboxUrl(); });
    this.lightboxPrev.addEventListener('click',  e => { e.stopPropagation(); this.prevImage(); });
    this.lightboxNext.addEventListener('click',  e => { e.stopPropagation(); this.nextImage(); });

    this.lightbox.addEventListener('click', e => {
      if (e.target === this.lightbox || e.target.classList.contains('lightbox-backdrop')) {
        this.closeLightbox();
      }
    });

    document.addEventListener('keydown', e => {
      if (!this.lightbox.classList.contains('active')) return;
      if (e.key === 'Escape')     this.closeLightbox();
      if (e.key === 'ArrowLeft')  this.prevImage();
      if (e.key === 'ArrowRight') this.nextImage();
    });

    let touchStartX = 0;
    this.lightbox.addEventListener('touchstart', e => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    this.lightbox.addEventListener('touchend', e => {
      const diff = touchStartX - e.changedTouches[0].screenX;
      if (Math.abs(diff) > 50) diff > 0 ? this.nextImage() : this.prevImage();
    }, { passive: true });
  }

  /* ─── Observers ──────────────────────────────────────────────────────────── */

  initObservers() {
    const fadeObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          setTimeout(() => {
            entry.target.style.animationDelay = '0s';
            entry.target.classList.add('fade-in');
          }, i * 50);
          fadeObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05, rootMargin: '50px' });

    new MutationObserver(() => {
      this.appEl.querySelectorAll('.card, .image-cell').forEach(el => {
        if (!el.classList.contains('fade-in')) fadeObserver.observe(el);
      });
    }).observe(this.appEl, { childList: true, subtree: true });
  }

  /* ─── Scroll ─────────────────────────────────────────────────────────────── */

  saveScrollPosition() {
    const { path } = this.parseHash();
    this.scrollPositions.set(path, window.scrollY);
  }

  restoreScrollPosition() {
    const { path } = this.parseHash();
    const saved    = this.scrollPositions.get(path);
    if (saved != null) {
      setTimeout(() => window.scrollTo({ top: saved, behavior: 'instant' }), 0);
      this.scrollPositions.delete(path);
    }
  }

  /* ─── Infinite Scroll ────────────────────────────────────────────────────── */

  resetInfiniteScroll() {
    this.sentinelObserver?.disconnect();
    this.sentinelObserver = null;
    this.sentinel?.remove();
    this.sentinel  = null;
    this.listState = { type: null, page: 1, hasMore: false, loading: false, params: {} };
  }

  setupInfiniteScroll() {
    this.sentinel?.remove();
    this.sentinel           = document.createElement('div');
    this.sentinel.className = 'load-sentinel';
    this.sentinel.innerHTML = '<div class="sentinel-spinner"></div><span>Loading more...</span>';
    this.appEl.appendChild(this.sentinel);

    this.sentinelObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && this.listState.hasMore && !this.listState.loading) {
        this.handleInfiniteScroll();
      }
    }, { rootMargin: '400px' });

    this.sentinelObserver.observe(this.sentinel);
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
    // Disconnect so the observer doesn't immediately fire again on the next
    // scroll tick. The user can manually retry via the button.
    this.sentinelObserver?.disconnect();
    this.sentinel.classList.add('error');
    this.sentinel.innerHTML = `
      <span style="color:var(--danger)">Failed to load more</span>
      <button class="btn btn-sm" id="sentinelRetryBtn" style="margin-left:.75rem">Retry</button>
    `;
    this.sentinel.querySelector('#sentinelRetryBtn')?.addEventListener('click', () => {
      // Re-attach the observer and try again
      this.sentinel.classList.remove('error');
      this.sentinelObserver?.observe(this.sentinel);
      this.handleInfiniteScroll();
    }, { once: true });
  }

  async handleInfiniteScroll() {
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
          hasMore    = data.pagination.hasMore;
          itemsHtml  = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'search': {
          const data = await this.api.search(this.listState.params.q, nextPage);
          hasMore    = data.pagination.hasMore;
          itemsHtml  = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'cosplays': {
          const data = await this.api.getCosplayCharacters(nextPage);
          hasMore    = data.pagination.hasMore;
          itemsHtml  = data.characters.map((c, i) => this.characterCard(c, i)).join('');
          break;
        }
        case 'character': {
          const data = await this.api.getCharacter(this.listState.params.name, nextPage);
          hasMore    = data.pagination.hasMore;
          itemsHtml  = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'model': {
          const data = await this.api.getModel(this.listState.params.name, nextPage);
          hasMore    = data.pagination.hasMore;
          itemsHtml  = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
        case 'fandom': {
          const data = await this.api.getFandom(this.listState.params.name, nextPage);
          hasMore    = data.pagination.hasMore;
          itemsHtml  = data.albums.map((a, i) => this.albumCard(a, i)).join('');
          break;
        }
      }

      this.listState.page    = nextPage;
      this.listState.hasMore = hasMore;

      const grid = this.appEl.querySelector('.grid');
      if (grid && itemsHtml) {
        const temp = document.createElement('div');
        temp.innerHTML = itemsHtml;
        for (const node of temp.children) {
          node.style.animationDelay = '0s';
          node.classList.add('fade-in');
          grid.appendChild(node);
        }
      }

      if (!hasMore) {
        this.setSentinelEnd();
        this.sentinelObserver?.disconnect();
      }
    } catch (e) {
      console.error(e);
      // API retries are already exhausted at this point — show the retry button.
      this.setSentinelError();
      this.toast('Failed to load more content', 'error');
    } finally {
      this.listState.loading = false;
    }
  }

  /* ─── Lightbox ───────────────────────────────────────────────────────────── */

  openLightbox(src, index = 0) {
    this.currentImageIndex  = index;
    this.lightboxImg.src    = src;
    this.lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
    this.updateLightboxUI();
    this.preloadImages(index, 2);
    setTimeout(() => this.lightbox.focus(), 50);
  }

  closeLightbox() {
    this.lightbox.classList.remove('active');
    this.lightboxImg.src         = '';
    document.body.style.overflow = '';
  }

  prevImage() {
    if (this.galleryImages.length <= 1) return;
    this.currentImageIndex      = (this.currentImageIndex - 1 + this.galleryImages.length) % this.galleryImages.length;
    this.lightboxImg.style.opacity = '0.7';
    setTimeout(() => {
      this.lightboxImg.src           = this.galleryImages[this.currentImageIndex];
      this.lightboxImg.style.opacity = '1';
    }, 100);
    this.updateLightboxUI();
    this.preloadImages(this.currentImageIndex, 2);
  }

  nextImage() {
    if (this.galleryImages.length <= 1) return;
    this.currentImageIndex      = (this.currentImageIndex + 1) % this.galleryImages.length;
    this.lightboxImg.style.opacity = '0.7';
    setTimeout(() => {
      this.lightboxImg.src           = this.galleryImages[this.currentImageIndex];
      this.lightboxImg.style.opacity = '1';
    }, 100);
    this.updateLightboxUI();
    this.preloadImages(this.currentImageIndex, 2);
  }

  updateLightboxUI() {
    const total = this.galleryImages.length;
    this.lightboxCounter.textContent = `${this.currentImageIndex + 1} / ${total}`;
    this.lightboxPrev.classList.toggle('hidden', total <= 1);
    this.lightboxNext.classList.toggle('hidden', total <= 1);
  }

  async copyLightboxUrl() {
    const url = this.galleryImages[this.currentImageIndex];
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Image URL copied!', 'success');
    } catch {
      this.toast('Failed to copy URL', 'error');
    }
  }

  preloadImages(centerIdx, radius) {
    for (let i = -radius; i <= radius; i++) {
      const idx = (centerIdx + i + this.galleryImages.length) % this.galleryImages.length;
      if (idx === centerIdx) continue;
      new Image().src = this.galleryImages[idx];
    }
  }

  /* ─── Downloads ──────────────────────────────────────────────────────────── */

  async downloadImage(url, filename, silent = false) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob    = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a       = document.createElement('a');
      a.href     = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      if (!silent) this.toast(`Downloaded ${filename}`, 'success');
      return true;
    } catch (err) {
      console.error(err);
      if (!silent) this.toast('Download failed — try opening the image first', 'error');
      return false;
    }
  }

  async bulkDownload() {
    const btn = document.getElementById('bulkDownloadBtn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    const total        = this.galleryImages.length;
    const safeName     = (this.currentGalleryTitle || 'gallery').replace(/[^a-z0-9]/gi, '_').substring(0, 40);
    let failed         = 0;

    for (let i = 0; i < total; i++) {
      btn.innerHTML    = `<span class="dl-spinner"></span> Downloading ${i + 1}/${total}…`;
      const url        = this.galleryImages[i];
      const ext        = url.split('.').pop().split('?')[0] || 'jpg';
      const ok         = await this.downloadImage(url, `${safeName}_${String(i + 1).padStart(3, '0')}.${ext}`, true);
      if (!ok) failed++;
      if (i < total - 1) await new Promise(r => setTimeout(r, 400));
    }

    btn.innerHTML = originalHTML;
    btn.disabled  = false;
    this.toast(
      failed ? `Downloaded ${total - failed}/${total} images` : `All ${total} images downloaded`,
      failed ? 'warning' : 'success',
    );
  }

  /* ─── Views ──────────────────────────────────────────────────────────────── */

  async homeView() {
    this.renderSkeleton();
    try {
      const data = await this.api.getHome(1);
      this.listState = { type: 'home', page: 1, hasMore: data.pagination.hasMore, loading: false, params: {} };

      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums found.</div>';

      this.render(`
        <div class="page-header"><h1>Home</h1></div>
        <div class="grid">${albums}</div>
      `);

      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (e) { this.renderError(e); }
  }

  async searchView(query) {
    this.renderSkeleton();
    try {
      const data = await this.api.search(query, 1);
      this.listState = { type: 'search', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { q: query } };

      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No results found.</div>';

      this.render(`
        <div class="page-header">
          <h1>Search: "${this.escapeHtml(query)}"</h1>
          <p>${data.totalResults != null ? data.totalResults + ' results' : ''}</p>
        </div>
        <div class="grid">${albums}</div>
      `);

      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (e) { this.renderError(e); }
  }

  async cosplaysView() {
    this.renderSkeleton();
    try {
      const data = await this.api.getCosplayCharacters(1);
      this.listState = { type: 'cosplays', page: 1, hasMore: data.pagination.hasMore, loading: false, params: {} };

      const chars = data.characters.length
        ? data.characters.map((c, i) => this.characterCard(c, i)).join('')
        : '<div class="empty">No characters found.</div>';

      this.render(`
        <div class="page-header">
          <h1>Cosplay Characters</h1>
          <p>${data.totalCharacters != null ? data.totalCharacters + ' characters' : ''}</p>
        </div>
        <div class="grid char-grid">${chars}</div>
      `);

      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (e) { this.renderError(e); }
  }

  async characterView(name) {
    this.renderSkeleton();
    try {
      const data = await this.api.getCharacter(name, 1);
      this.listState = { type: 'character', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { name } };

      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums for this character.</div>';

      this.render(`
        <div class="page-header">
          <h1>${this.escapeHtml(data.character.name)}</h1>
          <p>${data.character.albumCount} albums</p>
        </div>
        <div class="grid">${albums}</div>
      `);

      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (e) { this.renderError(e); }
  }

  async modelView(name) {
    this.renderSkeleton();
    try {
      const data = await this.api.getModel(name, 1);
      this.listState = { type: 'model', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { name } };

      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums for this model.</div>';

      this.render(`
        <div class="page-header">
          <h1>Model: ${this.escapeHtml(data.model.name)}</h1>
          <p>${data.model.albumCount} albums</p>
        </div>
        <div class="grid">${albums}</div>
      `);

      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (e) { this.renderError(e); }
  }

  async fandomView(name) {
    this.renderSkeleton();
    try {
      const data = await this.api.getFandom(name, 1);
      this.listState = { type: 'fandom', page: 1, hasMore: data.pagination.hasMore, loading: false, params: { name } };

      const albums = data.albums.length
        ? data.albums.map((a, i) => this.albumCard(a, i)).join('')
        : '<div class="empty">No albums for this fandom.</div>';

      this.render(`
        <div class="page-header">
          <h1>Fandom: ${this.escapeHtml(data.fandom.name)}</h1>
          <p>${data.fandom.albumCount} albums</p>
        </div>
        <div class="grid">${albums}</div>
      `);

      if (data.pagination.hasMore) this.setupInfiniteScroll();
    } catch (e) { this.renderError(e); }
  }

  async galleryView(id) {
    this.renderLoading();
    try {
      const data   = await this.api.getGallery(id);
      const meta   = data.meta;
      const images = data.allImageUrls.length ? data.allImageUrls : data.images.map(i => i.url);

      this.currentGalleryTitle = meta.title;
      this.galleryImages       = images.map(url => this.proxify(url));
      this.currentImageIndex   = 0;

      const tags = [];
      if (meta.model)     tags.push(`<a href="#/model/${encodeURIComponent(meta.model.name)}" class="tag model" data-nav>${this.escapeHtml(meta.model.name)}</a>`);
      if (meta.character) tags.push(`<a href="#/cosplay/${encodeURIComponent(meta.character.name)}" class="tag" data-nav>${this.escapeHtml(meta.character.name)}</a>`);
      if (meta.fandom)    tags.push(`<a href="#/fandom/${encodeURIComponent(meta.fandom.name)}" class="tag fandom" data-nav>${this.escapeHtml(meta.fandom.name)}</a>`);

      const imagesHtml = images.length
        ? images.map((url, idx) => {
            const proxied = this.proxify(url);
            return `
              <div class="image-cell" data-img="${this.escapeHtml(proxied)}" data-idx="${idx}">
                <img src="${this.escapeHtml(proxied)}" alt="${idx + 1}" loading="lazy">
                <button class="img-download-btn" title="Download image" aria-label="Download image">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </button>
              </div>
            `;
          }).join('')
        : '<div class="empty">No images found.</div>';

      this.render(`
        <div class="gallery-meta">
          <h1>${this.escapeHtml(meta.title)}</h1>
          ${meta.description ? `<p class="desc">${this.escapeHtml(meta.description)}</p>` : ''}
          <div class="gallery-meta-row">
            <div class="tags">${tags.join('')}</div>
            <div class="gallery-actions">
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

      this.preloadImages(0, 3);
    } catch (e) { this.renderError(e); }
  }

  /* ─── Render Helpers ─────────────────────────────────────────────────────── */

  render(html) {
    this.appEl.innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  renderLoading() {
    this.render(`
      <div class="loading">
        <div class="spinner"></div>
        <p>Loading content...</p>
      </div>
    `);
  }

  renderSkeleton(count = 12) {
    const cards = Array.from({ length: count }, () => `
      <div class="card skeleton-card">
        <div class="thumb-wrap skeleton"></div>
        <div class="info">
          <div class="skeleton skeleton-title"></div>
          <div class="skeleton skeleton-meta"></div>
        </div>
      </div>
    `).join('');

    this.appEl.innerHTML = `
      <div class="page-header"><h1>Loading...</h1></div>
      <div class="grid">${cards}</div>
    `;
  }

  renderError(err) {
    const msg = err instanceof OsosedkiError
      ? `${err.message} (${err.status})`
      : err.message || String(err);
    this.render(`
      <div class="error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <path d="m15 9-6 6"/>
          <path d="m9 9 6 6"/>
        </svg>
        <h2>Something went wrong (Yes the Proxy is necessary)</h2>
        <p>${this.escapeHtml(msg)}</p>
        ${err.stack ? `<pre>${this.escapeHtml(err.stack)}</pre>` : ''}
        <button class="btn" style="margin-top:1rem" onclick="window.location.reload()">Retry</button>
      </div>
    `);
  }

  /* ─── Components ─────────────────────────────────────────────────────────── */

  albumCard(a, idx = 0) {
    const thumb = this.proxify(a.thumbnail);
    return `
      <div class="card" data-nav data-href="#/gallery/${encodeURIComponent(a.id)}" style="animation-delay: ${idx * 0.05}s">
        <div class="thumb-wrap">
          ${thumb ? `<img src="${this.escapeHtml(thumb)}" alt="" loading="lazy">` : ''}
          ${a.isNew ? '<span class="badge new">New</span>' : ''}
        </div>
        <div class="info">
          <div class="title">${this.escapeHtml(a.title)}</div>
          <div class="meta">
            <span>${this.escapeHtml(a.modelName)}</span>
            <span>${a.imageCount} photos</span>
          </div>
        </div>
      </div>
    `;
  }

  characterCard(c, idx = 0) {
    return `
      <a href="#/cosplay/${encodeURIComponent(c.name)}" class="card char-card" data-nav style="animation-delay: ${idx * 0.05}s">
        <div class="name">${this.escapeHtml(c.name)}</div>
        ${c.fandom    ? `<div class="fandom">${this.escapeHtml(c.fandom)}</div>` : ''}
        ${c.albumCount != null ? `<div class="count">${c.albumCount} albums</div>` : ''}
      </a>
    `;
  }

  /* ─── Utilities ──────────────────────────────────────────────────────────── */

  escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, m =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );
  }

  toast(message, type = 'info', duration = 3000) {
    const el      = document.createElement('div');
    el.className  = `toast ${type}`;
    el.textContent = message;
    this.toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-out');
      el.addEventListener('animationend', () => el.remove());
    }, duration);
  }
}

new App();