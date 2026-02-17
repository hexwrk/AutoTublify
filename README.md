# AutoTublify

A Chrome extension that monitors YouTube playlist activity, extracts video transcripts, and generates structured AI summaries using Anthropic's Claude API. Summaries are saved as Markdown files to the user's local filesystem.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Output Format](#output-format)
- [Permissions](#permissions)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Cost Estimation](#cost-estimation)
- [Version History](#version-history)
- [License](#license)

---

## Overview

AutoTublify operates in two modes. Automatic mode detects when a video is saved to a YouTube playlist and processes it without user intervention. Manual mode accepts a YouTube URL directly from the extension popup and is the recommended approach when reliability is critical.

Both modes produce identical output: a structured Markdown summary file containing an overview, key points, takeaways, technical details, and recommended audience.

---

## Features

- Automatic detection of YouTube playlist save events via MutationObserver and YouTube internal event hooks
- Manual video processing by URL as a reliable fallback
- Sequential processing queue with retry logic and exponential backoff
- AI-powered summarization via Anthropic Claude API
- Markdown output saved to the local Downloads directory
- System notifications at each processing stage
- Configurable playlist filtering
- Processed video deduplication to prevent redundant API calls
- Debug interface exposed on YouTube pages via the browser console

---

## Architecture

The extension follows Chrome Manifest Version 3 architecture, separating responsibilities across three components.

**background.js** is the background service worker. It manages the processing queue, fetches transcripts from YouTube's caption system, calls the Claude API, and writes summary files to disk. It runs independently of any open browser tab and persists across sessions.

**content.js** is a content script injected into YouTube pages. It monitors the page DOM for playlist save events and relays video metadata to the background service worker via Chrome's message passing API. It performs no API calls or file operations.

**popup.html and popup.js** form the user interface. The popup provides controls for enabling or disabling automatic mode, configuring monitored playlists, entering an API key, triggering manual processing, and viewing the current queue state.

### Message Flow

The sequence below describes what happens when a user saves a video to a playlist with automatic mode enabled.

1. User saves a video via YouTube's save dialog.
2. YouTube displays a toast notification confirming the save.
3. content.js detects the notification via MutationObserver.
4. content.js extracts the video ID, title, and channel name from the page.
5. content.js sends a VIDEO_ADDED_TO_PLAYLIST message to background.js.
6. background.js checks whether the playlist is monitored and whether the video has been processed before.
7. If eligible, the video is appended to the processing queue.
8. The queue processor fetches the video transcript from YouTube's caption endpoint.
9. The transcript is submitted to the Claude API with a structured summarisation prompt.
10. The returned summary is formatted and written to a .md file in the configured Downloads subdirectory.
11. A system notification confirms completion.

---

## Prerequisites

- Google Chrome version 88 or later (Manifest V3 support required)
- An Anthropic API key, obtainable from https://console.anthropic.com/settings/keys

---

## Installation

1. Download or clone the repository to a local directory.
2. Open Chrome and navigate to chrome://extensions/
3. Enable Developer mode using the toggle in the top-right corner.
4. Click Load unpacked.
5. Select the project folder containing manifest.json.
6. The AutoTublify icon will appear in the Chrome toolbar.

### File Structure

```
autotublify/
    manifest.json       Extension configuration and permission declarations
    background.js       Service worker: queue management, transcript fetch, API, file output
    content.js          YouTube page monitor and event relay
    popup.html          User interface markup and styles
    popup.js            User interface logic and event handlers
    icon.png            Extension icon (16px, 48px, 128px)
    README.md           This document
```

---

## Configuration

### API Key

1. Click the AutoTublify icon in the Chrome toolbar.
2. Navigate to the Settings tab.
3. Enter your Anthropic API key in the provided field. Keys follow the format sk-ant-api03-...
4. Click Save Settings.
5. Click Test API Connection to verify the key is valid before processing any videos.

### Save Location

The default save location is a subfolder named YouTube Summaries within the Chrome Downloads directory. This can be changed in the Settings tab. The path entered is relative to the Downloads root. Do not use absolute paths or characters invalid in folder names.

### Monitored Playlists

By default, all playlists are monitored. To restrict processing to specific playlists, enter their names in the Monitored Playlists field in the Automatic tab, one per line. Matching is case-insensitive. Leave the field blank to monitor all playlists.

---

## Usage

### Automatic Mode

1. Navigate to the Automatic tab in the popup.
2. Ensure the toggle is enabled.
3. Optionally configure playlist names to monitor.
4. Save settings.
5. Browse YouTube and save videos to playlists as normal. The extension handles detection and processing.

To monitor progress, open the Queue tab. Notifications appear in the operating system notification area when videos complete or fail.

### Manual Mode

1. Copy the URL of any YouTube video.
2. Open the popup and navigate to the Manual tab.
3. Paste the URL and click Generate Summary.
4. The video is added to the queue and processed in order.

Manual mode bypasses all DOM detection logic and is not subject to its reliability constraints. It is recommended for individual videos or when automatic detection fails.

### Queue Behaviour

Videos process sequentially. A three-second delay is applied between items to respect API rate limits. Failed items are retried up to three times using exponential backoff: two seconds after the first failure, four seconds after the second, eight seconds after the third. After three consecutive failures the item is removed from the queue and a notification is displayed.

---

## Output Format

Summaries are saved as UTF-8 encoded Markdown files using the following naming convention:

```
YYYY-MM-DD - Channel Name - Video Title.md
```

Each file contains the following structure:

```
# Video Title

**Channel:** Channel Name
**Playlist:** Playlist Name
**Date:** YYYY-MM-DD
**Source:** https://www.youtube.com/watch?v=VIDEO_ID

---

## Overview
2-3 sentence summary of the core content.

## Key Points
- Primary topics as bullet points.

## Main Takeaways
Actionable conclusions or insights.

## Technical Details
Tools, frameworks, and methodologies mentioned, if applicable.

## Recommended Audience
Who would benefit most from this content.

---

*Generated by AutoTublify using Anthropic Claude.*
```

---

## Permissions

| Permission    | Purpose                                                        |
|---------------|----------------------------------------------------------------|
| storage       | Persisting settings, processed video history, and queue state  |
| downloads     | Writing summary files to the local filesystem                  |
| notifications | Displaying processing status messages                          |
| webNavigation | Monitoring YouTube URL changes for playlist context            |
| tabs          | Communication between popup and background contexts            |

Host permissions are restricted to https://www.youtube.com/* and https://api.anthropic.com/*

---

## Known Limitations

**Automatic detection reliability** is estimated at 80 to 90 percent under normal conditions. YouTube's frontend is updated frequently and the DOM structure detection targets may change without notice. Manual mode is unaffected by this constraint and operates at near-100 percent reliability.

**Transcript availability** varies by video. Captions must exist on the video, either uploaded manually or auto-generated by YouTube, for processing to succeed. Videos without captions cannot be summarised. This is a platform constraint, not an extension bug.

**Sequential processing** means videos in the queue are handled one at a time. Parallel processing is deliberately avoided to respect Anthropic API rate limits.

**Context window truncation** applies to long videos. Transcripts exceeding 100,000 characters are truncated before submission to the API. The truncation point is noted in the submitted text.

---

## Troubleshooting

### Automatic detection is not triggering

Automatic detection relies on YouTube emitting a recognisable toast notification in the DOM. YouTube's interface changes frequently. If detection fails, use Manual mode. Also verify that the extension is enabled (green indicator in the status bar), the content script has loaded by refreshing the YouTube page, and the playlist name matches the configured monitored list if one has been set.

### API errors during summarisation

Navigate to Settings and use the Test API Connection button. Common causes include an incorrectly entered API key, an expired key, or an exceeded usage quota. Verify the key is active at https://console.anthropic.com. API keys must begin with sk-ant- to pass client-side validation.

### No transcript available

This error means the video does not have captions. Open the video on YouTube, click the Settings gear, and check Subtitles/CC. If no option is available, the video cannot be processed. Auto-generated captions are sufficient.

### Files not appearing in Downloads

Verify Chrome has permission to download files automatically. This setting is available under Chrome Settings > Downloads. Also check that the configured save location does not contain characters invalid in file paths.

### Queue is stuck

Open the service worker console via chrome://extensions/ and click the service worker link under AutoTublify. Look for red error entries prefixed with [AutoTublify]. The most common causes are an unconfigured API key and a network error on the transcript fetch. Clearing the queue and reprocessing manually is the recommended recovery action.

### Debugging

When on a YouTube page, the content script exposes a debug interface via the browser console:

```javascript
// Current extension state
AutoTublifyDebug.status()

// Video information currently detected on the page
AutoTublifyDebug.getCurrentVideo()

// Manually trigger the detection handler for testing
AutoTublifyDebug.triggerDetection()

// Extract video ID from any URL string
AutoTublifyDebug.extractVideoId(window.location.href)
```

To inspect background service worker logs:

1. Navigate to chrome://extensions/
2. Locate AutoTublify.
3. Click service worker under Inspect views.
4. All [AutoTublify] log entries are visible in the console.

---

## Security

**API key storage.** The API key is stored exclusively in Chrome's local extension storage. It is transmitted only to api.anthropic.com over HTTPS and is never sent to any other endpoint or stored in plaintext outside of Chrome's sandboxed storage.

**Filename sanitisation.** Filenames are sanitised before use to prevent path traversal. The characters < > : " / \ | ? * are removed, whitespace is normalised, and the total name is capped at 100 characters.

**XSS prevention.** All user-controlled data rendered in the popup, including video titles, channel names, and playlist names, is escaped before DOM insertion using a dedicated utility function. Direct innerHTML assignment of unescaped content is not used.

**Minimal permissions.** The extension requests only the permissions required for its stated functionality. No broad host permissions are requested beyond YouTube and the Anthropic API.

---

## Cost Estimation

Anthropic charges per token consumed. There is no per-model plan; all models are available on any API tier and billed at their respective token rates.

**Approximate cost per video using claude-sonnet-4-5-20250929:**

A typical 20-minute video produces roughly 5,000 input tokens from the transcript and 500 output tokens for the summary.

```
Input:   5,000 tokens * ($3.00 / 1,000,000)  = $0.015
Output:    500 tokens * ($15.00 / 1,000,000)  = $0.0075
Total per video: approximately $0.02
```

The $5 USD free credit provided on new Anthropic accounts covers approximately 220 to 250 average-length videos.

Usage can be monitored in real time at https://console.anthropic.com/settings/usage

**Model selection reference:**

| Model                       | Input (per MTok) | Output (per MTok) | Recommended Use         |
|-----------------------------|------------------|--------------------|-------------------------|
| claude-haiku-4-5-20251001   | $1.00            | $5.00              | Testing, high volume     |
| claude-sonnet-4-5-20250929  | $3.00            | $15.00             | Production use (default) |
| claude-opus-4-5-20251101    | $5.00            | $25.00             | Maximum output quality   |

---

## Version History

| Version | Changes                                                                              |
|---------|--------------------------------------------------------------------------------------|
| 2.5.1   | Updated Claude model string, exponential backoff retry, API key pre-flight check, improved error handling and transcript validation |
| 2.5.0   | Hybrid automatic/manual architecture, sequential queue with retry, Chrome notification integration |
| 2.0.0   | Removed OpenAI support, Claude-only integration, URL-based manual processing         |
| 1.0.0   | Initial release, DOM scraping detection, multi-provider AI support                   |

---

## License

This project is for educational and personal use only. It is not licensed for commercial distribution or deployment.

Review the following before extended use:

- Anthropic usage policy: https://www.anthropic.com/legal/aup
- YouTube Terms of Service: https://www.youtube.com/t/terms

---

*AutoTublify is an educational project developed as part of a BSc IT cybersecurity curriculum.*
