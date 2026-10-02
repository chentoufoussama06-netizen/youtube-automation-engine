const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let cachedPath = null;

/**
 * Resolve the FFmpeg binary to use, in order of preference:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled binary from the optional ffmpeg-static package
 * 3. `ffmpeg` on the system PATH
 */
function getFFmpegPath() {
  if (cachedPath) {
    return cachedPath;
  }

  if (process.env.FFMPEG_PATH) {
    cachedPath = process.env.FFMPEG_PATH;
    return cachedPath;
  }

  try {
    cachedPath = require('ffmpeg-static');
  } catch (error) {
    cachedPath = null;
  }

  cachedPath = cachedPath || 'ffmpeg';
  return cachedPath;
}

async function checkFFmpeg() {
  try {
    await execFileAsync(getFFmpegPath(), ['-version']);
    return true;
  } catch (error) {
    return false;
  }
}

// Windows sometimes refuses to create the process for reasons that have nothing
// to do with the command — an antivirus scan holding the binary open, a
// momentary handle shortage. These arrive as a spawn-level errno rather than a
// non-zero ffmpeg exit, and they are gone a second later. On 2026-08-25 one
// EPERM at this exact call cost a 13-minute episode all 30 of its stock clips,
// so a render that took twenty minutes to reach here is worth a few retries.
const TRANSIENT_SPAWN_ERRORS = new Set([
  'EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETXTBSY'
]);

function isTransientSpawnFailure(error) {
  return Boolean(
    error
    && typeof error.syscall === 'string'
    && error.syscall.startsWith('spawn')
    && TRANSIENT_SPAWN_ERRORS.has(error.code)
  );
}

async function runFFmpeg(args, { retries = 3, retryDelayMs = 2000, onRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await execFileAsync(getFFmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      // Only process creation is retried. A non-zero ffmpeg exit means the
      // command itself is wrong, and running it again would fail identically.
      if (attempt > retries || !isTransientSpawnFailure(error)) {
        throw error;
      }
      if (onRetry) {
        onRetry(error, attempt);
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
}

function ffmpegInstallHint() {
  const hints = {
    win32: 'winget install Gyan.FFmpeg (then restart your terminal)',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg (or your distro equivalent)'
  };

  const platformHint = hints[process.platform] || 'https://ffmpeg.org/download.html';
  return `FFmpeg not found. Install it with: ${platformHint} — or run "npm install" again to fetch the bundled ffmpeg-static binary, or set FFMPEG_PATH to your ffmpeg executable.`;
}

module.exports = { getFFmpegPath, checkFFmpeg, runFFmpeg, ffmpegInstallHint };
