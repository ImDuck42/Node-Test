/**
 * @file        api.mjs
 * @description Browser-side scraping client for ososedki.com
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://ososedki.com';

/** Browser-compatible request headers that mimic a real navigation. */
const DEFAULT_HEADERS = Object.freeze({
  Accept:
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language'          : 'en-US,en;q=0.5',
  DNT                        : '1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest'           : 'document',
  'Sec-Fetch-Mode'           : 'navigate',
  'Sec-Fetch-Site'           : 'none',
  'Sec-Fetch-User'           : '?1',
  'Cache-Control'            : 'max-age=0',
});

// ─── Error class ──────────────────────────────────────────────────────────────

export class OsosedkiError extends Error {
  /**
   * @param {string}      message
   * @param {number|null} [status] HTTP status code, if applicable
   * @param {string|null} [url]    Request URL, if applicable
   */
  constructor(message, status = null, url = null) {
    super(message);
    this.name   = 'OsosedkiError';
    this.status = status;
    this.url    = url;
  }
}

// ─── Pure utility helpers ─────────────────────────────────────────────────────

/**
 * Extracts the first integer (with optional comma-separators) from `text`  
 * Returns 0 when nothing is found.
 *
 * @param   {unknown} text
 * @returns {number}
 */
function extractInt(text) {
  if (text == null) return 0;
  const match = String(text).match(/(\d[\d,]*)/);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
}

/**
 * URL-decodes a percent-encoded path segment, replacing `+` with a space
 *
 * @param   {string} encoded
 * @returns {string}
 */
function decodeName(encoded) {
  try {
    return decodeURIComponent(encoded.replace(/\+/g, ' '));
  } catch {
    return encoded;
  }
}

/**
 * Parses an HTML string into a `Document` using the browser's DOMParser
 *
 * @param   {string} html
 * @returns {Document}
 */
function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Concatenates the `textContent` of every element in `elements`
 *
 * @param   {Iterable<Element>} elements
 * @returns {string}
 */
function combinedText(elements) {
  return Array.from(elements).map(el => el.textContent).join('');
}

/**
 * Returns the siblings of `h1` inside its parent that are `<p>` elements
 *
 * @param   {Element|null} h1
 * @returns {Element[]}
 */
function siblingParagraphs(h1) {
  return Array.from(h1?.parentElement?.children ?? [])
    .filter(el => el.tagName === 'P' && el !== h1);
}

/**
 * Extracts an album-count integer from the text surrounding an `<h1>`
 *
 * @param   {Element|null} h1
 * @returns {number}
 */
function extractAlbumCountFromH1(h1) {
  const psText = combinedText(siblingParagraphs(h1));
  const source = psText || h1?.parentElement?.textContent || '';
  return extractInt(source.match(/(\d[\d,]*)\s*albums?/i)?.[1] ?? '');
}

// ─── DOM parsers ──────────────────────────────────────────────────────────────

/**
 * Parses album cards from a listing page
 *
 * @param   {Document} doc
 * @param   {string}   baseUrl
 * @returns {Album[]}
 */
function parseAlbums(doc, baseUrl) {
  const seen   = new Set();
  const albums = [];

  for (const link of doc.querySelectorAll('a[href^="/photos/"]')) {
    const href = link.getAttribute('href') ?? '';
    const id   = href.replace('/photos/', '') || null;

    if (!id || seen.has(id)) continue;

    const figure = link.querySelector('figure');
    if (!figure) continue;

    seen.add(id);

    // Thumbnail
    const img = figure.querySelector('img');
    let thumbnail = img?.getAttribute('data-src') ?? img?.getAttribute('src') ?? '';
    if (thumbnail.startsWith('/')) thumbnail = baseUrl + thumbnail;

    const isNew = figure.textContent.includes('NEW');

    // Prefer structured child <div>s; fall back to plain text parsing
    const divs       = Array.from(link.children).filter(el => el.tagName === 'DIV');
    let title        = divs[0]?.textContent.trim() ?? '';
    let modelName    = divs[1]?.textContent.trim() ?? '';
    let imageCount   = divs[2] ? extractInt(divs[2].textContent) : 0;

    if (!title) {
      const lines = link.textContent
        .replace(/NEW/g, '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

      title      = lines[0] ?? '';
      modelName  = lines[1] ?? '';
      imageCount = lines[2] ? extractInt(lines[2]) : 0;
    }

    if (!modelName && title.includes(' - ')) {
      [modelName] = title.split(' - ');
    }

    albums.push({ id, url: `${baseUrl}/photos/${id}`, title, modelName, imageCount, isNew, thumbnail });
  }

  return albums;
}

/**
 * Parses cosplay-character cards from `/cosplays`
 *
 * @param   {Document} doc
 * @param   {string}   baseUrl
 * @returns {Character[]}
 */
function parseCharacters(doc, baseUrl) {
  const seen       = new Set();
  const characters = [];

  for (const link of doc.querySelectorAll('a[href^="/cosplay/"]')) {
    const href        = link.getAttribute('href') ?? '';
    const encodedName = href.replace('/cosplay/', '');

    if (!encodedName || seen.has(encodedName)) continue;
    seen.add(encodedName);

    const lines          = link.textContent.split('\n').map(l => l.trim()).filter(Boolean);
    const albumCountLine = lines.find(l => /\d+\s*albums?/i.test(l));
    const albumCount     = albumCountLine ? extractInt(albumCountLine) : null;
    const decodedName    = decodeName(encodedName);
    const fandom         = lines.find(l => l !== decodedName && l !== albumCountLine) ?? '';

    characters.push({
      name: decodedName,
      encodedName,
      fandom,
      albumCount,
      url: `${baseUrl}${href}`,
    });
  }

  return characters;
}

/**
 * Parses individual image entries from a gallery page
 *
 * @param   {Document} doc
 * @param   {string}   baseUrl
 * @returns {GalleryImage[]}
 */
function parseGalleryImages(doc, baseUrl) {
  const images = [];

  for (const figure of doc.querySelectorAll('figure.photo-item')) {
    const link = figure.querySelector('a[href^="/images/a/"]');
    if (!link) continue;

    const href  = link.getAttribute('href') ?? '';
    const img   = figure.querySelector('img.photo-img');
    const thumb = img?.getAttribute('src') ?? '';

    images.push({
      url:   `${baseUrl}${href}`,
      thumb: thumb.startsWith('/') ? `${baseUrl}${thumb}` : thumb,
      path:  href,
    });
  }

  return images;
}

/**
 * Extracts metadata (title, description, tags, image count) from a gallery page
 *
 * @param   {Document} doc
 * @param   {string}   url Canonical URL of this gallery page
 * @param   {string}   baseUrl
 * @returns {GalleryMeta}
 */
function parseGalleryMeta(doc, url, baseUrl) {
  const id        = url.split('/photos/')[1]?.split('?')[0] ?? null;
  const h1        = doc.querySelector('h1');
  const h1Text    = h1?.textContent.trim() ?? '';
  const pageTitle = doc.title ?? '';

  let description = '';
  for (const p of doc.querySelectorAll('p')) {
    const text = p.textContent.trim();
    if (text.length > 80 && !text.includes('DMCA')) {
      description = text;
      break;
    }
  }

  const tags = Array.from(
    doc.querySelectorAll('a[href^="/model/"], a[href^="/cosplay/"], a[href^="/fandom/"]'),
  ).map(tag => {
    const href = tag.getAttribute('href') ?? '';
    const type = href.startsWith('/model/')   ? 'model'
               : href.startsWith('/cosplay/') ? 'character'
               : href.startsWith('/fandom/')  ? 'fandom'
               :                                'unknown';
    return { type, name: tag.textContent.trim(), url: `${baseUrl}${href}` };
  });

  const countMatch = (h1Text || pageTitle).match(/\((\d+)\s*(?:leaked\s*)?photos?\)/i);
  const imageCount = countMatch ? parseInt(countMatch[1], 10) : 0;

  return {
    id,
    url,
    title:     h1Text || pageTitle.split(' - ')[0] || '',
    description,
    imageCount,
    model:     tags.find(t => t.type === 'model')     ?? null,
    character: tags.find(t => t.type === 'character') ?? null,
    fandom:    tags.find(t => t.type === 'fandom')    ?? null,
  };
}

/**
 * Returns whether there is a "next page" link in `doc`
 *
 * @param   {Document} doc
 * @returns {{ hasMore: boolean }}
 */
function parsePagination(doc) {
  return { hasMore: !!doc.querySelector('a.next-page') };
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Calls `fn` up to `retries + 1` times, waiting `baseDelayMs * 2^attempt` ms between attempts
 *
 * @template Type
 * @param    {() => Promise<Type>} fn
 * @param    {number}              retries
 * @param    {number}              baseDelayMs
 * @returns  {Promise<Type>}
 */
async function withRetry(fn, retries = 2, baseDelayMs = 500) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        !(err instanceof OsosedkiError) || // network-level error
        err.status == null ||              // no status (e.g. CORS, abort)
        err.status === 429 ||
        err.status >= 500;

      if (!isRetryable || attempt === retries) throw err;

      await new Promise(res => setTimeout(res, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}

// ─── Main API class ───────────────────────────────────────────────────────────

export class OsosedkiAPI {
  /**
   * @param {object}                [options]
   * @param {string}                [options.baseUrl=DEFAULT_BASE_URL] Override the root URL.
   * @param {Record<string,string>} [options.extraHeaders={}]          Additional request headers.
   * @param {number}                [options.retries=2]                Retry attempts on transient errors.
   * @param {number}                [options.retryDelayMs=500]         Base back-off delay (ms).
   * @param {number}                [options.probeConcurrency=10]      Max concurrent HEAD requests.
   */
  constructor({
    baseUrl          = DEFAULT_BASE_URL,
    extraHeaders     = {},
    retries          = 2,
    retryDelayMs     = 500,
    probeConcurrency = 10,
  } = {}) {
    this.baseUrl          = baseUrl.replace(/\/$/, '');
    this.headers          = { ...DEFAULT_HEADERS, ...extraHeaders };
    this.retries          = retries;
    this.retryDelayMs     = retryDelayMs;
    this.probeConcurrency = probeConcurrency;
  }

  // ── Low-level networking ────────────────────────────────────────────────────

  /**
   * Fetches `path` (relative to `baseUrl`) and returns the response body as text
   *
   * @param {string}           path
   * @param {Record<string,*>} [params={}] Query-string parameters (nullish values are skipped)
   * @returns {Promise<string>}
   */
  async request(path, params = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, val] of Object.entries(params)) {
      if (val != null) url.searchParams.set(key, String(val));
    }

    const urlStr = url.toString();

    return withRetry(async () => {
      const res = await fetch(urlStr, { method: 'GET', headers: this.headers });
      if (!res.ok) {
        throw new OsosedkiError(`HTTP ${res.status}: ${res.statusText}`, res.status, urlStr);
      }
      return res.text();
    }, this.retries, this.retryDelayMs);
  }

  /**
   * Parses an HTML string into a `Document`
   *
   * @param {string} html
   * @returns {Document}
   */
  parse(html) {
    return parseHtml(html);
  }

  /**
   * Returns `true` when the resource at `url` exists (HEAD request succeeds)
   *
   * @param {string} url
   * @returns {Promise<boolean>}
   */
  async imageExists(url) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: this.headers });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  /**
   * Fetches an entity page (character / model / fandom) and returns structured data
   *
   * @private
   * @param   {'cosplay'|'model'|'fandom'} segment
   * @param   {string}                      name       Raw (un-encoded) display name
   * @param   {number}                      page
   * @param   {string}                      errorLabel Used in validation error messages
   * @returns {Promise<EntityPage>}
   */
  async getEntityPage(segment, name, page, errorLabel) {
    if (!name?.trim()) throw new OsosedkiError(`${errorLabel} is required`);

    const encoded    = encodeURIComponent(name.trim());
    const doc        = this.parse(await this.request(`/${segment}/${encoded}`, { page }));
    const h1         = doc.querySelector('h1');
    const albumCount = extractAlbumCountFromH1(h1);

    return {
      entity: {
        name:        name.trim(),
        encodedName: encoded,
        albumCount,
        url:         `${this.baseUrl}/${segment}/${encoded}`,
      },
      albums:     parseAlbums(doc, this.baseUrl),
      pagination: { ...parsePagination(doc), currentPage: page },
    };
  }

  /**
   * Fetches and returns the album count for any entity path
   *
   * @param {string} path e.g. `/cosplay/Asuka`
   * @returns {Promise<number>}
   */
  async fetchAlbumCount(path) {
    try {
      const doc        = this.parse(await this.request(path));
      const h1         = doc.querySelector('h1');
      return extractAlbumCountFromH1(h1);
    } catch {
      return 0;
    }
  }

  /**
   * Derives the CDN base path for a gallery's numbered images
   *
   * @param {string} galleryId  e.g. `"-12345"`
   * @returns {string|null}
   */
  galleryBasePath(galleryId) {
    const sep = galleryId.indexOf('_');
    if (sep === -1) return null;
    const folder = galleryId.slice(0, sep);
    const id     = galleryId.slice(sep + 1);
    return `${this.baseUrl}/images/a/1280/${folder}/${id}`;
  }

  /**
   * Probes a gallery's CDN path with HEAD requests to test for existence
   *
   * @param   {string} galleryId
   * @param   {object} [options]
   * @param   {number} [options.expectedCount=50] Hint used to compute scan cap.
   * @param   {number} [options.scanStep=1]       Step size for the initial scan.
   * @param   {number} [options.maxIndex=2000]    Hard upper bound on file index.
   * @returns {Promise<{ urls: string[], startIndex: number, endIndex: number }>}
   */
  async probeGalleryImageUrls(galleryId, { expectedCount = 50, scanStep = 1, maxIndex = 2000 } = {}) {
    const base = this.galleryBasePath(galleryId);
    if (!base) return { urls: [], startIndex: -1, endIndex: -1 };

    const cap = Math.min(maxIndex, expectedCount > 0 ? expectedCount * 3 : maxIndex);

    // Find the first existing image
    let startIndex = -1;
    const scanIndices = Array.from(
      { length: Math.ceil(cap / scanStep) },
      (_, i) => 1 + i * scanStep,
    );

    outer:
    for (let b = 0; b < scanIndices.length; b += this.probeConcurrency) {
      const batch   = scanIndices.slice(b, b + this.probeConcurrency);
      const results = await Promise.all(
        batch.map(async i => ({ i, exists: await this.imageExists(`${base}/${i}.webp`) })),
      );
      for (const { i, exists } of results) {
        if (exists) { startIndex = i; break outer; }
      }
    }

    if (startIndex === -1) return { urls: [], startIndex: -1, endIndex: -1 };

    // Walk consecutive indices from startIndex
    const urls     = [`${base}/${startIndex}.webp`];
    let   endIndex = startIndex;

    for (let i = startIndex + 1; i <= cap; i += this.probeConcurrency) {
      const batch   = Array.from({ length: Math.min(this.probeConcurrency, cap - i + 1) }, (_, k) => i + k);
      const results = await Promise.all(
        batch.map(async idx => ({ idx, exists: await this.imageExists(`${base}/${idx}.webp`) })),
      );

      let hitGap = false;
      for (const { idx, exists } of results) {
        if (!exists) { hitGap = true; break; }
        urls.push(`${base}/${idx}.webp`);
        endIndex = idx;
      }
      if (hitGap) break;
    }

    return { urls, startIndex, endIndex };
  }

  // ── Public API methods ──────────────────────────────────────────────────────

  /**
   * Fetches the home/listing page
   *
   * @param   {number} [page=1]
   * @returns {Promise<{ albums: Album[], pagination: Pagination }>}
   */
  async getHome(page = 1) {
    const doc = this.parse(await this.request('/', { page }));
    return {
      albums:     parseAlbums(doc, this.baseUrl),
      pagination: { ...parsePagination(doc), currentPage: page },
    };
  }

  /**
   * Searches the site for albums matching `query`
   *
   * @param   {string} query
   * @param   {number} [page=1]
   * @returns {Promise<{ query: string, totalResults: number|null, albums: Album[], pagination: Pagination }>}
   */
  async search(query, page = 1) {
    if (!query?.trim()) throw new OsosedkiError('Search query is required');

    const doc       = this.parse(await this.request('/search', { q: query.trim(), page }));
    const pageText  = combinedText(doc.querySelectorAll('h1, .page-title')) || doc.title;
    const countMatch = pageText.match(/\((\d+)\s*results?\)/);

    return {
      query,
      totalResults: countMatch ? parseInt(countMatch[1], 10) : null,
      albums:       parseAlbums(doc, this.baseUrl),
      pagination:   { ...parsePagination(doc), currentPage: page },
    };
  }

  /**
   * Fetches the cosplay-characters listing  
   * Characters whose album counts could not be determined from the listing are hydrated in parallel batches
   *
   * @param   {number} [page=1]
   * @returns {Promise<{ totalCharacters: number|null, characters: Character[], pagination: Pagination }>}
   */
  async getCosplayCharacters(page = 1) {
    const doc        = this.parse(await this.request('/cosplays', { page }));
    const headerText = combinedText(doc.querySelectorAll('h1, .page-title')) || doc.body.textContent;
    const countMatch = headerText.match(/([\d,]+)\s*characters?/);
    const characters = parseCharacters(doc, this.baseUrl);

    // Hydrate missing album counts in parallel batches
    const needsHydration = characters.filter(c => c.albumCount == null);
    for (let i = 0; i < needsHydration.length; i += this.probeConcurrency) {
      const batch = needsHydration.slice(i, i + this.probeConcurrency);
      await Promise.all(
        batch.map(async char => {
          char.albumCount = await this.fetchAlbumCount(`/cosplay/${char.encodedName}`);
        }),
      );
    }

    return {
      totalCharacters: countMatch ? extractInt(countMatch[1]) : null,
      characters,
      pagination: { ...parsePagination(doc), currentPage: page },
    };
  }

  /**
   * Fetches albums for a specific cosplay character
   *
   * @param   {string} name Display name of the character (will be URL-encoded)
   * @param   {number} [page=1]
   * @returns {Promise<{ character: Entity, albums: Album[], pagination: Pagination }>}
   */
  async getCharacter(name, page = 1) {
    const { entity, albums, pagination } = await this.getEntityPage('cosplay', name, page, 'Character name');

    // Attempt to extract the canonical display name from the breadcrumb
    const doc          = this.parse(await this.request(`/cosplay/${entity.encodedName}`, { page }));
    const breadcrumbEl = doc.querySelector('.breadcrumb, [class*="breadcrumb"]');
    if (breadcrumbEl) {
      const parts = breadcrumbEl.textContent.split('/').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) entity.name = parts[parts.length - 1];
    }

    return { character: entity, albums, pagination };
  }

  /**
   * Fetches albums for a specific model
   *
   * @param   {string} name
   * @param   {number} [page=1]
   * @returns {Promise<{ model: Entity, albums: Album[], pagination: Pagination }>}
   */
  async getModel(name, page = 1) {
    const { entity, albums, pagination } = await this.getEntityPage('model', name, page, 'Model name');
    return { model: entity, albums, pagination };
  }

  /**
   * Fetches albums for a specific fandom
   *
   * @param   {string} name
   * @param   {number} [page=1]
   * @returns {Promise<{ fandom: Entity, albums: Album[], pagination: Pagination }>}
   */
  async getFandom(name, page = 1) {
    const { entity, albums, pagination } = await this.getEntityPage('fandom', name, page, 'Fandom name');
    return { fandom: entity, albums, pagination };
  }

  /**
   * Fetches metadata and the image list for a gallery page
   *
   * @param   {string} id Gallery ID (slug after `/photos/`)
   * @returns {Promise<{ meta: GalleryMeta, images: GalleryImage[], allImageUrls: string[] }>}
   */
  async getGallery(id) {
    if (!id?.trim()) throw new OsosedkiError('Gallery ID is required');

    const galleryUrl = `${this.baseUrl}/photos/${id}`;
    const doc        = this.parse(await this.request(`/photos/${id}`));
    const meta       = parseGalleryMeta(doc, galleryUrl, this.baseUrl);
    const images     = parseGalleryImages(doc, this.baseUrl);

    return { meta, images, allImageUrls: images.map(img => img.url) };
  }

  /**
   * Convenience wrapper: fetches a gallery and returns image URLs alongside metadata
   *
   * @param   {string} id
   * @returns {Promise<{ galleryId: string, imageUrls: string[], startIndex: number, endIndex: number, meta: GalleryMeta }>}
   */
  async getGalleryImages(id) {
    const gallery = await this.getGallery(id);
    return {
      galleryId:  id,
      imageUrls:  gallery.allImageUrls,
      startIndex: gallery.allImageUrls.length > 0 ? 1 : -1,
      endIndex:   gallery.allImageUrls.length,
      meta:       gallery.meta,
    };
  }
}

// ─── Module-level convenience ──────────────────────────────────────────────────

/**
 * Creates and returns a new `OsosedkiAPI` instance
 *
 * @param   {ConstructorParameters<typeof OsosedkiAPI>[0]} [options]
 * @returns {OsosedkiAPI}
 */
export function createClient(options) {
  return new OsosedkiAPI(options);
}

// ─── JSDoc type stubs (for IDE tooling — no runtime cost) ─────────────────────

/**
 * @typedef  {object}  Album
 * @property {string}  id
 * @property {string}  url
 * @property {string}  title
 * @property {string}  modelName
 * @property {number}  imageCount
 * @property {boolean} isNew
 * @property {string}  thumbnail
 */

/**
 * @typedef  {object}      Character
 * @property {string}      name
 * @property {string}      encodedName
 * @property {string}      fandom
 * @property {number|null} albumCount
 * @property {string}      url
 */

/**
 * @typedef  {object} GalleryImage
 * @property {string} url
 * @property {string} thumb
 * @property {string} path
 */

/**
 * @typedef  {object}      GalleryMeta
 * @property {string|null} id
 * @property {string}      url
 * @property {string}      title
 * @property {string}      description
 * @property {number}      imageCount
 * @property {object|null} model
 * @property {object|null} character
 * @property {object|null} fandom
 */

/**
 * @typedef  {object}  Pagination
 * @property {boolean} hasMore
 * @property {number}  currentPage
 */

/**
 * @typedef  {object} Entity
 * @property {string} name
 * @property {string} encodedName
 * @property {number} albumCount
 * @property {string} url
 */