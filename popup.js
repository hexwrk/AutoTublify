// popup.js

// INITIALISATION

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[AutoTublify] Popup initialised.');

  await loadSettings();
  setupEventListeners();
  updateStatus();
  setInterval(updateStatus, 3000);
});

// TAB NAVIGATION

function setupEventListeners() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // AUTOMATIC TAB - TEMPORARILY DISABLED
  // document.getElementById('autoMode')?.addEventListener('change', updateStatusDisplay);
  // document.getElementById('saveAutoSettings')?.addEventListener('click', saveAutoSettings);

  document.getElementById('processManual')?.addEventListener('click', processManualUrl);
  document.getElementById('manualUrl')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') processManualUrl();
  });

  document.getElementById('clearQueue')?.addEventListener('click', clearQueue);
  document.getElementById('saveSettings')?.addEventListener('click', saveSettings);
  document.getElementById('testApi')?.addEventListener('click', testApiConnection);
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tabName}`)?.classList.add('active');

  if (tabName === 'queue') updateQueue();
}

// SETTINGS — LOAD AND SAVE

async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get({
      enabled: true,
      autoMode: true,
      targetPlaylists: [],
      apiKey: '',
      saveLocation: 'YouTube Summaries/'
    });

    // AUTOMATIC TAB - COMMENTED OUT (feature in development)
    // const autoModeEl      = document.getElementById('autoMode');
    // const playlistsEl     = document.getElementById('targetPlaylists');
    // if (autoModeEl)     autoModeEl.checked      = settings.autoMode;
    // if (playlistsEl)    playlistsEl.value        = settings.targetPlaylists.join('\n');

    const apiKeyEl        = document.getElementById('apiKey');
    const saveLocationEl  = document.getElementById('saveLocation');

    if (apiKeyEl)       apiKeyEl.value           = settings.apiKey;
    if (saveLocationEl) saveLocationEl.value     = settings.saveLocation;

    console.log('[AutoTublify] Settings loaded.');
  } catch (error) {
    console.error('[AutoTublify] Error loading settings:', error);
  }
}

/* AUTOMATIC TAB FUNCTIONS - COMMENTED OUT FOR DEVELOPMENT

async function saveAutoSettings() {
  try {
    const autoMode   = document.getElementById('autoMode')?.checked;
    const rawText    = document.getElementById('targetPlaylists')?.value || '';

    const targetPlaylists = rawText
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    await chrome.storage.local.set({ autoMode, targetPlaylists });

    showStatus('autoStatus', 'Settings saved successfully.', 'success');
    updateStatusDisplay();

    console.log('[AutoTublify] Auto settings saved.');
  } catch (error) {
    console.error('[AutoTublify] Error saving auto settings:', error);
    showStatus('autoStatus', `Save failed: ${error.message}`, 'error');
  }
}

END OF AUTOMATIC TAB FUNCTIONS */

async function saveSettings() {
  const apiKey      = document.getElementById('apiKey')?.value.trim();
  const saveLocation = document.getElementById('saveLocation')?.value.trim();

  if (!apiKey) {
    showStatus('settingsStatus', 'API key is required.', 'error');
    return;
  }

  if (!apiKey.startsWith('sk-ant-')) {
    showStatus('settingsStatus', 'Invalid API key format. Anthropic keys begin with "sk-ant-".', 'error');
    return;
  }

  if (!saveLocation) {
    showStatus('settingsStatus', 'Save location cannot be empty.', 'error');
    return;
  }

  try {
    const normalisedLocation = saveLocation.endsWith('/') ? saveLocation : saveLocation + '/';

    await chrome.storage.local.set({
      apiKey,
      saveLocation: normalisedLocation
    });

    showStatus('settingsStatus', 'Settings saved successfully.', 'success');
    console.log('[AutoTublify] Settings saved.');
  } catch (error) {
    console.error('[AutoTublify] Error saving settings:', error);
    showStatus('settingsStatus', `Save failed: ${error.message}`, 'error');
  }
}

// API CONNECTION TEST

async function testApiConnection() {
  const btn = document.getElementById('testApi');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Testing...';

  try {
    const settings = await chrome.storage.local.get({ apiKey: '' });

    if (!settings.apiKey) {
      throw new Error('No API key configured.');
    }

    const testPrompt = 'Reply with "API connection successful" if you receive this message.';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 100,
        temperature: 0.3,
        messages: [{ role: 'user', content: testPrompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.content || data.content.length === 0) {
      throw new Error('Invalid API response format');
    }

    showStatus('settingsStatus', 'API connection verified successfully.', 'success');

  } catch (error) {
    console.error('[AutoTublify] API test failed:', error);
    showStatus('settingsStatus', `Connection test failed: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// MANUAL URL PROCESSING

async function processManualUrl() {
  const urlInput = document.getElementById('manualUrl');
  const btn      = document.getElementById('processManual');
  const url      = urlInput?.value.trim();

  if (!url) {
    showStatus('manualStatus', 'Please enter a YouTube URL.', 'error');
    return;
  }

  if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) {
    showStatus('manualStatus', 'Invalid YouTube URL. Expected format: https://www.youtube.com/watch?v=...', 'error');
    return;
  }

  const settings = await chrome.storage.local.get({ apiKey: '' });
  if (!settings.apiKey) {
    showStatus('manualStatus', 'No API key configured. Please complete setup in the Settings tab.', 'error');
    switchTab('settings');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Processing...';
  showStatus('manualStatus', 'Video queued for processing.', 'success');

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'PROCESS_VIDEO_URL',
      data: { url }
    });

    console.log('[AutoTublify] Manual URL response:', response);

    if (urlInput) urlInput.value = '';
    
    // Force queue update before switching tabs
    await updateQueue();
    
    setTimeout(() => {
      switchTab('queue');
      updateQueue(); // Update again after switching
    }, 500);

  } catch (error) {
    console.error('[AutoTublify] Manual processing error:', error);
    showStatus('manualStatus', `Error: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Summary';
  }
}

// QUEUE DISPLAY AND MANAGEMENT

async function updateQueue() {
  try {
    console.log('[AutoTublify Popup] Requesting queue status...');
    const response = await chrome.runtime.sendMessage({ type: 'GET_QUEUE_STATUS' });
    console.log('[AutoTublify Popup] Queue status received:', response);
    renderQueue(response.queue || [], response.isProcessing);
    updateQueueCount(response.queueLength || 0);
  } catch (error) {
    console.error('[AutoTublify] Queue update error:', error);
  }
}

function renderQueue(queue, isProcessing) {
  console.log('[AutoTublify Popup] Rendering queue:', { queueLength: queue.length, isProcessing, queue });
  
  const container = document.getElementById('queueList');
  if (!container) {
    console.error('[AutoTublify Popup] queueList element not found!');
    return;
  }

  if (queue.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Queue is empty</div>
        <div>Videos saved to monitored playlists will appear here automatically.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = queue.map((item, index) => {
    const isActive = isProcessing && index === 0;
    return `
      <div class="queue-item">
        <div class="queue-info">
          <div class="queue-title">${escapeHtml(item.videoTitle || 'Unknown Title')}</div>
          <div class="queue-meta">
            ${escapeHtml(item.channelName || 'Unknown Channel')} —
            ${escapeHtml(item.playlistName || 'Unknown Playlist')}
          </div>
        </div>
        <div class="queue-badge ${isActive ? 'processing' : ''}">
          ${isActive ? 'Processing' : `Position ${index + 1}`}
        </div>
      </div>
    `;
  }).join('');
  
  console.log('[AutoTublify Popup] Queue rendered successfully');
}

async function clearQueue() {
  if (!confirm('Clear all items from the processing queue?')) return;

  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_QUEUE' });
    updateQueue();
  } catch (error) {
    console.error('[AutoTublify] Error clearing queue:', error);
  }
}

function updateQueueCount(count) {
  const el = document.getElementById('queueCount');
  if (el) el.textContent = `Queue: ${count}`;
}

// STATUS BAR

async function updateStatus() {
  try {
    const settings = await chrome.storage.local.get({ autoMode: true, apiKey: '' });
    const response = await chrome.runtime.sendMessage({ type: 'GET_QUEUE_STATUS' });

    updateQueueCount(response.queueLength || 0);

    const dot  = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    if (!dot || !text) return;

    if (!settings.apiKey) {
      dot.className  = 'status-dot error';
      text.textContent = 'API key not configured';
    } else if (response.isProcessing) {
      dot.className  = 'status-dot processing';
      text.textContent = 'Processing video...';
    } else {
      // Automatic mode disabled for now
      dot.className  = 'status-dot';
      text.textContent = 'Manual mode';
    }

  } catch (error) {
    console.error('[AutoTublify] Status update error:', error);
  }
}

/* AUTOMATIC MODE STATUS - COMMENTED OUT
function updateStatusDisplay() {
  const autoMode = document.getElementById('autoMode')?.checked;
  const text = document.getElementById('statusText');
  if (text) {
    text.textContent = autoMode ? 'Automatic mode active' : 'Manual mode';
  }
}
*/

// UI UTILITIES

function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  if (!el) return;

  el.textContent = message;
  el.className = `status-msg ${type}`;

  if (type === 'success') {
    setTimeout(() => { el.className = 'status-msg'; }, 4500);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
