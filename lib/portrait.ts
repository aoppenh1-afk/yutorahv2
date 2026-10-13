/** The same portrait choices are used on screen and when saving offline. */
export function portraitSources(src: string) {
  if (!src || /_default\.|missingpicture/i.test(src)) return [];
  const match =
    /^(https:\/\/cdnyutorah\.cachefly\.net\/_images\/roshei_yeshiva\/[^?#]+?)(?:_o|_lp)?(\.(?:jpe?g|png))$/i.exec(
      src,
    );
  const original = match ? `${match[1]}_lp${match[2]}` : src;
  return original === src ? [src] : [original, src];
}
