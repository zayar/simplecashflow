import { useCallback, useRef, useState, useEffect } from 'react';

type UsePullToRefreshOptions = {
  onRefresh: () => Promise<void>;
  threshold?: number; // pixels to pull before triggering
};

type UsePullToRefreshResult = {
  isRefreshing: boolean;
  pullDistance: number;
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
  };
  containerRef: React.RefObject<HTMLDivElement | null>;
};

export function usePullToRefresh({
  onRefresh,
  threshold = 80
}: UsePullToRefreshOptions): UsePullToRefreshResult {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const startY = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (isRefreshing) return;
    // Only start if scrolled to top
    const container = containerRef.current;
    if (container && container.scrollTop > 0) return;
    if (window.scrollY > 0) return;
    startY.current = e.touches[0].clientY;
  }, [isRefreshing]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (isRefreshing) return;
    if (startY.current === 0) return;
    
    const currentY = e.touches[0].clientY;
    const diff = currentY - startY.current;
    
    // Only pull down, not up
    if (diff < 0) {
      setPullDistance(0);
      return;
    }
    
    // Apply resistance (diminishing returns)
    const resistance = 0.4;
    const pull = Math.min(diff * resistance, threshold * 1.5);
    setPullDistance(pull);
  }, [isRefreshing, threshold]);

  const onTouchEnd = useCallback(async () => {
    if (isRefreshing) return;
    
    if (pullDistance >= threshold) {
      setIsRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
      }
    }
    
    setPullDistance(0);
    startY.current = 0;
  }, [isRefreshing, pullDistance, threshold, onRefresh]);

  // Reset pull distance when refreshing completes
  useEffect(() => {
    if (!isRefreshing) {
      setPullDistance(0);
    }
  }, [isRefreshing]);

  return {
    isRefreshing,
    pullDistance,
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd
    },
    containerRef
  };
}

