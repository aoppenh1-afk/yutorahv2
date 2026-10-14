export type Segment = {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  language: string | null;
};
