'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Fit the desktop heading around the hero's metadata and actions. */
export function FeaturedTitle({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const title = ref.current;
    const main = title?.parentElement;
    if (!title || !main) return;

    const siblings = Array.from(main.children).filter(
      (element) => element !== title,
    );
    const fit = () => {
      title.style.removeProperty('font-size');
      if (!main.clientHeight) return;

      const style = getComputedStyle(main);
      const available =
        main.clientHeight -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom) -
        siblings.reduce((height, element) => {
          const siblingStyle = getComputedStyle(element);
          return (
            height +
            element.getBoundingClientRect().height +
            parseFloat(siblingStyle.marginTop) +
            parseFloat(siblingStyle.marginBottom)
          );
        }, 0);
      if (available <= 0) return;

      let upper = parseFloat(getComputedStyle(title).fontSize);
      let lower = 1;
      const fits = () =>
        title.getBoundingClientRect().height <= available &&
        title.scrollWidth <= title.clientWidth;
      if (fits()) return;

      // Search by rendered size so Hebrew, wrapping, and loaded fonts all fit.
      while (upper - lower > 0.25) {
        const size = (lower + upper) / 2;
        title.style.fontSize = `${size}px`;
        if (fits()) lower = size;
        else upper = size;
      }
      title.style.fontSize = `${lower}px`;
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(main);
    siblings.forEach((element) => observer.observe(element));
    window.addEventListener('resize', fit);
    document.fonts.addEventListener('loadingdone', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
      document.fonts.removeEventListener('loadingdone', fit);
    };
  }, [children]);

  return <h2 ref={ref}>{children}</h2>;
}
