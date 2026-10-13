/** Shared by the downloader, media relay and service worker build. */
export const AUDIO_CACHE = 'yutorah-audio-v1';
export const DOWNLOAD_DB = 'yutorah-downloads-v1';
export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const offlineAudioPath = (id: number) => '/offline-audio/' + id;
export const audioDownloadPath = (id: number) => '/api/audio-download?id=' + id;
export function downloadSize(bytes: number) {
  if (!bytes) return '0 MB';
  return bytes < 1_000_000
    ? Math.ceil(bytes / 1000) + ' KB'
    : (bytes / 1_000_000).toFixed(1) + ' MB';
}
