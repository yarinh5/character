import { useCallback, useRef, useState, type PointerEvent } from "react";

type SwipeGestureOptions = {
  disabled?: boolean;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  threshold?: number;
};

export function useSwipeGesture({
  disabled = false,
  onSwipeLeft,
  onSwipeRight,
  threshold = 96,
}: SwipeGestureOptions) {
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const reset = useCallback(() => {
    pointerIdRef.current = null;
    setDragX(0);
    setIsDragging(false);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      pointerIdRef.current = event.pointerId;
      startXRef.current = event.clientX;
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsDragging(true);
    },
    [disabled],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    setDragX(Math.max(-160, Math.min(160, event.clientX - startXRef.current)));
  }, []);

  const onPointerEnd = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (pointerIdRef.current !== event.pointerId) return;
      const offset = event.clientX - startXRef.current;
      reset();
      if (offset >= threshold) onSwipeRight();
      if (offset <= -threshold) onSwipeLeft();
    },
    [onSwipeLeft, onSwipeRight, reset, threshold],
  );

  return {
    dragX,
    isDragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: reset,
    },
  };
}
