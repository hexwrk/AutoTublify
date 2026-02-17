// content.js
// AutoTublify - YouTube Page Monitor

console.log('[AutoTublify] Content script loaded.');

// STATE

let currentVideoId = null;
let lastProcessedVideo = null;
let lastCheckTime = 0;
const DEBOUNCE_MS = 2000;

// INITIALISATION

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  console.log('[AutoTublify] Initialising detection strategies.');

  monitorNotifications();
  monitorUrlChanges();
  interceptYouTubeEvents();

  console.log('[AutoTublify] All detection strategies active.');
}



function monitorNotifications() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          checkForPlaylistNotification(node);
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  console.log('[AutoTublify] Notification observer active.');
}

function checkForPlaylistNotification(element) {
  const selectors = [
    'tp-yt-paper-toast',
    'ytd-notification-action-renderer',
    '[role="alert"]'
  ];

  for (const selector of selectors) {
    const notification = element.matches?.(selector)
      ? element
      : element.querySelector?.(selector);

    if (notification) {
      const text = notification.textContent || '';

      if (text.includes('Added to') || text.includes('Saved to')) {
        console.log('[AutoTublify] Playlist save notification detected.');
        handleDetectedPlaylistSave('notification');
        break;
      }
    }
  }
}


let lastUrl = location.href;

function monitorUrlChanges() {
  setInterval(() => {
    const currentUrl = location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      onUrlChange(currentUrl);
    }
  }, 500);
}

function onUrlChange(url) {
  if (url.includes('/watch?v=')) {
    const videoId = extractVideoId(url);
    if (videoId) {
      currentVideoId = videoId;
      console.log('[AutoTublify] Current video updated:', videoId);
    }
  }
}

function interceptYouTubeEvents() {
  window.addEventListener('yt-navigate-finish', () => {
    updateCurrentVideo();
  });

  window.addEventListener('yt-page-data-updated', () => {
    updateCurrentVideo();
  });
}

function updateCurrentVideo() {
  const videoId = extractVideoId(window.location.href);
  if (videoId && videoId !== currentVideoId) {
    currentVideoId = videoId;
    console.log('[AutoTublify] Video ID updated via YouTube event:', videoId);
  }
}

// PLAYLIST SAVE HANDLER

function handleDetectedPlaylistSave(detectionMethod) {
  const now = Date.now();

  // Debounce to prevent duplicate events from firing in rapid succession.
  if (now - lastCheckTime < DEBOUNCE_MS) {
    console.log('[AutoTublify] Debounce active. Ignoring duplicate event.');
    return;
  }

  lastCheckTime = now;

  const videoInfo = getCurrentVideoInfo();

  if (!videoInfo || !videoInfo.videoId) {
    console.warn('[AutoTublify] Could not retrieve video information. Aborting.');
    return;
  }

  if (videoInfo.videoId === lastProcessedVideo) {
    console.log('[AutoTublify] Video already sent for processing. Skipping.');
    return;
  }

  lastProcessedVideo = videoInfo.videoId;

  getPlaylistName().then(playlistName => {
    console.log('[AutoTublify] Sending message to background:', {
      videoId: videoInfo.videoId,
      playlistName,
      detectionMethod
    });

    chrome.runtime.sendMessage({
      type: 'VIDEO_ADDED_TO_PLAYLIST',
      data: {
        videoId: videoInfo.videoId,
        videoTitle: videoInfo.title,
        channelName: videoInfo.channel,
        playlistName: playlistName || 'Unknown',
        detectionMethod
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[AutoTublify] Message error:', chrome.runtime.lastError);
      } else {
        console.log('[AutoTublify] Background acknowledged message:', response);
      }
    });
  });
}

// VIDEO INFORMATION EXTRACTION

function getCurrentVideoInfo() {
  try {
    const videoId = extractVideoId(window.location.href) || currentVideoId;

    if (!videoId) {
      console.warn('[AutoTublify] No video ID available.');
      return null;
    }

    let title = 'Unknown Title';
    const titleSelectors = [
      'h1.ytd-watch-metadata yt-formatted-string',
      'h1.ytd-video-primary-info-renderer',
      'meta[name="title"]'
    ];

    for (const selector of titleSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent || el.getAttribute('content') || '';
        if (text.trim()) {
          title = text.trim();
          break;
        }
      }
    }

    let channel = 'Unknown Channel';
    const channelSelectors = [
      'ytd-channel-name#channel-name a',
      'ytd-video-owner-renderer a',
      'meta[itemprop="author"]'
    ];

    for (const selector of channelSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent || el.getAttribute('content') || '';
        if (text.trim()) {
          channel = text.trim();
          break;
        }
      }
    }

    return { videoId, title, channel, url: window.location.href };

  } catch (error) {
    console.error('[AutoTublify] Error extracting video info:', error);
    return null;
  }
}

async function getPlaylistName() {
  // Attempt 1: Read from a visible, checked playlist option in the modal.
  const playlistModal = document.querySelector('ytd-add-to-playlist-renderer');
  if (playlistModal) {
    const checkboxes = playlistModal.querySelectorAll('tp-yt-paper-checkbox[checked]');
    if (checkboxes.length > 0) {
      const container = checkboxes[checkboxes.length - 1]
        .closest('ytd-playlist-add-to-option-renderer');
      if (container) {
        const label = container.querySelector('#label');
        if (label?.textContent.trim()) return label.textContent.trim();
      }
    }
  }

  // Attempt 2: Parse the toast notification text.
  const notifications = document.querySelectorAll('tp-yt-paper-toast, [role="alert"]');
  for (const notification of notifications) {
    const match = notification.textContent?.match(/(?:Added to|Saved to)\s+(.+)/i);
    if (match && match[1]) return match[1].trim();
  }

  // Attempt 3: Read from the playlist page title if currently on one.
  if (window.location.href.includes('/playlist')) {
    const playlistTitle = document.querySelector(
      'yt-formatted-string.ytd-playlist-header-renderer'
    );
    if (playlistTitle?.textContent.trim()) return playlistTitle.textContent.trim();
  }

  return 'Unknown';
}

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

window.AutoTublifyDebug = {
  getCurrentVideo: getCurrentVideoInfo,
  extractVideoId,
  getPlaylistName,
  triggerDetection: () => handleDetectedPlaylistSave('manual_debug'),
  status: () => ({
    lastProcessedVideo,
    currentVideoId,
    lastCheckTime,
    url: window.location.href
  })
};

console.log('[AutoTublify] Debug interface available: window.AutoTublifyDebug');
