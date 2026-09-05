import { type RefObject, useEffect } from 'react';

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  enabled: boolean,
  onClickOutside: () => void,
) {
  useEffect(() => {
    if (!enabled) return;
    function handlePointerDown(e: PointerEvent) {
      const el = ref.current;
      if (!el || el.contains(e.target as Node)) return;
      onClickOutside();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [ref, enabled, onClickOutside]);
}
