import { type RefObject, useEffect } from 'react';

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  enabled: boolean,
  onClickOutside: () => void,
  /** 额外忽略的元素（如下拉菜单的触发按钮）：点在它上面不算"外部"，交给它自己 toggle。 */
  ignoreRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!enabled) return;
    function handlePointerDown(e: PointerEvent) {
      const el = ref.current;
      if (el && el.contains(e.target as Node)) return;
      const ignore = ignoreRef?.current;
      if (ignore && ignore.contains(e.target as Node)) return;
      onClickOutside();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [ref, enabled, onClickOutside, ignoreRef]);
}
