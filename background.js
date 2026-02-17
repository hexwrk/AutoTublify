// background.js
// AutoTublify - Background Service Worker
// Enhanced with chunking and two-stage summarization for long transcripts

console.log('[AutoTublify] Background service worker initialised.');

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[AutoTublify] Extension installed or updated.');

  const existing = await chrome.storage.local.get(['enabled', 'autoMode']);

  if (existing.enabled === undefined) {
    await chrome.storage.local.set({
      enabled: true,
      autoMode: true,
      targetPlaylists: [],
      apiKey: '',
      saveLocation: 'YouTube Summaries/',
      processedVideos: [],
      processingQueue: []
    });
    console.log('[AutoTublify] Default settings written to storage.');
  }
});

// YOUTUBE URL MONITORING
chrome.webNavigation.onHistoryStateUpdated.addListener(
  async (details) => {
    const url = details.url;

    if (url.includes('youtube.com/playlist') && url.includes('list=')) {
      const playlistMatch = url.match(/[?&]list=([^&]+)/);
      if (playlistMatch) {
        const playlistId = playlistMatch[1];
        console.log('[AutoTublify] Playlist page detected. ID:', playlistId);
        await chrome.storage.session.set({
          [`playlist_${details.tabId}`]: playlistId
        });
      }
    }
  },
  { url: [{ hostContains: 'youtube.com' }] }
);

// MESSAGE HANDLING
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AutoTublify] Message received:', message.type);

  if (message.type === 'VIDEO_ADDED_TO_PLAYLIST') {
    handleVideoAddedToPlaylist(message.data);
    sendResponse({ status: 'queued' });

  } else if (message.type === 'PROCESS_VIDEO_URL') {
    // Handle async processing
    processVideoByUrl(message.data.url)
      .then(() => {
        console.log('[AutoTublify] Manual URL processing initiated');
        sendResponse({ status: 'processing', success: true });
      })
      .catch(error => {
        console.error('[AutoTublify] Manual URL processing error:', error);
        sendResponse({ status: 'error', error: error.message });
      });
    return true; // Keep channel open for async response

  } else if (message.type === 'GET_QUEUE_STATUS') {
    getQueueStatus().then(status => sendResponse(status));
    return true;

  } else if (message.type === 'CLEAR_QUEUE') {
    clearQueue().then(() => sendResponse({ status: 'cleared' }));
    return true;
  }

  return true;
});

// PLAYLIST ADDITION HANDLER
async function handleVideoAddedToPlaylist(data) {
  const { videoId, videoTitle, channelName, playlistName } = data;

  try {
    console.log('[AutoTublify] Video addition detected:', { videoId, playlistName });

    const shouldProcess = await shouldProcessPlaylist(playlistName);
    if (!shouldProcess) {
      console.log('[AutoTublify] Playlist not in monitored list. Skipping.');
      return;
    }

    const alreadyProcessed = await isVideoProcessed(videoId);
    if (alreadyProcessed) {
      console.log('[AutoTublify] Video already processed. Skipping.');
      return;
    }

    await addToQueue({
      videoId,
      videoTitle,
      channelName,
      playlistName,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      addedAt: new Date().toISOString()
    });

    showNotification('Video Queued', `"${videoTitle}" has been added to the processing queue.`);
    processQueue();

  } catch (error) {
    console.error('[AutoTublify] Error handling video addition:', error);
  }
}

// QUEUE MANAGEMENT
let isProcessing = false;

async function addToQueue(videoData) {
  console.log('[AutoTublify] addToQueue called with:', videoData);
  
  const { processingQueue } = await chrome.storage.local.get({ processingQueue: [] });
  console.log('[AutoTublify] Current queue before adding:', processingQueue);

  const exists = processingQueue.some(item => item.videoId === videoData.videoId);
  if (!exists) {
    processingQueue.push(videoData);
    await chrome.storage.local.set({ processingQueue });
    console.log('[AutoTublify] Video added to queue. Queue length:', processingQueue.length);
    console.log('[AutoTublify] Updated queue:', processingQueue);
  } else {
    console.log('[AutoTublify] Video already in queue, skipping');
  }
}

async function processQueue() {
  if (isProcessing) {
    console.log('[AutoTublify] Queue processor already running.');
    return;
  }

  const settings = await chrome.storage.local.get({ apiKey: '' });
  
  if (!settings.apiKey) {
    console.warn('[AutoTublify] Cannot process queue: No API key configured.');
    showNotification('Configuration Required', 'Please add your Anthropic API key in Settings.');
    isProcessing = false;
    return;
  }

  const { processingQueue } = await chrome.storage.local.get({ processingQueue: [] });

  if (processingQueue.length === 0) {
    console.log('[AutoTublify] Queue is empty.');
    isProcessing = false;
    return;
  }

  isProcessing = true;
  console.log('[AutoTublify] Starting queue processing. Items:', processingQueue.length);

  while (processingQueue.length > 0) {
    const videoData = processingQueue[0];
    const retryCount = videoData.retryCount || 0;

    try {
      console.log(`[AutoTublify] Processing: "${videoData.videoTitle}" (Attempt ${retryCount + 1}/3)`);
      
      await processVideo(videoData);

      processingQueue.shift();
      await chrome.storage.local.set({ processingQueue });

    } catch (error) {
      console.error('[AutoTublify] Processing failed:', error.message);

      const failed = processingQueue.shift();
      failed.retryCount = retryCount + 1;
      failed.lastError = error.message;

      if (failed.retryCount < 3) {
        const backoffDelay = 2000 * Math.pow(2, failed.retryCount - 1);
        
        processingQueue.push(failed);
        console.log(`[AutoTublify] Requeued for retry. Next attempt in ${backoffDelay/1000}s`);
        
        await chrome.storage.local.set({ processingQueue });
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        
      } else {
        console.warn('[AutoTublify] Max retries reached. Discarding:', failed.videoTitle);
        
        showNotification(
          'Processing Failed', 
          `"${failed.videoTitle}" failed after 3 attempts.\n\nError: ${error.message}`
        );
        
        await chrome.storage.local.set({ processingQueue });
      }
    }

    if (processingQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  isProcessing = false;
  console.log('[AutoTublify] Queue processing complete.');
}

async function clearQueue() {
  await chrome.storage.local.set({ processingQueue: [] });
  isProcessing = false;
  console.log('[AutoTublify] Queue cleared.');
}

async function getQueueStatus() {
  const { processingQueue } = await chrome.storage.local.get({ processingQueue: [] });
  const status = {
    queueLength: processingQueue.length,
    isProcessing,
    queue: processingQueue
  };
  console.log('[AutoTublify] getQueueStatus returning:', status);
  return status;
}

// VIDEO PROCESSING PIPELINE
async function processVideo(videoData) {
  showNotification('Processing Video', `"${videoData.videoTitle}" is being processed.`);

  console.log('[AutoTublify] Starting video processing for:', videoData.videoId);
  
  const transcript = await fetchTranscript(videoData.videoId);
  
  if (!transcript) {
    const errorMsg = `No transcript available for "${videoData.videoTitle}". This video may not have captions/subtitles enabled. Please try a different video or enable captions on YouTube.`;
    console.error('[AutoTublify]', errorMsg);
    throw new Error(errorMsg);
  }

  console.log('[AutoTublify] Transcript fetched, generating summary...');
  const summary = await generateSummary(transcript, videoData);
  
  console.log('[AutoTublify] Summary generated, saving to file...');
  await saveSummaryToFile(summary, videoData);
  
  console.log('[AutoTublify] Marking video as processed...');
  await markVideoAsProcessed(videoData.videoId);

  showNotification('Processing Complete', `"${videoData.videoTitle}" has been summarised and saved.`);
  console.log('[AutoTublify] ✓ Video processing complete');
}

async function processVideoByUrl(url) {
  console.log('[AutoTublify] Processing manual URL:', url);
  
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw new Error('Invalid YouTube URL provided.');
  }

  console.log('[AutoTublify] Extracted video ID:', videoId);

  const metadata = await fetchVideoMetadata(videoId);
  console.log('[AutoTublify] Fetched metadata:', metadata);

  const videoData = {
    videoId,
    videoTitle: metadata.title,
    channelName: metadata.channel,
    playlistName: 'Manual',
    url,
    addedAt: new Date().toISOString()
  };

  console.log('[AutoTublify] Adding to queue:', videoData);
  await addToQueue(videoData);
  
  console.log('[AutoTublify] Starting queue processing...');
  processQueue();
}

// TRANSCRIPT FETCHING - Hybrid Approach: Robust extraction + proven parsing
async function fetchTranscript(videoId) {
  if (!videoId || videoId.length !== 11) {
    console.error('[AutoTublify] Invalid video ID format:', videoId);
    return null;
  }

  try {
    console.log('[AutoTublify] Fetching transcript for:', videoId);
    
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) {
      throw new Error(`YouTube returned HTTP ${response.status}`);
    }

    const html = await response.text();
    console.log('[AutoTublify] Page fetched, size:', html.length, 'bytes');

    let captionTracks = null;

    // METHOD 1: Simple regex (works for most videos)
    const simpleMatch = html.match(/"captionTracks"\s*:\s*(\[[^\]]+\])/);
    if (simpleMatch) {
      try {
        captionTracks = JSON.parse(simpleMatch[1]);
        if (Array.isArray(captionTracks) && captionTracks.length > 0) {
          console.log('[AutoTublify] ✓ Method 1 (Simple regex): Found', captionTracks.length, 'tracks');
        }
      } catch (e) {
        console.log('[AutoTublify] Method 1 failed:', e.message);
      }
    }

    // METHOD 2: ytInitialPlayerResponse parsing
    if (!captionTracks || captionTracks.length === 0) {
      const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});var/s);
      if (playerMatch) {
        try {
          const playerData = JSON.parse(playerMatch[1]);
          const extracted = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (extracted && Array.isArray(extracted) && extracted.length > 0) {
            captionTracks = extracted;
            console.log('[AutoTublify] ✓ Method 2 (ytInitialPlayerResponse): Found', captionTracks.length, 'tracks');
          }
        } catch (e) {
          console.log('[AutoTublify] Method 2 failed:', e.message);
        }
      }
    }

    // METHOD 3: Advanced regex with lookahead
    if (!captionTracks || captionTracks.length === 0) {
      const advancedMatch = html.match(/"captionTracks":\s*(\[[\s\S]*?\])(?=\s*[,}])/);
      if (advancedMatch) {
        try {
          captionTracks = JSON.parse(advancedMatch[1]);
          if (Array.isArray(captionTracks) && captionTracks.length > 0) {
            console.log('[AutoTublify] ✓ Method 3 (Advanced regex): Found', captionTracks.length, 'tracks');
          }
        } catch (e) {
          console.log('[AutoTublify] Method 3 failed:', e.message);
        }
      }
    }

    // METHOD 4: Direct timedtext URL construction
    if (!captionTracks || captionTracks.length === 0) {
      console.log('[AutoTublify] Method 4: Testing direct API URLs...');
      const testUrls = [
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en`,
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3`,
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=vtt`
      ];

      for (const testUrl of testUrls) {
        try {
          const testResp = await fetch(testUrl);
          if (testResp.ok) {
            const testXml = await testResp.text();
            if (testXml.length > 100 && testXml.includes('<text')) {
              captionTracks = [{ baseUrl: testUrl, languageCode: 'en' }];
              console.log('[AutoTublify] ✓ Method 4 (Direct URL): Success');
              break;
            }
          }
        } catch (e) {
          // Continue to next URL
        }
      }
    }

    if (!captionTracks || !Array.isArray(captionTracks) || captionTracks.length === 0) {
      console.error('[AutoTublify] ❌ No captions found with any method');
      console.log('[AutoTublify] Debug: Contains "captionTracks":', html.includes('captionTracks'));
      console.log('[AutoTublify] Debug: Contains "timedtext":', html.includes('timedtext'));
      return null;
    }

    // SELECT BEST CAPTION TRACK (from reference code logic)
    console.log('[AutoTublify] Available languages:', captionTracks.map(t => t.languageCode || 'unknown').join(', '));
    
    let captionUrl = null;
    
    // Prioritize English captions (reference code approach)
    for (const track of captionTracks) {
      if (track.languageCode?.startsWith('en')) {
        captionUrl = track.baseUrl;
        console.log('[AutoTublify] Selected English captions:', track.languageCode);
        break;
      }
    }

    // Fallback to first available (reference code approach)
    if (!captionUrl && captionTracks[0]?.baseUrl) {
      captionUrl = captionTracks[0].baseUrl;
      console.log('[AutoTublify] Using fallback captions:', captionTracks[0].languageCode);
    }

    if (!captionUrl) {
      console.error('[AutoTublify] No valid caption URL found');
      return null;
    }

    // FETCH AND PARSE TRANSCRIPT (exact reference code approach)
    console.log('[AutoTublify] Fetching transcript XML...');
    const transcriptResponse = await fetch(captionUrl);
    
    if (!transcriptResponse.ok) {
      throw new Error(`Caption fetch failed with HTTP ${transcriptResponse.status}`);
    }

    const xml = await transcriptResponse.text();
    console.log('[AutoTublify] Transcript XML size:', xml.length, 'bytes');

    // Parse XML to extract text content (exact reference code approach)
    const textMatches = [...xml.matchAll(/<text[^>]*>([^<]+)<\/text>/g)];
    
    if (textMatches.length === 0) {
      console.warn('[AutoTublify] No text nodes found in transcript XML');
      return null;
    }

    console.log('[AutoTublify] Found', textMatches.length, 'text segments');

    // Build transcript (exact reference code approach)
    const transcript = textMatches
      .map(match => decodeHTMLEntities(match[1]))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Validation (from reference code)
    if (transcript.length < 50) {
      console.warn('[AutoTublify] Transcript suspiciously short:', transcript.length, 'chars');
      return null;
    }

    console.log('[AutoTublify] ✓ Transcript extracted successfully:', transcript.length, 'chars');
    console.log('[AutoTublify] Preview:', transcript.substring(0, 150) + '...');
    return transcript;

  } catch (error) {
    console.error('[AutoTublify] Transcript fetch error:', error.message);
    return null;
  }
}

async function fetchVideoMetadata(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  const html = await response.text();

  let title = 'Unknown Title';
  const titleMatch = html.match(/<meta name="title" content="([^"]+)"/);
  if (titleMatch) title = decodeHTMLEntities(titleMatch[1]);

  let channel = 'Unknown Channel';
  const channelMatch = html.match(/"author":"([^"]+)"/);
  if (channelMatch) channel = decodeHTMLEntities(channelMatch[1]);

  return {
    videoId,
    title,
    channel,
    url: `https://www.youtube.com/watch?v=${videoId}`
  };
}

// ENHANCED SUMMARIZATION WITH CHUNKING

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function splitIntoChunks(transcript, maxTokens = 12000) {
  const estimatedTokens = estimateTokens(transcript);
  
  if (estimatedTokens <= maxTokens) {
    return [transcript];
  }
  
  console.log(`[AutoTublify] Transcript is large (~${estimatedTokens} tokens). Splitting into chunks...`);
  
  const chunks = [];
  const sentences = transcript.split(/[.!?]+\s+/);
  let buffer = '';
  let tokenCount = 0;
  
  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    
    if (tokenCount + sentenceTokens > maxTokens && buffer) {
      chunks.push(buffer.trim());
      buffer = sentence + '. ';
      tokenCount = sentenceTokens;
    } else {
      buffer += sentence + '. ';
      tokenCount += sentenceTokens;
    }
  }
  
  if (buffer.trim()) {
    chunks.push(buffer.trim());
  }
  
  console.log(`[AutoTublify] Split into ${chunks.length} chunks`);
  return chunks;
}

async function generateSummary(transcript, videoData) {
  const settings = await chrome.storage.local.get({ apiKey: '' });

  if (!settings.apiKey || !settings.apiKey.startsWith('sk-ant-')) {
    throw new Error('Invalid or missing API key. Configure in Settings tab.');
  }

  const estimatedTokens = estimateTokens(transcript);
  console.log(`[AutoTublify] Transcript size: ~${estimatedTokens} tokens (~${Math.round(estimatedTokens/1000)}K)`);
  
  if (estimatedTokens > 12000) {
    console.log('[AutoTublify] Using two-stage summarization for long transcript');
    return await generateLongSummary(transcript, videoData, settings.apiKey);
  }
  
  const prompt = `You are analyzing a YouTube video transcript. Generate a comprehensive, well-structured summary.

**Video Information:**
- Title: ${videoData.videoTitle}
- Channel: ${videoData.channelName}
- Playlist: ${videoData.playlistName}

**Transcript:**
${transcript}

**Instructions:**
Create a detailed summary with the following sections:

## Overview
Write 2-3 sentences capturing the core topic and purpose of this video.

## Key Points
List the main ideas, arguments, or topics covered. Be specific and detailed.

## Important Details
Note any significant facts, statistics, examples, demonstrations, or technical details mentioned.

## Main Takeaways
Summarize the key conclusions, recommendations, or actionable insights.

## Recommended For
Briefly describe who would benefit most from this content.

Write in clear, professional language. Focus on substance over style.`;

  try {
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
        max_tokens: 4096,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      let errorMessage;
      
      try {
        const errorJson = JSON.parse(errorBody);
        errorMessage = errorJson.error?.message || errorJson.message || `HTTP ${response.status}`;
      } catch {
        errorMessage = `HTTP ${response.status}: ${errorBody.substring(0, 200)}`;
      }
      
      throw new Error(errorMessage);
    }

    const data = await response.json();

    if (!data.content?.[0]?.text) {
      console.error('[AutoTublify] Unexpected API response:', data);
      throw new Error('API returned unexpected response format.');
    }

    console.log('[AutoTublify] Summary generated successfully.');
    return data.content[0].text;

  } catch (error) {
    if (error.message.includes('model')) {
      throw new Error(`Model error: ${error.message}. The extension may need an update.`);
    }
    throw error;
  }
}

async function generateLongSummary(transcript, videoData, apiKey) {
  console.log('[AutoTublify] Stage 1: Summarizing chunks...');
  
  const chunks = splitIntoChunks(transcript, 12000);
  const chunkSummaries = [];
  
  for (let i = 0; i < chunks.length; i++) {
    console.log(`[AutoTublify] Processing chunk ${i + 1}/${chunks.length}...`);
    
    const chunkPrompt = `Summarize this portion of a YouTube video transcript. Focus on the main points, key information, and important details. Be comprehensive but concise.

Transcript segment:
${chunks[i]}

Summary:`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 2048,
        temperature: 0.3,
        messages: [{ role: 'user', content: chunkPrompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`Chunk ${i + 1} summarization failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    chunkSummaries.push(data.content[0].text);
    
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log('[AutoTublify] Stage 2: Creating final summary...');
  
  const combinedSummaries = chunkSummaries.join('\n\n---\n\n');
  
  const finalPrompt = `You are analyzing a YouTube video. Below are summaries of different parts of the video transcript.

**Video Information:**
- Title: ${videoData.videoTitle}
- Channel: ${videoData.channelName}

**Partial Summaries:**
${combinedSummaries}

**Instructions:**
Create a comprehensive final summary with these sections:

## Overview
2-3 sentences capturing the video's core topic and purpose.

## Key Points
The main ideas, arguments, or topics covered throughout the video.

## Important Details
Significant facts, statistics, examples, or technical information.

## Main Takeaways
Key conclusions, recommendations, or actionable insights.

## Recommended For
Who would benefit most from this content.

Synthesize the information into a cohesive, well-organized summary.`;

  const finalResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      temperature: 0.3,
      messages: [{ role: 'user', content: finalPrompt }]
    })
  });

  if (!finalResponse.ok) {
    throw new Error(`Final summarization failed: HTTP ${finalResponse.status}`);
  }

  const finalData = await finalResponse.json();
  console.log('[AutoTublify] Two-stage summary completed successfully.');
  
  return finalData.content[0].text;
}

// FILE SAVING
async function saveSummaryToFile(summary, videoData) {
  const settings = await chrome.storage.local.get({ saveLocation: 'YouTube Summaries/' });

  const date = new Date().toISOString().split('T')[0];
  const cleanChannel = sanitiseFilename(videoData.channelName);
  const cleanTitle = sanitiseFilename(videoData.videoTitle);
  const filename = `${date}_${cleanChannel}_${cleanTitle}.md`;

  const content =
`# ${videoData.videoTitle}

**Channel:** ${videoData.channelName}
**Playlist:** ${videoData.playlistName}
**Date:** ${date}
**Source:** ${videoData.url}

---

${summary}

---

*Generated by AutoTublify using Anthropic Claude.*
`;

  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: settings.saveLocation + filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });

  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.log('[AutoTublify] File saved:', filename);
}

// UTILITY FUNCTIONS
async function shouldProcessPlaylist(playlistName) {
  const settings = await chrome.storage.local.get({
    enabled: true,
    targetPlaylists: []
  });

  if (!settings.enabled) return false;

  if (settings.targetPlaylists.length === 0) return true;

  return settings.targetPlaylists.some(p =>
    p.toLowerCase().trim() === playlistName.toLowerCase().trim()
  );
}

async function isVideoProcessed(videoId) {
  const { processedVideos } = await chrome.storage.local.get({ processedVideos: [] });
  return processedVideos.includes(videoId);
}

async function markVideoAsProcessed(videoId) {
  const { processedVideos } = await chrome.storage.local.get({ processedVideos: [] });

  if (!processedVideos.includes(videoId)) {
    processedVideos.push(videoId);

    if (processedVideos.length > 1000) {
      processedVideos.shift();
    }

    await chrome.storage.local.set({ processedVideos });
  }
}

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function sanitiseFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .trim()
    .substring(0, 100);
}

function decodeHTMLEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&#x27;': "'",
    '&#x2F;': '/',
    '&#x3D;': '=',
    '&ndash;': '–',
    '&mdash;': '—'
  };
  
  // Replace known entities
  let decoded = text;
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.replace(new RegExp(entity, 'g'), char);
  }
  
  // Decode numeric HTML entities (&#123; or &#xAB;)
  decoded = decoded.replace(/&#(\d+);/g, (match, dec) => 
    String.fromCharCode(parseInt(dec, 10))
  );
  decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => 
    String.fromCharCode(parseInt(hex, 16))
  );
  
  return decoded;
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title,
    message,
    priority: 1
  });
}
