/**
 * Auto-scroll that yields to the user.
 *
 * The rule every chat UI needs and many get wrong: follow new content while the
 * reader is at the bottom, and stop the moment they scroll up to read something.
 * Yanking a reader back down mid-sentence is the single most irritating bug in
 * a streaming feed, and with several threads streaming at once it happens
 * constantly unless it is handled explicitly.
 *
 * Returns a `pinned` flag so the UI can offer an explicit way back down.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** How close to the bottom still counts as "at the bottom", in pixels. */
const BOTTOM_THRESHOLD_PX = 48;

export function useStickyScroll<T extends HTMLElement>(dependency: unknown) {
  const ref = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);

  const handleScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setPinned(distanceFromBottom <= BOTTOM_THRESHOLD_PX);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element || !pinned) return;
    element.scrollTop = element.scrollHeight;
    // `dependency` is whatever changes when content grows; the effect
    // intentionally re-runs on every such change.
  }, [dependency, pinned]);

  return { ref, pinned, handleScroll, scrollToBottom };
}
