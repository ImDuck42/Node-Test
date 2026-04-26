const DEFAULT_BASE_URL = 'https://ososedki.com';

const HEADERS = {
  'Accept'                   : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language'          : 'en-US,en;q=0.5',
  'DNT'                      : '1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest'           : 'document',
  'Sec-Fetch-Mode'           : 'navigate',
  'Sec-Fetch-Site'           : 'none',
  'Sec-Fetch-User'           : '?1',
  'Cache-Control'            : 'max-age=0',
};

export class OsosedkiError extends Error {
  constructor(message, status = null, url = null) {
    super(message);
    this.name   = 'OsosedkiError';
    this.status = status;
    this.url    = url;
  }
}

function extractInt(text) {
  const match = String(text).match(/(\d[\d,]*)/);
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
}

function decodeName(encoded) {
  try {
    return decodeURIComponent(encoded.replace(/\+/g, ' '));
  } catch {
    return encoded;
  }
}

function parseHtml(html) {
  const parser = new DOMParser();
  return parser.parseFromString(html, 'text/html');
}

function combinedText(elements) {
  return Array.from(elements).map(el => el.textContent).join('');
}

function parseAlbums(doc) {
  const seen = new Set();
  const albums = [];
  const links = doc.querySelectorAll('a[href^="/photos/"]');

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const id   = href.replace('/photos/', '') || null;

    if (!id || seen.has(id)) continue;

    const figure = link.querySelector('figure');
    if (!figure) continue;

    seen.add(id);

    const img       = figure.querySelector('img');
    let thumbnail = img?.getAttribute('data-src') || img?.getAttribute('src') || '';
    // Ensure thumbnails are absolute so the app proxy catches them
    if (thumbnail && thumbnail.startsWith('/')) {
      thumbnail = BASE_URL + thumbnail;
    }
    const isNew     = figure.textContent.includes('NEW');

    const divs      = Array.from(link.children).filter(el => el.tagName === 'DIV');
    let title       = divs[0] ? divs[0].textContent.trim() : '';
    let modelName   = divs[1] ? divs[1].textContent.trim() : '';
    let imageCount  = divs[2] ? extractInt(divs[2].textContent) : 0;

    if (!title) {
      const lines = link.textContent
        .replace(/NEW/g, '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

      title      = lines[0] || '';
      modelName  = lines[1] || '';
      imageCount = lines[2] ? extractInt(lines[2]) : 0;
    }

    if (!modelName && title.includes(' - ')) {
      modelName = title.split(' - ')[0];
    }

    albums.push({ id, url: `${BASE_URL}/photos/${id}`, title, modelName, imageCount, isNew, thumbnail });
  }

  return albums;
}

function parseCharacters(doc) {
  const seen       = new Set();
  const characters = [];
  const links      = doc.querySelectorAll('a[href^="/cosplay/"]');

  for (const link of links) {
    const href        = link.getAttribute('href') || '';
    const encodedName = href.replace('/cosplay/', '');

    if (!encodedName || seen.has(encodedName)) continue;
    seen.add(encodedName);

    const lines  = link.textContent.split('\n').map(l => l.trim()).filter(Boolean);
    const albumCountLine = lines.find(l => /\d+\s*albums?/i.test(l));
    const albumCount = albumCountLine ? extractInt(albumCountLine) : null;

    // Fandom is any line that isn't the decoded name and isn't the album count
    const decodedName = decodeName(encodedName);
    const fandom = lines.find(l => l !== decodedName && l !== albumCountLine) || '';

    characters.push({
      name: decodeName(encodedName),
      encodedName,
      fandom,
      albumCount,
      url: `${BASE_URL}${href}`,
    });
  }

  return characters;
}

function parseGalleryImages(doc) {
  const images = [];
  const links  = doc.querySelectorAll('a[href^="/images/a/"]');

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    images.push({
      url:   `${BASE_URL}${href}`,
      index: parseInt(link.textContent.trim(), 10) || images.length + 1,
      path:  href,
    });
  }

  return images;
}

function parseGalleryMeta(doc, url) {
  const id        = url.split('/photos/')[1]?.split('?')[0] || null;
  const h1        = doc.querySelector('h1');
  const h1Text    = h1 ? h1.textContent.trim() : '';
  const pageTitle = doc.title || '';

  let description = '';
  for (const p of doc.querySelectorAll('p')) {
    const text = p.textContent.trim();
    if (text.length > 80 && !text.includes('DMCA')) {
      description = text;
      break;
    }
  }

  const tags = [];
  for (const tag of doc.querySelectorAll('a[href^="/model/"], a[href^="/cosplay/"], a[href^="/fandom/"]')) {
    const href = tag.getAttribute('href') || '';
    const type = href.startsWith('/model/') ? 'model'
      : href.startsWith('/cosplay/') ? 'character'
      : href.startsWith('/fandom/') ? 'fandom'
      : 'unknown';

    tags.push({ type, name: tag.textContent.trim(), url: `${BASE_URL}${href}` });
  }

  const countMatch = (h1Text || pageTitle).match(/\((\d+)\s*(?:leaked\s*)?photos?\)/i);
  const imageCount = countMatch ? parseInt(countMatch[1], 10) : 0;

  return {
    id,
    url,
    title:       h1Text || pageTitle.split(' - ')[0] || '',
    description,
    imageCount,
    model:       tags.find(t => t.type === 'model') || null,
    character:   tags.find(t => t.type === 'character') || null,
    fandom:      tags.find(t => t.type === 'fandom') || null,
  };
}

function parsePagination(doc) {
  // The site uses a.next-page when another page exists; otherwise the li is disabled/contains no <a>
  const hasMore = !!doc.querySelector('a.next-page');
  return { hasMore };
}

let BASE_URL = DEFAULT_BASE_URL;

export function setBaseUrl(url) {
  BASE_URL = url.replace(/\/$/, '');
}

export function getBaseUrl() {
  return BASE_URL;
}

export class OsosedkiAPI {
  constructor(extraHeaders = {}) {
    this.headers = { ...HEADERS, ...extraHeaders };
  }

  async fetch(path, params = {}) {
    const url = new URL(path, BASE_URL);
    for (const [key, val] of Object.entries(params)) {
      if (val != null) url.searchParams.set(key, String(val));
    }

    const res = await fetch(url.toString(), { method: 'GET', headers: this.headers });

    if (!res.ok) {
      throw new OsosedkiError(`HTTP ${res.status}: ${res.statusText}`, res.status, url.toString());
    }

    return res.text();
  }

  parse(html) {
    return parseHtml(html);
  }

  async fetchAlbumCount(path) {
    try {
      const doc   = this.parse(await this.fetch(path));
      const h1    = doc.querySelector('h1');
      const ps    = Array.from(h1?.parentElement?.children || [])
                       .filter(el => el.tagName === 'P' && el !== h1);
      const text  = combinedText(ps) || (h1?.parentElement?.textContent || '');
      return extractInt(text.match(/(\d+)\s*albums?/i)?.[0] || '');
    } catch {
      return 0;
    }
  }

  galleryBasePath(galleryId) {
    const sep    = galleryId.indexOf('_');
    if (sep    === -1) return null;
    const folder = galleryId.slice(0, sep);
    const id     = galleryId.slice(sep + 1);
    return `${BASE_URL}/images/a/1280/${folder}/${id}`;
  }

  predictImageUrls(galleryId, count) {
    const base = this.galleryBasePath(galleryId);
    if (!base) return [];
    return Array.from({ length: count }, (_, i) => `${base}/${i + 1}.webp`);
  }

  async imageExists(url) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: this.headers });
      return res.ok;
    } catch {
      return false;
    }
  }

  async probeGalleryImageUrls(galleryId, expectedCount = 50, scanStep = 1, maxIndex = 2000) {
    const base = this.galleryBasePath(galleryId);
    if (!base) return { urls: [], startIndex: -1, endIndex: -1 };

    const cap = Math.min(maxIndex, expectedCount > 0 ? expectedCount * 3 : maxIndex);

    let startIndex = -1;
    for (let i = 1; i <= cap; i += scanStep) {
      if (await this.imageExists(`${base}/${i}.webp`)) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) return { urls: [], startIndex: -1, endIndex: -1 };

    const urls = [`${base}/${startIndex}.webp`];
    let endIndex = startIndex;

    for (let i = startIndex + 1; i <= cap; i++) {
      if (await this.imageExists(`${base}/${i}.webp`)) {
        urls.push(`${base}/${i}.webp`);
        endIndex = i;
      } else {
        break;
      }
    }

    return { urls, startIndex, endIndex };
  }

  async getHome(page = 1) {
    const doc = this.parse(await this.fetch('/', { page }));
    return {
      albums:     parseAlbums(doc),
      pagination: { ...parsePagination(doc), currentPage: page },
    };
  }

  async search(query, page = 1) {
    if (!query?.trim()) throw new OsosedkiError('Search query is required');

    const doc = this.parse(await this.fetch('/search', { q: query.trim(), page }));
    const pageText = combinedText(doc.querySelectorAll('h1, .page-title')) || doc.title;
    const countMatch = pageText.match(/\((\d+)\s*results?\)/);

    return {
      query,
      totalResults: countMatch ? parseInt(countMatch[1], 10) : null,
      albums:       parseAlbums(doc),
      pagination:   { ...parsePagination(doc), currentPage: page },
    };
  }

  async getCosplayCharacters(page = 1) {
    const doc = this.parse(await this.fetch('/cosplays', { page }));

    const headerText = combinedText(doc.querySelectorAll('h1, .page-title')) || doc.body.textContent;
    const countMatch = headerText.match(/([\d,]+)\s*characters?/);
    const characters = parseCharacters(doc);

    // Only fetch album counts for characters that didn't have them in the listing
    const needsHydration = characters.filter(c => c.albumCount == null);
    const BATCH = 10;

    for (let i = 0; i < needsHydration.length; i += BATCH) {
      const batch = needsHydration.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async char => {
          char.albumCount = await this.fetchAlbumCount(`/cosplay/${char.encodedName}`);
        }),
      );
    }

    return {
      totalCharacters: countMatch ? extractInt(countMatch[1]) : null,
      characters,
      pagination:      { ...parsePagination(doc), currentPage: page },
    };
  }

  async getCharacter(name, page = 1) {
    if (!name?.trim()) throw new OsosedkiError('Character name is required');

    const encoded = encodeURIComponent(name.trim());
    const doc = this.parse(await this.fetch(`/cosplay/${encoded}`, { page }));

    const h1         = doc.querySelector('h1');
    const h1Text     = h1 ? h1.textContent : '';
    const psText     = combinedText(Array.from(h1?.parentElement?.children || [])
                              .filter(el => el.tagName === 'P' && el !== h1));
    const albumCount = extractInt((psText || h1?.parentElement?.textContent || '').match(/(\d+)\s*albums?/i)?.[0] || '');

    const breadcrumbEl = doc.querySelector('.breadcrumb, [class*="breadcrumb"]');
    const breadcrumb   = breadcrumbEl ? breadcrumbEl.textContent : '';
    let displayName    = name.trim();
    if (breadcrumb) {
      const parts = breadcrumb.split('/').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) displayName = parts[parts.length - 1];
    }

    return {
      character:  { name: displayName, encodedName: encoded, albumCount, url: `${BASE_URL}/cosplay/${encoded}` },
      albums:     parseAlbums(doc),
      pagination: { ...parsePagination(doc), currentPage: page },
    };
  }

  async getModel(name, page = 1) {
    if (!name?.trim()) throw new OsosedkiError('Model name is required');

    const encoded = encodeURIComponent(name.trim());
    const doc     = this.parse(await this.fetch(`/model/${encoded}`, { page }));

    const h1         = doc.querySelector('h1');
    const psText     = combinedText(Array.from(h1?.parentElement?.children || [])
                              .filter(el => el.tagName === 'P' && el !== h1));
    const albumCount = extractInt((psText || h1?.parentElement?.textContent || '').match(/(\d+)\s*albums?/i)?.[0] || '');

    return {
      model:      { name: name.trim(), encodedName: encoded, albumCount, url: `${BASE_URL}/model/${encoded}` },
      albums:     parseAlbums(doc),
      pagination: { ...parsePagination(doc), currentPage: page },
    };
  }

  async getFandom(name, page = 1) {
    if (!name?.trim()) throw new OsosedkiError('Fandom name is required');

    const encoded = encodeURIComponent(name.trim());
    const doc     = this.parse(await this.fetch(`/fandom/${encoded}`, { page }));

    const h1         = doc.querySelector('h1');
    const psText     = combinedText(Array.from(h1?.parentElement?.children || [])
                              .filter(el => el.tagName === 'P' && el !== h1));
    const albumCount = extractInt((psText || h1?.parentElement?.textContent || '').match(/(\d+)\s*albums?/i)?.[0] || '');

    return {
      fandom:     { name: name.trim(), encodedName: encoded, albumCount, url: `${BASE_URL}/fandom/${encoded}` },
      albums:     parseAlbums(doc),
      pagination: { ...parsePagination(doc), currentPage: page },
    };
  }

  async getGallery(id) {
    if (!id?.trim()) throw new OsosedkiError('Gallery ID is required');

    const galleryUrl = `${BASE_URL}/photos/${id}`;
    const doc        = this.parse(await this.fetch(`/photos/${id}`));

    const meta         = parseGalleryMeta(doc, galleryUrl);
    const images       = parseGalleryImages(doc);
    const allImageUrls = meta.imageCount > 0 ? this.predictImageUrls(id, meta.imageCount) : [];

    return { meta, images, allImageUrls };
  }

  async getGalleryImages(id, { countOverride = null, scanStep = 1, maxIndex = 2000 } = {}) {
    const gallery = await this.getGallery(id);
    const count   = countOverride ?? gallery.meta.imageCount ?? gallery.images.length;
    const { urls, startIndex, endIndex } = await this.probeGalleryImageUrls(id, count, scanStep, maxIndex);

    return { galleryId: id, imageUrls: urls, startIndex, endIndex, meta: gallery.meta };
  }
}

export function createClient(extraHeaders) {
  return new OsosedkiAPI(extraHeaders);
}