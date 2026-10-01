export type Segment = {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  language: string | null;
};
export type Range = {
  coreStart: number;
  coreEnd: number;
  start: number;
  end: number;
};
export type Transcript = {
  schemaVersion: 1;
  text: string;
  segments: Segment[];
  durationMs: number;
};
export type Settings = {
  model: string;
  language: 'hebrewEnglish' | 'english';
  speakers: boolean;
};
export const versions = {
  pipeline: '1',
  prompt: 'lectern-1',
  parser: 'timed-1',
  preparation: 'ffmpeg-aac-1',
  merge: 'lectern-1',
};
export const defaultSettings: Settings = {
  model: 'gemini-3.8-flash-medium',
  language: 'hebrewEnglish',
  speakers: true,
};
