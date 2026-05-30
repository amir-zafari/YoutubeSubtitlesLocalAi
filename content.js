/**
 * Content Script - YouTube Persian Subtitle Translator (v2.1)
 * اولویت ۱: ترجمه زنده (Live DOM) — فوری، برای همه ویدیوها
 * اولویت ۲: ترجمه از فایل (Pre-fetch) — اگه API جواب داد، سوییچ می‌کنه
 */

const TAG = '[🇮🇷 Persian]';
const log  = (msg, ...a) => console.log(`${TAG} ${msg}`, ...a);
const logW = (msg, ...a) => console.warn(`${TAG} ⚠️ ${msg}`, ...a);
const logE = (msg, ...a) => console.error(`${TAG} ❌ ${msg}`, ...a);

let state = {
  isEnabled: true,
  currentVideoId: null,
  overlayElement: null,
  hideOriginal: true,
  isExtensionValid: true,
  userConfirmed: false,

  subtitleTrack: [],
  translatedSubtitles: new Map(),
  sourceLang: 'English',

  isTranslating: false,
  translationQueue: [],

  videoElement: null,
  syncInterval: null,
  currentSubtitleIndex: -1
};

const CONFIG = {
  INITIAL_BATCH_SIZE: 10,
  SUBSEQUENT_BATCH_SIZE: 15,
  SYNC_INTERVAL: 100,
  PREFETCH_THRESHOLD: 5,
  SELECTORS: {
    videoPlayer: '.html5-video-player',
    video: 'video.html5-main-video',
    captionWindow: '.caption-window'
  }
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function isExtensionContextValid() {
  try { return !!chrome?.runtime?.id; } catch (e) { return false; }
}

function getCurrentVideoId() {
  return new URLSearchParams(window.location.search).get('v');
}

function getVideoElement() {
  return document.querySelector(CONFIG.SELECTORS.video);
}

function isPlayingAd() {
  return !!(
    document.querySelector('.ytp-ad-player-overlay') ||
    document.querySelector('.ytp-ad-text') ||
    document.querySelector('.ytp-ad-skip-button') ||
    document.querySelector('#movie_player.ad-showing') ||
    document.querySelector('.html5-video-player.ad-showing')
  );
}

// ─── Player Response (robust, waits for correct video ID) ────────────────────

async function getPlayerResponse() {
  const currentVideoId = getCurrentVideoId();
  const maxAttempts = 20;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Method 1: window.ytInitialPlayerResponse
      const wr = window.ytInitialPlayerResponse;
      if (wr) {
        const wrId = wr?.videoDetails?.videoId;
        if (!currentVideoId || wrId === currentVideoId) {
          return wr;
        }
      }

      // Method 2: Parse from <script> tags using brace counting
      const scripts = document.getElementsByTagName('script');
      for (const script of scripts) {
        const content = script.textContent;
        if (!content.includes('ytInitialPlayerResponse')) continue;

        const startPattern = /(?:var )?ytInitialPlayerResponse\s*=\s*/;
        const startMatch = content.match(startPattern);
        if (!startMatch) continue;

        const startIndex = startMatch.index + startMatch[0].length;
        let braceCount = 0, inString = false, escapeNext = false, jsonStr = '';

        for (let i = startIndex; i < content.length; i++) {
          const char = content[i];
          if (escapeNext) { jsonStr += char; escapeNext = false; continue; }
          if (char === '\\') { jsonStr += char; escapeNext = true; continue; }
          if (char === '"') inString = !inString;
          jsonStr += char;
          if (!inString) {
            if (char === '{') braceCount++;
            else if (char === '}') {
              braceCount--;
              if (braceCount === 0) {
                try {
                  const parsed = JSON.parse(jsonStr);
                  const parsedId = parsed?.videoDetails?.videoId;
                  if (!currentVideoId || parsedId === currentVideoId) return parsed;
                } catch (e) {}
                break;
              }
            }
          }
        }
      }

      // Method 3: ytplayer.config
      if (window.ytplayer?.config) {
        const pr = window.ytplayer.config.args?.player_response;
        if (pr) {
          const parsed = typeof pr === 'string' ? JSON.parse(pr) : pr;
          const parsedId = parsed?.videoDetails?.videoId;
          if (!currentVideoId || parsedId === currentVideoId) return parsed;
        }
      }
    } catch (e) {
      console.warn(`getPlayerResponse attempt ${attempt + 1} failed:`, e.message);
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.error('❌ Could not get player response for video:', currentVideoId);
  return null;
}

// ─── Subtitle Fetching ───────────────────────────────────────────────────────

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]*>/g, '')
    .replace(/\[.*?\]/g, '')
    .trim();
}

function parseXmlSubtitles(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
  if (xmlDoc.querySelector('parsererror')) return null;

  const elements = xmlDoc.getElementsByTagName('text');
  if (elements.length === 0) return null;

  const subtitles = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const start = parseFloat(el.getAttribute('start'));
    const dur = parseFloat(el.getAttribute('dur') || '0');
    const text = decodeXmlEntities(el.textContent);
    if (text) subtitles.push({ index: i, start, end: start + dur, text });
  }
  return subtitles.length > 0 ? subtitles : null;
}

function parseJson3Captions(events) {
  const subtitles = [];
  let index = 0;
  for (const event of events) {
    if (!event.segs) continue;
    const start = event.tStartMs / 1000;
    const dur = (event.dDurationMs || 0) / 1000;
    const text = event.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').replace(/\[.*?\]/g, '').trim();
    if (text) subtitles.push({ index: index++, start, end: start + dur, text });
  }
  return subtitles.length > 0 ? subtitles : null;
}

function cleanTimedtextUrl(url) {
  // Strip params that cause 403 for extension fetches (PoToken required)
  try {
    const u = new URL(url);
    ['exp', 'xoaf', 'sparams', 'sig', 'lsparams', 'lsig'].forEach(p => u.searchParams.delete(p));
    u.searchParams.delete('fmt'); // let YouTube return default XML format
    return u.toString();
  } catch (e) {
    return url;
  }
}

function buildMinimalTimedtextUrl(originalUrl) {
  // Build the minimal URL keeping only essential params: v, lang, kind, name
  try {
    const orig = new URL(originalUrl);
    const minimal = new URL('https://www.youtube.com/api/timedtext');
    ['v', 'lang', 'kind', 'name', 'tlang'].forEach(p => {
      const val = orig.searchParams.get(p);
      if (val) minimal.searchParams.set(p, val);
    });
    return minimal.toString();
  } catch (e) {
    return null;
  }
}

async function fetchFromUrl(url) {
  const urlsToTry = [
    url,
    cleanTimedtextUrl(url),
    buildMinimalTimedtextUrl(url)
  ].filter((u, i, arr) => u && arr.indexOf(u) === i); // deduplicate

  for (const tryUrl of urlsToTry) {
    try {
      const response = await fetch(tryUrl);
      if (!response.ok) continue;

      const text = await response.text();
      if (!text || !text.trim()) continue;

      // Try XML
      const xmlResult = parseXmlSubtitles(text);
      if (xmlResult) { console.log('✅ Got XML subtitles from:', tryUrl.substring(0, 80)); return xmlResult; }

      // Try JSON3
      try {
        const json = JSON.parse(text);
        if (json.events) {
          const j3 = parseJson3Captions(json.events);
          if (j3) return j3;
        }
      } catch (e) {}
    } catch (e) {}
  }

  return null;
}

function pickBestTrack(tracks) {
  if (!tracks || tracks.length === 0) return null;
  // Priority: manual English > auto English > manual any > auto any
  return tracks.find(t => (t.languageCode === 'en' || t.languageCode?.startsWith('en')) && !t.kind)
    || tracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en'))
    || tracks.find(t => !t.kind)
    || tracks[0];
}

function getLangLabel(track) {
  return track?.name?.simpleText
    || track?.name?.runs?.[0]?.text
    || track?.languageCode
    || 'Unknown';
}

async function fetchSubtitleTrack(videoId) {
  log('📡 fetchSubtitleTrack() started for:', videoId);

  // ── Method 1: Player response captionTracks baseUrl
  const playerResponse = await getPlayerResponse();
  if (playerResponse) {
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks && tracks.length > 0) {
      console.log(`📋 Available tracks: ${tracks.map(t => t.languageCode).join(', ')}`);
      const track = pickBestTrack(tracks);
      if (track?.baseUrl) {
        const label = getLangLabel(track);
        console.log(`📡 Method 1: Using track "${label}" (${track.languageCode})`);
        const result = await fetchFromUrl(track.baseUrl);
        if (result) {
          state.sourceLang = label;
          console.log(`✅ Loaded ${result.length} subtitles in "${label}"`);
          return result;
        }
      }
    }
  }

  // ── Method 2: YouTube timedtext list API — try English first, then any
  console.log('⚠️ Method 2: Trying timedtext list API...');
  try {
    const listResponse = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${videoId}`);
    const listXml = await listResponse.text();
    if (listXml) {
      const listDoc = new DOMParser().parseFromString(listXml, 'text/xml');
      const trackEls = Array.from(listDoc.getElementsByTagName('track'));

      // Try English first, then fallback to any language
      const candidates = [
        ...trackEls.filter(t => { const l = t.getAttribute('lang_code'); return l === 'en' || l?.startsWith('en'); }),
        ...trackEls.filter(t => { const l = t.getAttribute('lang_code'); return l !== 'en' && !l?.startsWith('en'); })
      ];

      for (const t of candidates) {
        const lang = t.getAttribute('lang_code');
        const name = t.getAttribute('lang_original') || lang;
        const result = await fetchFromUrl(`https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}`);
        if (result) {
          state.sourceLang = name;
          console.log(`✅ Loaded ${result.length} subtitles in "${name}" (method 2)`);
          return result;
        }
      }
    }
  } catch (e) {}

  // ── Method 3: Try common lang codes directly
  console.log('⚠️ Method 3: Trying common language codes...');
  for (const lang of ['en', 'en-US', 'en-GB', 'a.en', 'hi', 'fa', 'ar', 'fr', 'de', 'es', 'zh', 'pt', 'ru', 'ja', 'ko']) {
    const result = await fetchFromUrl(`https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}`);
    if (result) {
      state.sourceLang = lang;
      console.log(`✅ Loaded ${result.length} subtitles with lang=${lang}`);
      return result;
    }
  }

  console.error('❌ No subtitles found for this video in any language');
  return null;
}

// ─── UI Elements ─────────────────────────────────────────────────────────────

function showConfirmationDialog() {
  return new Promise((resolve) => {
    document.getElementById('persian-translate-confirm-dialog')?.remove();
    document.getElementById('persian-translate-backdrop')?.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'persian-translate-backdrop';
    Object.assign(backdrop.style, {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      background: 'rgba(0,0,0,0.5)', zIndex: '9999'
    });

    const dialog = document.createElement('div');
    dialog.id = 'persian-translate-confirm-dialog';
    Object.assign(dialog.style, {
      position: 'fixed', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)', zIndex: '10000',
      background: 'white', padding: '30px', borderRadius: '12px',
      boxShadow: '0 10px 40px rgba(0,0,0,0.3)', maxWidth: '400px',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    });

    dialog.innerHTML = `
      <div style="text-align:center;">
        <div style="font-size:48px;margin-bottom:16px;">🇮🇷</div>
        <h2 style="margin:0 0 12px;color:#333;font-size:20px;">ترجمه زیرنویس به فارسی</h2>
        <p style="margin:0 0 24px;color:#666;font-size:14px;line-height:1.5;">
          آیا می‌خواهید زیرنویس این ویدیو به فارسی ترجمه شود؟
        </p>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="confirm-yes" style="padding:12px 24px;background:#667eea;color:white;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">بله، ترجمه کن</button>
          <button id="confirm-no" style="padding:12px 24px;background:#f0f0f0;color:#555;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">خیر</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);

    const cleanup = () => { dialog.remove(); backdrop.remove(); };

    dialog.querySelector('#confirm-yes').addEventListener('click', () => { cleanup(); resolve(true); });
    dialog.querySelector('#confirm-no').addEventListener('click', () => { cleanup(); resolve(false); });
    backdrop.addEventListener('click', () => { cleanup(); resolve(false); });
  });
}

function showLoadingIndicator(message = 'در حال دریافت زیرنویس...') {
  document.getElementById('persian-translate-loading')?.remove();

  const el = document.createElement('div');
  el.id = 'persian-translate-loading';
  Object.assign(el.style, {
    position: 'fixed', top: '20px', right: '20px', zIndex: '10000',
    background: 'rgba(0,0,0,0.85)', color: 'white', padding: '14px 20px',
    borderRadius: '8px', fontSize: '14px', display: 'flex',
    alignItems: 'center', gap: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
  });
  el.innerHTML = `<div style="width:16px;height:16px;border:2px solid #f3f3f3;border-top:2px solid #667eea;border-radius:50%;animation:spin 1s linear infinite;"></div><span>${message}</span>`;

  if (!document.getElementById('persian-spin-style')) {
    const style = document.createElement('style');
    style.id = 'persian-spin-style';
    style.textContent = '@keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  document.body.appendChild(el);
  return el;
}

function updateLoadingMessage(msg) {
  const el = document.getElementById('persian-translate-loading');
  if (el) { const span = el.querySelector('span'); if (span) span.textContent = msg; }
}

function hideLoadingIndicator() {
  document.getElementById('persian-translate-loading')?.remove();
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

function createOverlayElement() {
  state.overlayElement?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'persian-subtitle-overlay';
  overlay.setAttribute('dir', 'rtl');
  overlay.addEventListener('mouseenter', () => { isMouseOverOverlay = true; });
  overlay.addEventListener('mouseleave', () => { isMouseOverOverlay = false; });
  const player = document.querySelector(CONFIG.SELECTORS.videoPlayer);
  if (player) { player.appendChild(overlay); state.overlayElement = overlay; }
  return overlay;
}

function updateOverlay(translation) {
  if (!state.overlayElement) createOverlayElement();
  if (!state.overlayElement) return;

  if (translation) {
    state.overlayElement.textContent = translation;
    state.overlayElement.style.opacity = '1';
    state.overlayElement.style.display = '';
  } else {
    state.overlayElement.style.opacity = '0';
    setTimeout(() => { if (state.overlayElement) state.overlayElement.textContent = ''; }, 200);
  }
}

function toggleOriginalSubtitles(hide) {
  // Pre-fetch mode: hide/show caption windows
  document.querySelectorAll(CONFIG.SELECTORS.captionWindow).forEach(w => {
    w.style.display = hide ? 'none' : '';
  });
  // Live mode: use CSS injection (more reliable against YouTube re-renders)
  if (hide) injectHideStyle(); else removeHideStyle();
}

// ─── Translation ──────────────────────────────────────────────────────────────

function createBatchPrompt(batch) {
  const lines = batch.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  const fromLang = state.sourceLang || 'English';
  return `Translate the following ${fromLang} subtitles into natural, conversational Persian (Farsi).
Translate each line separately and return them with the same number prefix.
Return ONLY the numbered translations, no explanations.

${lines}`;
}

function parseBatchResponse(responseText, expectedCount) {
  const lines = responseText.split('\n').filter(l => l.trim());
  const translations = [];

  for (let i = 0; i < expectedCount; i++) {
    const numbered = lines.find(l => l.match(new RegExp(`^${i + 1}[.\\-)]\\s*`)));
    if (numbered) {
      translations.push(numbered.replace(/^\d+[.\-)\s]+/, '').trim());
    } else if (lines[i]) {
      translations.push(lines[i].trim());
    } else {
      translations.push('');
    }
  }
  return translations;
}

async function batchTranslate(subtitles, startIndex, batchSize) {
  const batch = subtitles.slice(startIndex, startIndex + batchSize);
  if (batch.length === 0) return [];

  log(`📦 Batch [${startIndex}–${startIndex + batch.length - 1}] — translating ${batch.length} lines:`);
  batch.forEach((s, i) => log(`  ${startIndex + i}: "${s.text}"`));

  const prompt = createBatchPrompt(batch);

  try {
    if (!isExtensionContextValid()) throw new Error('Extension context invalid');

    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'batchTranslate', prompt, count: batch.length }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.success) resolve(res);
        else reject(new Error(res?.error || 'Translation failed'));
      });
    });

    return parseBatchResponse(response.translation, batch.length);

  } catch (error) {
    console.error('Batch translation error, falling back to individual:', error.message);
    const results = [];
    for (const sub of batch) {
      try {
        const t = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ action: 'translate', text: sub.text }, (res) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (res?.success) resolve(res.translation);
            else reject(new Error(res?.error || 'Failed'));
          });
        });
        results.push(t);
      } catch (e) {
        results.push(sub.text);
      }
    }
    return results;
  }
}

async function processInitialBatch() {
  log(`📦 processInitialBatch() — translating first ${CONFIG.INITIAL_BATCH_SIZE} subtitles`);
  state.isTranslating = true;
  updateLoadingMessage(`در حال ترجمه ${CONFIG.INITIAL_BATCH_SIZE} زیرنویس اول...`);

  try {
    const translations = await batchTranslate(state.subtitleTrack, 0, CONFIG.INITIAL_BATCH_SIZE);
    translations.forEach((t, i) => state.translatedSubtitles.set(i, t));
    console.log(`✅ Initial batch done: ${translations.length} subtitles`);
    scheduleNextBatches();
    hideLoadingIndicator();
  } catch (error) {
    console.error('Initial batch failed:', error);
    updateLoadingMessage('❌ خطا در ترجمه. Ollama را بررسی کنید.');
    setTimeout(hideLoadingIndicator, 4000);
  } finally {
    state.isTranslating = false;
  }
}

function scheduleNextBatches() {
  let currentIndex = CONFIG.INITIAL_BATCH_SIZE;
  while (currentIndex < state.subtitleTrack.length) {
    const end = Math.min(currentIndex + CONFIG.SUBSEQUENT_BATCH_SIZE, state.subtitleTrack.length);
    state.translationQueue.push({ start: currentIndex, end });
    currentIndex = end;
  }
  processTranslationQueue();
}

async function processTranslationQueue() {
  if (state.translationQueue.length === 0 || state.isTranslating) return;
  state.isTranslating = true;

  while (state.translationQueue.length > 0) {
    const { start, end } = state.translationQueue.shift();
    try {
      const translations = await batchTranslate(state.subtitleTrack, start, end - start);
      translations.forEach((t, i) => state.translatedSubtitles.set(start + i, t));
      console.log(`✅ Background batch done: ${start}-${end - 1}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      console.error('Background batch error:', e);
    }
  }

  state.isTranslating = false;
  console.log('🎉 All translations complete!');
}

// ─── Sync with Video ──────────────────────────────────────────────────────────

function findSubtitleIndex(currentTime) {
  for (let i = 0; i < state.subtitleTrack.length; i++) {
    const s = state.subtitleTrack[i];
    if (currentTime >= s.start && currentTime <= s.end) return i;
  }
  return -1;
}

function syncWithVideo() {
  if (!state.videoElement || !state.isEnabled || !state.userConfirmed) return;

  if (isPlayingAd()) {
    if (state.overlayElement) state.overlayElement.style.display = 'none';
    return;
  }
  if (state.overlayElement && state.overlayElement.style.display === 'none') {
    state.overlayElement.style.display = '';
  }

  const currentTime = state.videoElement.currentTime;
  const idx = findSubtitleIndex(currentTime);

  if (idx !== state.currentSubtitleIndex) {
    state.currentSubtitleIndex = idx;

    if (idx >= 0) {
      const translation = state.translatedSubtitles.get(idx);
      if (translation) {
        updateOverlay(translation);
        // Prefetch if approaching end of translated range
        const translatedCount = state.translatedSubtitles.size;
        if (translatedCount - idx < CONFIG.PREFETCH_THRESHOLD && state.translationQueue.length > 0) {
          processTranslationQueue();
        }
      } else {
        updateOverlay('⏳ در حال ترجمه...');
        const batchStart = Math.floor(idx / CONFIG.INITIAL_BATCH_SIZE) * CONFIG.INITIAL_BATCH_SIZE;
        if (!state.isTranslating) {
          const alreadyQueued = state.translationQueue.some(b => b.start <= idx && b.end > idx);
          if (!alreadyQueued) state.translationQueue.unshift({ start: batchStart, end: batchStart + CONFIG.INITIAL_BATCH_SIZE });
          processTranslationQueue();
        }
      }
    } else {
      updateOverlay(null);
    }
  }
}

function startSync() {
  if (state.syncInterval) clearInterval(state.syncInterval);
  state.syncInterval = setInterval(syncWithVideo, CONFIG.SYNC_INTERVAL);
}

function stopSync() {
  if (state.syncInterval) { clearInterval(state.syncInterval); state.syncInterval = null; }
}

// ─── VTT Download ─────────────────────────────────────────────────────────────

function formatVTTTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function downloadVTTFile() {
  if (!state.subtitleTrack.length) return false;

  let vtt = 'WEBVTT\n\n';
  for (let i = 0; i < state.subtitleTrack.length; i++) {
    const sub = state.subtitleTrack[i];
    const trans = state.translatedSubtitles.get(i);
    if (!trans) continue;
    vtt += `${i + 1}\n${formatVTTTime(sub.start)} --> ${formatVTTTime(sub.end)}\n${trans}\n\n`;
  }

  const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() || state.currentVideoId;
  const fileName = `${title}_persian.vtt`.replace(/[/\\?%*:|"<>]/g, '-');

  const blob = new Blob([vtt], { type: 'text/vtt' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log('✅ Downloaded:', fileName);
  return true;
}

// ─── Live DOM Translation (fallback when API fails) ───────────────────────────

const liveCache = new Map();
let liveObserver = null;
let liveDebounceTimer = null;
let lastLiveText = '';

// Buffer mode: collect → auto-translate in background → show on pause
const LIVE_BUFFER_SIZE = 1;
let pendingCaptions = [];
let translatedQueue = [];
let isBackgroundTranslating = false;
let isShowingBuffered = false;
let videoPauseHandler = null;
let videoPlayHandler = null;
let pauseTranslationTimer = null;
let isMouseOverOverlay = false;

function injectHideStyle() {
  if (document.getElementById('persian-hide-captions')) return;
  const style = document.createElement('style');
  style.id = 'persian-hide-captions';
  style.textContent = '.caption-window { opacity: 0 !important; transition: none !important; }';
  document.head.appendChild(style);
}

function removeHideStyle() {
  document.getElementById('persian-hide-captions')?.remove();
}

function getCaptionText() {
  const segments = document.querySelectorAll('.ytp-caption-segment');
  if (!segments.length) return '';
  return Array.from(segments).map(s => s.textContent).join(' ').trim();
}

async function translateLive(text) {
  if (!isExtensionContextValid() || !state.isEnabled || !state.userConfirmed) return;

  if (liveCache.has(text)) {
    log(`💾 Cache hit: "${text.substring(0, 40)}..."`);
    updateOverlay(liveCache.get(text));
    return;
  }

  log(`📤 Sending to Ollama: "${text.substring(0, 60)}"`);
  updateOverlay('⏳');

  const t0 = Date.now();
  try {
    const translation = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'translate', text }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.success) resolve(res.translation);
        else reject(new Error(res?.error || 'Failed'));
      });
    });

    if (text === lastLiveText) {
      log(`📥 Translated in ${Date.now() - t0}ms: "${translation.substring(0, 60)}"`);
      liveCache.set(text, translation);
      if (liveCache.size > 300) liveCache.delete(liveCache.keys().next().value);
      updateOverlay(translation);
    } else {
      log(`🔁 Discarded stale translation (text changed while waiting)`);
    }
  } catch (e) {
    logE('Live translate failed:', e.message);
    if (text === lastLiveText) updateOverlay(null);
  }
}

function bufferCaption(text) {
  if (!state.isEnabled || !state.userConfirmed) return;
  const isDup = pendingCaptions.some(c => c.includes(text) || text.includes(c));
  if (!isDup) {
    pendingCaptions.push(text);
    log(`📝 Buffered (${pendingCaptions.length}): "${text.substring(0, 60)}"`);
    if (pendingCaptions.length >= LIVE_BUFFER_SIZE && !isBackgroundTranslating) {
      translateInBackground();
    }
  }
}

async function translateInBackground() {
  if (isBackgroundTranslating || pendingCaptions.length === 0) return;
  if (!isExtensionContextValid()) return;

  const batch = [...pendingCaptions];
  pendingCaptions = [];
  isBackgroundTranslating = true;
  log(`🔄 Background: translating ${batch.length} captions...`);

  for (const caption of batch) {
    if (!isExtensionContextValid()) break;
    if (liveCache.has(caption)) {
      translatedQueue.push(liveCache.get(caption));
      continue;
    }
    try {
      const translation = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'translate', text: caption }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (res?.success) resolve(res.translation);
          else reject(new Error(res?.error || 'Failed'));
        });
      });
      liveCache.set(caption, translation);
      translatedQueue.push(translation);
      log(`✅ Ready: "${translation.substring(0, 50)}"`);
    } catch (e) {
      logE('Background translate failed:', e.message);
    }
  }

  isBackgroundTranslating = false;
  if (pendingCaptions.length >= LIVE_BUFFER_SIZE) translateInBackground();
}

async function translateBufferedCaptions() {
  if (!state.userConfirmed || !state.isEnabled) return;
  if (lastLiveText) bufferCaption(lastLiveText);

  // Kick off any pending captions that haven't started translating yet
  if (pendingCaptions.length > 0 && !isBackgroundTranslating) {
    translateInBackground();
  }

  if (translatedQueue.length === 0 && !isBackgroundTranslating && pendingCaptions.length === 0) return;

  isShowingBuffered = true;
  if (state.overlayElement) state.overlayElement.style.pointerEvents = 'auto';
  log(`⏸️ Video paused — streaming translations as they arrive`);

  // Show each translation the moment it lands in translatedQueue — no blocking wait
  while (isShowingBuffered) {
    if (translatedQueue.length > 0) {
      const translation = translatedQueue.shift();
      log(`📥 Showing: "${translation.substring(0, 60)}"`);
      updateOverlay(translation);
      await new Promise(resolve => setTimeout(resolve, 2500));
      while (isMouseOverOverlay && isShowingBuffered) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else if (!isBackgroundTranslating && pendingCaptions.length === 0) {
      break; // all done
    } else {
      if (!isBackgroundTranslating && pendingCaptions.length > 0) translateInBackground();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (isShowingBuffered) updateOverlay(null);
  isShowingBuffered = false;
  if (state.overlayElement) state.overlayElement.style.pointerEvents = 'none';
}

function handleCaptionMutation() {
  if (isPlayingAd()) {
    if (lastLiveText) { log('📺 Ad playing — hiding overlay'); updateOverlay(null); lastLiveText = ''; }
    else log('📺 Ad detected — skipping caption');
    return;
  }

  const text = getCaptionText();
  if (!text && document.querySelectorAll('.ytp-caption-segment').length === 0) {
    const altText = Array.from(document.querySelectorAll('[class*="caption"]')).map(e => e.textContent).join(' ').trim();
    if (altText) log(`⚠️ Caption in unknown element: "${altText.substring(0, 60)}"`);
  }

  if (!text) {
    if (lastLiveText) {
      bufferCaption(lastLiveText); // sentence ended — save before clearing
      lastLiveText = '';
      updateOverlay(null);
    }
    return;
  }

  if (text === lastLiveText) return;

  log(`🎙️ New caption detected: "${text.substring(0, 70)}"`);

  // Detect rolling-window scroll: when the START of text changes, old words have been pushed off.
  // Save the previous text immediately before those words are lost forever.
  if (lastLiveText && lastLiveText.length > 15) {
    const oldStart = lastLiveText.substring(0, 15);
    if (!text.startsWith(oldStart) && !text.includes(oldStart)) {
      bufferCaption(lastLiveText);
    }
  }

  lastLiveText = text;
  clearTimeout(liveDebounceTimer);
  liveDebounceTimer = setTimeout(() => bufferCaption(text), 300);
}

let bodyWatcherObserver = null;

function attachCaptionObserver() {
  if (liveObserver) { liveObserver.disconnect(); liveObserver = null; }
  const container = document.querySelector('.ytp-caption-window-container');
  if (container) {
    liveObserver = new MutationObserver(handleCaptionMutation);
    liveObserver.observe(container, { childList: true, subtree: true, characterData: true });
    log('👁️ MutationObserver attached to caption container');
    return true;
  }
  return false;
}

function startLiveTranslation() {
  stopLiveTranslation();
  createOverlayElement();
  if (state.hideOriginal) injectHideStyle();

  // Attach pause/play handlers to buffer-and-translate on pause
  if (state.videoElement) {
    videoPauseHandler = () => {
      // Wait 500ms before translating — if video resumes within that time it was buffering, not a real pause
      clearTimeout(pauseTranslationTimer);
      pauseTranslationTimer = setTimeout(() => translateBufferedCaptions(), 500);
    };
    videoPlayHandler = () => {
      clearTimeout(pauseTranslationTimer);
      isShowingBuffered = false;
      pendingCaptions = [];
      translatedQueue = [];
      log('▶️ Video resumed — buffer cleared');
    };
    state.videoElement.addEventListener('pause', videoPauseHandler);
    state.videoElement.addEventListener('play', videoPlayHandler);
    log('⏸️ Pause/play handlers attached — buffer mode active');
  }

  if (!attachCaptionObserver()) {
    log('⏳ Caption container not found — waiting for CC to be enabled...');
  }

  // Body-level watcher: re-attach observer if YouTube recreates the caption container
  if (bodyWatcherObserver) bodyWatcherObserver.disconnect();
  let lastContainer = document.querySelector('.ytp-caption-window-container');
  bodyWatcherObserver = new MutationObserver(() => {
    const current = document.querySelector('.ytp-caption-window-container');
    if (current && current !== lastContainer) {
      log('🔄 Caption container recreated — re-attaching observer');
      lastContainer = current;
      attachCaptionObserver();
    } else if (current && !liveObserver) {
      lastContainer = current;
      attachCaptionObserver();
    }
  });
  bodyWatcherObserver.observe(document.body, { childList: true, subtree: true });
}

function stopLiveTranslation() {
  if (liveObserver) {
    liveObserver.disconnect();
    liveObserver = null;
    log('🛑 Live observer disconnected');
  }
  if (state.videoElement && videoPauseHandler) {
    state.videoElement.removeEventListener('pause', videoPauseHandler);
    state.videoElement.removeEventListener('play', videoPlayHandler);
    videoPauseHandler = null;
    videoPlayHandler = null;
  }
  if (bodyWatcherObserver) { bodyWatcherObserver.disconnect(); bodyWatcherObserver = null; }
  clearTimeout(liveDebounceTimer);
  clearTimeout(pauseTranslationTimer);
  removeHideStyle();
  lastLiveText = '';
  pendingCaptions = [];
  translatedQueue = [];
  isBackgroundTranslating = false;
  isShowingBuffered = false;
}

// ─── Cleanup & Init ───────────────────────────────────────────────────────────

function cleanup() {
  stopSync();
  stopLiveTranslation();
  state.overlayElement?.remove();
  state.overlayElement = null;
  hideLoadingIndicator();
  state.subtitleTrack = [];
  state.translatedSubtitles.clear();
  state.sourceLang = 'English';
  state.currentSubtitleIndex = -1;
  state.isTranslating = false;
  state.translationQueue = [];
  state.userConfirmed = false;
}

async function switchToPreFetch(subtitles) {
  log(`🔄 Switching live → pre-fetch (${subtitles.length} subtitles)`);
  stopLiveTranslation();

  state.subtitleTrack = subtitles;
  if (state.hideOriginal) toggleOriginalSubtitles(true);

  showLoadingIndicator(`🔄 ترجمه ${subtitles.length} زیرنویس در پس‌زمینه...`);
  await processInitialBatch();
  startSync();
  hideLoadingIndicator();
  log('✅ Pre-fetch mode active');
}

async function initialize() {
  if (!isExtensionContextValid()) { logE('Extension context invalid'); return; }

  log('🚀 Initializing... video:', getCurrentVideoId());
  cleanup();
  state.currentVideoId = getCurrentVideoId();

  let attempts = 0;
  const checkVideo = setInterval(async () => {
    attempts++;
    const video = getVideoElement();

    if (video) {
      clearInterval(checkVideo);
      state.videoElement = video;
      log('✅ Video element found');

      await new Promise(resolve => setTimeout(resolve, 600));

      state.userConfirmed = true;
      log('✅ Auto-start: no confirmation needed');

      createOverlayElement();

      // ── Priority 1: Start LIVE immediately ──
      log('🔴 [Mode: LIVE] Starting live translation...');
      startLiveTranslation();

      // ── Priority 2: Try API in background; switch if successful ──
      log('🔍 [Background] Fetching subtitle track via API...');
      fetchSubtitleTrack(state.currentVideoId).then(subtitles => {
        if (subtitles && subtitles.length > 0) {
          log(`🎉 [Background] API success — ${subtitles.length} subtitles. Switching to pre-fetch.`);
          switchToPreFetch(subtitles);
        } else {
          log('ℹ️ [Background] API returned no subtitles. Staying in live mode.');
        }
      }).catch(e => {
        logW('[Background] API fetch error:', e.message, '— staying in live mode');
      });

    } else if (attempts >= 30) {
      clearInterval(checkVideo);
      logW('Video element not found after 15s');
    }
  }, 500);
}

function handleNavigation() {
  const newId = getCurrentVideoId();
  if (newId && newId !== state.currentVideoId) {
    log('🔄 Navigation detected:', state.currentVideoId, '→', newId);
    setTimeout(initialize, 1200);
  }
}

// ─── Message Listeners ────────────────────────────────────────────────────────

if (isExtensionContextValid()) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled) {
      state.isEnabled = changes.enabled.newValue;
      if (!state.isEnabled) { updateOverlay(null); stopSync(); }
      else if (state.userConfirmed) startSync();
    }
    if (changes.hideOriginalSubtitles) {
      state.hideOriginal = changes.hideOriginalSubtitles.newValue;
      toggleOriginalSubtitles(state.hideOriginal);
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'toggle') {
      state.isEnabled = request.enabled;
      if (!state.isEnabled) { updateOverlay(null); stopSync(); }
      else if (state.userConfirmed) startSync();
      sendResponse({ success: true });
    }
    if (request.action === 'reinitialize') {
      initialize();
      sendResponse({ success: true });
    }
    if (request.action === 'downloadSubtitle') {
      sendResponse({
        success: downloadVTTFile(),
        translatedCount: state.translatedSubtitles.size,
        totalCount: state.subtitleTrack.length
      });
    }
    if (request.action === 'getSubtitleStatus') {
      sendResponse({
        success: true,
        hasSubtitles: state.subtitleTrack.length > 0,
        translatedCount: state.translatedSubtitles.size,
        totalCount: state.subtitleTrack.length,
        videoId: state.currentVideoId,
        userConfirmed: state.userConfirmed
      });
    }
    return true;
  });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

(function () {
  if (!isExtensionContextValid()) return;
  if (window.location.pathname !== '/watch') return;

  chrome.storage.sync.get(['enabled', 'hideOriginalSubtitles'], (result) => {
    state.isEnabled = result.enabled !== false;
    state.hideOriginal = result.hideOriginalSubtitles !== false;

    if (state.isEnabled) initialize();

    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) { lastUrl = url; handleNavigation(); }
    }).observe(document, { subtree: true, childList: true });
  });
})();
