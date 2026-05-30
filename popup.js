/**
 * Popup UI Controller - YouTube Persian Subtitle Translator v2.0
 */

let installedModels = []; // populated dynamically from Ollama

const el = {
  statusDot:           document.getElementById('statusDot'),
  statusText:          document.getElementById('statusText'),
  ollamaStatus:        document.getElementById('ollamaStatus'),
  ollamaStatusText:    document.getElementById('ollamaStatusText'),
  modelSelect:         document.getElementById('modelSelect'),
  customModel:         document.getElementById('customModel'),
  ollamaUrl:           document.getElementById('ollamaUrl'),
  enabledCheckbox:     document.getElementById('enabledCheckbox'),
  hideOriginalCheckbox:document.getElementById('hideOriginalCheckbox'),
  saveBtn:             document.getElementById('saveBtn'),
  clearCacheBtn:       document.getElementById('clearCacheBtn'),
  downloadBtn:         document.getElementById('downloadBtn'),
  downloadMsg:         document.getElementById('downloadMsg')
};

let currentSettings = {};

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['enabled', 'model', 'ollamaUrl', 'hideOriginalSubtitles'], (result) => {
      currentSettings = {
        enabled:               result.enabled !== false,
        model:                 result.model || 'aya-expanse:8b',
        ollamaUrl:             result.ollamaUrl || 'http://localhost:11434/api/generate',
        hideOriginalSubtitles: result.hideOriginalSubtitles !== false
      };
      resolve(currentSettings);
    });
  });
}

function populateModelDropdown(models) {
  installedModels = models || [];
  const currentModel = currentSettings.model;

  el.modelSelect.innerHTML = '';

  if (installedModels.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'custom';
    opt.textContent = 'هیچ مدلی نصب نشده — Custom...';
    el.modelSelect.appendChild(opt);
  } else {
    installedModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      el.modelSelect.appendChild(opt);
    });
  }

  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'Custom Model...';
  el.modelSelect.appendChild(customOpt);

  // Select current model
  const isKnown = installedModels.some(m => m.name === currentModel);
  if (isKnown) {
    el.modelSelect.value = currentModel;
    el.customModel.style.display = 'none';
  } else if (currentModel) {
    el.modelSelect.value = 'custom';
    el.customModel.value = currentModel;
    el.customModel.style.display = 'block';
  }
}

function updateUI() {
  el.statusDot.classList.toggle('active', currentSettings.enabled);
  el.statusText.textContent = currentSettings.enabled ? 'فعال' : 'غیرفعال';

  // Model dropdown updated by populateModelDropdown (called after checkOllama)
  // If models not loaded yet, just set value directly
  if (installedModels.length > 0) {
    populateModelDropdown(installedModels);
  } else {
    el.ollamaUrl.value = currentSettings.ollamaUrl;
  }

  el.ollamaUrl.value = currentSettings.ollamaUrl;
  el.enabledCheckbox.checked = currentSettings.enabled;
  el.hideOriginalCheckbox.checked = currentSettings.hideOriginalSubtitles;
}

async function saveSettings() {
  let model = el.modelSelect.value;
  if (model === 'custom') {
    model = el.customModel.value.trim();
    if (!model) { alert('لطفاً نام مدل را وارد کنید'); return; }
  }

  const ollamaUrl = el.ollamaUrl.value.trim();
  try { new URL(ollamaUrl); } catch (e) { alert('آدرس Ollama نامعتبر است'); return; }

  const settings = {
    enabled: el.enabledCheckbox.checked,
    model,
    ollamaUrl,
    hideOriginalSubtitles: el.hideOriginalCheckbox.checked
  };

  chrome.storage.sync.set(settings, () => {
    currentSettings = settings;
    updateUI();

    const orig = el.saveBtn.textContent;
    el.saveBtn.textContent = '✓ ذخیره شد!';
    el.saveBtn.style.background = '#28a745';
    setTimeout(() => { el.saveBtn.textContent = orig; el.saveBtn.style.background = ''; }, 2000);

    setTimeout(checkOllamaStatus, 400);
  });
}

// ─── Ollama Status ────────────────────────────────────────────────────────────

async function checkOllamaStatus() {
  el.ollamaStatus.style.display = 'block';
  el.ollamaStatusText.innerHTML = '<span class="loading"></span> در حال بررسی...';

  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'checkOllama' }, resolve);
    });

    if (response?.available) {
      el.ollamaStatus.className = 'ollama-status connected';
      const models = response.models || [];
      const names = models.map(m => m.name).slice(0, 4).join(', ');
      const extra = models.length > 4 ? ` +${models.length - 4} مدل دیگه` : '';
      el.ollamaStatusText.textContent = `✓ متصل — ${models.length} مدل: ${names}${extra}`;

      // Populate model dropdown with actual installed models
      populateModelDropdown(models);
    } else {
      el.ollamaStatus.className = 'ollama-status error';
      el.ollamaStatusText.textContent = '✗ Ollama در دسترس نیست — ollama serve را اجرا کنید';
    }
  } catch (e) {
    el.ollamaStatus.className = 'ollama-status error';
    el.ollamaStatusText.textContent = `✗ خطا: ${e.message}`;
  }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

async function clearCache() {
  if (!confirm('کش ترجمه‌ها پاک شود؟')) return;
  chrome.runtime.sendMessage({ action: 'clearCache' }, (response) => {
    if (response?.success) {
      const orig = el.clearCacheBtn.textContent;
      el.clearCacheBtn.textContent = '✓ پاک شد!';
      setTimeout(() => { el.clearCacheBtn.textContent = orig; }, 2000);
    }
  });
}

// ─── Download ─────────────────────────────────────────────────────────────────

function showDownloadMsg(text, type) {
  el.downloadMsg.textContent = text;
  el.downloadMsg.className = `download-msg ${type}`;
  el.downloadMsg.style.display = 'block';
  setTimeout(() => { el.downloadMsg.style.display = 'none'; }, 5000);
}

async function getActiveYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.includes('youtube.com/watch')) return tab;
  return null;
}

async function updateDownloadButton() {
  try {
    const tab = await getActiveYouTubeTab();
    if (!tab) {
      el.downloadBtn.disabled = true;
      showDownloadMsg('یک ویدیوی یوتیوب را باز کنید', 'warning');
      return;
    }

    const status = await chrome.tabs.sendMessage(tab.id, { action: 'getSubtitleStatus' }).catch(() => null);

    if (!status?.hasSubtitles || !status?.userConfirmed) {
      el.downloadBtn.disabled = true;
      if (status?.hasSubtitles === false) showDownloadMsg('زیرنویس بارگذاری نشده', 'warning');
      return;
    }

    if (status.translatedCount === 0) {
      el.downloadBtn.disabled = true;
      showDownloadMsg('در انتظار ترجمه...', 'warning');
      return;
    }

    el.downloadBtn.disabled = false;
    const pct = Math.round((status.translatedCount / status.totalCount) * 100);
    showDownloadMsg(`✅ ${status.translatedCount}/${status.totalCount} زیرنویس آماده (${pct}%)`, 'success');
  } catch (e) {
    el.downloadBtn.disabled = true;
  }
}

async function handleDownload() {
  el.downloadBtn.disabled = true;
  el.downloadBtn.textContent = '⏳ در حال بررسی...';

  try {
    const tab = await getActiveYouTubeTab();
    if (!tab) {
      showDownloadMsg('❌ یک ویدیوی یوتیوب را باز کنید', 'error');
      el.downloadBtn.textContent = '⬇️ دانلود زیرنویس فارسی (VTT)';
      el.downloadBtn.disabled = false;
      return;
    }

    const status = await chrome.tabs.sendMessage(tab.id, { action: 'getSubtitleStatus' }).catch(() => null);

    if (!status?.hasSubtitles) {
      showDownloadMsg('❌ ابتدا ترجمه را شروع کنید', 'error');
    } else if (!status.userConfirmed) {
      showDownloadMsg('❌ ترجمه هنوز تأیید نشده', 'warning');
    } else if (status.translatedCount === 0) {
      showDownloadMsg('❌ هنوز ترجمه‌ای آماده نیست', 'warning');
    } else {
      const pct = Math.round((status.translatedCount / status.totalCount) * 100);
      el.downloadBtn.textContent = `⏳ ${status.translatedCount}/${status.totalCount} (${pct}%)`;

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'downloadSubtitle' }).catch(() => null);
      if (response?.success) {
        showDownloadMsg(`✅ دانلود شد! (${response.translatedCount}/${response.totalCount})`, 'success');
        el.downloadBtn.textContent = '✅ دانلود شد!';
        setTimeout(() => {
          el.downloadBtn.textContent = '⬇️ دانلود زیرنویس فارسی (VTT)';
          el.downloadBtn.disabled = false;
        }, 2500);
        return;
      } else {
        showDownloadMsg('❌ دانلود ناموفق بود', 'error');
      }
    }

    el.downloadBtn.textContent = '⬇️ دانلود زیرنویس فارسی (VTT)';
    el.downloadBtn.disabled = false;

  } catch (e) {
    showDownloadMsg(`❌ خطا: ${e.message}`, 'error');
    el.downloadBtn.textContent = '⬇️ دانلود زیرنویس فارسی (VTT)';
    el.downloadBtn.disabled = false;
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initialize() {
  await loadSettings();
  updateUI();
  checkOllamaStatus();
  updateDownloadButton();

  el.saveBtn.addEventListener('click', saveSettings);
  el.clearCacheBtn.addEventListener('click', clearCache);
  el.downloadBtn.addEventListener('click', handleDownload);
  el.modelSelect.addEventListener('change', () => {
    const isCustom = el.modelSelect.value === 'custom';
    el.customModel.style.display = isCustom ? 'block' : 'none';
    if (isCustom) el.customModel.focus();
  });
  el.customModel.addEventListener('keypress', (e) => { if (e.key === 'Enter') saveSettings(); });
}

document.addEventListener('DOMContentLoaded', initialize);
