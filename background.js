/**
 * Background Service Worker (Manifest V3)
 * Handles communication with local Ollama API
 */

const DEFAULT_CONFIG = {
  ollamaUrl: 'http://localhost:11434/api/generate',
  model: 'aya-expanse:8b',
  enabled: true,
  hideOriginalSubtitles: true
};

const REQUEST_DELAY = 100;
let requestQueue = [];
let isProcessing = false;

async function initializeSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG, ...stored };
}

class TranslationCache {
  constructor(maxSize = 500) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }

  has(key) { return this.cache.has(key); }
  clear() { this.cache.clear(); }
}

const cache = new TranslationCache();

function normalizeForCache(text) {
  return text.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,!?;:]/g, '');
}

function cleanTranslation(raw) {
  // Remove thinking tags from models like qwen3, deepseek-r1, etc.
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '') // unclosed think tag at start
    .trim();

  // Remove common prefixes models add despite instructions
  text = text
    .replace(/^(Persian|ترجمه|Translation|فارسی)\s*[:\-]\s*/i, '')
    .replace(/^["']|["']$/g, '') // strip surrounding quotes
    .trim();

  return text || raw.trim();
}

function generateTranslationPrompt(text) {
  return `/no_think Translate to Persian (Farsi). Reply with ONLY the translation, no explanation.

"${text}"`;
}

async function translateWithOllama(prompt, config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(config.ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt: prompt,
        stream: true,
        options: {
          temperature: 0.3,
          top_p: 0.9,
          num_predict: 300
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullTranslation = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n').filter(l => l.trim())) {
        try {
          const json = JSON.parse(line);
          if (json.response) fullTranslation += json.response;
          if (json.done) break;
        } catch (e) {}
      }
    }

    return cleanTranslation(fullTranslation);

  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Translation timeout');
    if (error.message.includes('Failed to fetch')) throw new Error('Cannot connect to Ollama on localhost:11434');
    throw error;
  }
}

async function processTranslation(text, config) {
  const cacheKey = normalizeForCache(text);
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`[Translation] 💾 Cache hit: "${text}"`);
    return { translation: cached, cached: true };
  }

  console.log(`[Translation] 🔄 Translating: "${text}"`);
  const t0 = Date.now();
  const translation = await translateWithOllama(generateTranslationPrompt(text), config);
  console.log(`[Translation] ✅ Done in ${Date.now() - t0}ms: "${text}" → "${translation}"`);
  cache.set(cacheKey, translation);
  return { translation, cached: false };
}

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const { text, config, sendResponse } = requestQueue.shift();
    try {
      const result = await processTranslation(text, config);
      try { sendResponse({ success: true, ...result }); } catch (e) {}
    } catch (error) {
      try { sendResponse({ success: false, error: error.message }); } catch (e) {}
    }
    if (requestQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }
  }

  isProcessing = false;
}

function safeSendResponse(sendResponse, data) {
  try { sendResponse(data); return true; } catch (e) { return false; }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'batchTranslate') {
    (async () => {
      try {
        const config = await initializeSettings();
        if (!config.enabled) {
          safeSendResponse(sendResponse, { success: false, error: 'Extension disabled' });
          return;
        }
        console.log(`[Translation] 📦 Batch translate — ${request.count} subtitles`);
        const t0 = Date.now();
        const translation = await translateWithOllama(request.prompt, config);
        console.log(`[Translation] ✅ Batch done in ${Date.now() - t0}ms`);
        safeSendResponse(sendResponse, { success: true, translation, cached: false });
      } catch (error) {
        safeSendResponse(sendResponse, { success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'translate') {
    (async () => {
      try {
        const config = await initializeSettings();
        if (!config.enabled) {
          safeSendResponse(sendResponse, { success: false, error: 'Extension disabled' });
          return;
        }
        requestQueue.push({ text: request.text, config, sendResponse });
        processQueue();
      } catch (error) {
        safeSendResponse(sendResponse, { success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'updateSettings') {
    chrome.storage.sync.set(request.settings, () => safeSendResponse(sendResponse, { success: true }));
    return true;
  }

  if (request.action === 'clearCache') {
    cache.clear();
    safeSendResponse(sendResponse, { success: true });
    return true;
  }

  if (request.action === 'getSettings') {
    initializeSettings()
      .then(settings => safeSendResponse(sendResponse, { success: true, settings }))
      .catch(error => safeSendResponse(sendResponse, { success: false, error: error.message }));
    return true;
  }

  if (request.action === 'checkOllama') {
    (async () => {
      try {
        const config = await initializeSettings();
        const response = await fetch(config.ollamaUrl.replace('/api/generate', '/api/tags'));
        if (response.ok) {
          const data = await response.json();
          safeSendResponse(sendResponse, { success: true, available: true, models: data.models || [] });
        } else {
          safeSendResponse(sendResponse, { success: true, available: false });
        }
      } catch (error) {
        safeSendResponse(sendResponse, { success: false, available: false, error: error.message });
      }
    })();
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.sync.set(DEFAULT_CONFIG);
    console.log('YouTube Persian Translator installed');
  } else if (details.reason === 'update') {
    cache.clear();
    console.log('YouTube Persian Translator updated');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') console.log('Settings updated:', Object.keys(changes));
});

// Keepalive for service worker — start immediately and keep running
setInterval(() => {
  chrome.storage.local.set({ keepalive: Date.now() });
}, 20000);

console.log('Background service worker initialized');
