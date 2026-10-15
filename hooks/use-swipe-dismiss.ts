'use client';

import { useCallback } from 'react';

// Use native listeners so a downward drag can prevent the browser's scroll
// gesture. React's delegated touch listeners are passive.
export function useSwipeDismiss(enabled: boolean, onDismiss: () => void) {
  return useCallback(
    (element: HTMLDivElement | null) => {
      if (!element || !enabled) return;
      let gesture: {
        id: number;
        x: number;
        y: number;
        dragging: boolean;
      } | null = null;
      let distance = 0;

      const reset = () => {
        gesture = null;
        distance = 0;
        element.removeAttribute('data-swiping');
        element.style.removeProperty('--swipe-offset');
      };
      const start = (event: TouchEvent) => {
        reset();
        if (event.touches.length !== 1 || element.scrollTop > 0) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (
          target.closest(
            'button, a, input, textarea, select, [role="slider"], [contenteditable="true"]',
          )
        )
          return;
        // A nested transcript/notes scroller must also be at its top.
        for (let node = target; node !== element; node = node.parentElement!) {
          if (node.scrollTop > 0) return;
        }
        const touch = event.touches[0];
        gesture = {
          id: touch.identifier,
          x: touch.clientX,
          y: touch.clientY,
          dragging: false,
        };
      };
      const move = (event: TouchEvent) => {
        if (!gesture) return;
        if (event.touches.length !== 1) {
          reset();
          return;
        }
        const touch = event.touches[0];
        if (touch.identifier !== gesture.id) return;
        const dx = touch.clientX - gesture.x;
        const dy = touch.clientY - gesture.y;
        if (!gesture.dragging) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
          // Lock direction for this gesture, preserving upward/horizontal scroll.
          if (dy <= Math.abs(dx) || element.scrollTop > 0) {
            reset();
            return;
          }
          gesture.dragging = true;
        }
        if (!event.cancelable) {
          reset();
          return;
        }
        event.preventDefault();
        distance = Math.max(0, dy);
        element.setAttribute('data-swiping', '');
        element.style.setProperty('--swipe-offset', `${distance}px`);
      };
      const end = () => {
        const dismiss = gesture?.dragging && distance >= 80;
        reset();
        if (dismiss) onDismiss();
      };

      element.addEventListener('touchstart', start, { passive: true });
      element.addEventListener('touchmove', move, { passive: false });
      element.addEventListener('touchend', end);
      element.addEventListener('touchcancel', reset);
      return () => {
        reset();
        element.removeEventListener('touchstart', start);
        element.removeEventListener('touchmove', move);
        element.removeEventListener('touchend', end);
        element.removeEventListener('touchcancel', reset);
      };
    },
    [enabled, onDismiss],
  );
}
