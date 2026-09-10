import { useCallback, useLayoutEffect, useRef } from 'react';

// A session owns one scroller, regardless of how many turns it contains.
export function useConversationScroll(sessionId: string | null, sentRunId: string | null) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let previousTop = scroller.scrollTop;
    const follow = () => {
      if (!followingRef.current) return;
      scroller.scrollTop = scroller.scrollHeight;
      previousTop = scroller.scrollTop;
    };
    const onScroll = () => {
      const top = scroller.scrollTop;
      if (top < previousTop) followingRef.current = false;
      if (top + scroller.clientHeight >= scroller.scrollHeight - 24) {
        followingRef.current = true;
      }
      previousTop = top;
    };
    // ResizeObserver 回调发生在「布局之后、绘制之前」，所以直接在这里补齐滚动位置
    // 就能与内容增长在同一帧生效。此前多排一次 requestAnimationFrame 会把补齐推迟到
    // 下一帧：新内容先被画到视口之外，下一帧才被拉回来——流式时表现为末行一抖一抖。
    // 这里只写 scrollTop、不改变被观察元素的尺寸，不会触发 RO 循环告警。
    const observer = new ResizeObserver(() => {
      follow();
    });
    observer.observe(content);
    observer.observe(scroller);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [sessionId]);

  // Sending explicitly resumes following, even when reading an older turn.
  useLayoutEffect(() => {
    followingRef.current = true;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [sessionId, sentRunId]);

  // 手动导航到历史回合前必须暂停自动跟随：否则正在流式的回合会立刻把视图拉回底部，
  // 把 scrollIntoView 的平滑滚动打断。用户滚回底部时 onScroll 会自动恢复跟随。
  const stopFollowing = useCallback(() => {
    followingRef.current = false;
  }, []);

  return { scrollRef, contentRef, stopFollowing };
}
