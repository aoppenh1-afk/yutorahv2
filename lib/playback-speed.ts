export const MIN_PLAYBACK_SPEED = 0.75;
export const MAX_PLAYBACK_SPEED = 3;
export const PLAYBACK_SPEED_STEP = 0.25;
export const PLAYBACK_SPEEDS = Array.from(
  {
    length: (MAX_PLAYBACK_SPEED - MIN_PLAYBACK_SPEED) / PLAYBACK_SPEED_STEP + 1,
  },
  (_, index) => MIN_PLAYBACK_SPEED + index * PLAYBACK_SPEED_STEP,
);
