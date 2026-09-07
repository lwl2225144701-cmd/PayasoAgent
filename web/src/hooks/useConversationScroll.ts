import { useLayoutEffect, useRef } from 'react';

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
    let frame = 0;
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
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(follow);
    });
    observer.observe(content);
    observer.observe(scroller);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [sessionId]);

  // Sending explicitly resumes following, even when reading an older turn.
  useLayoutEffect(() => {
    followingRef.current = true;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [sessionId, sentRunId]);

  return { scrollRef, contentRef };
}
