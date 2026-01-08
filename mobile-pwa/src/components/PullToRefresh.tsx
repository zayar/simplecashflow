import React from 'react';

type PullToRefreshProps = {
  isRefreshing: boolean;
  pullDistance: number;
  threshold?: number;
};

export function PullToRefreshIndicator({
  isRefreshing,
  pullDistance,
  threshold = 80
}: PullToRefreshProps) {
  const progress = Math.min(pullDistance / threshold, 1);
  const showIndicator = pullDistance > 10 || isRefreshing;

  if (!showIndicator) return null;

  return (
    <div
      className="flex items-center justify-center overflow-hidden transition-all duration-150"
      style={{ height: isRefreshing ? 48 : pullDistance }}
    >
      <div
        className={`flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 ${
          isRefreshing ? 'animate-spin' : ''
        }`}
        style={{
          transform: isRefreshing ? undefined : `rotate(${progress * 360}deg)`,
          opacity: Math.max(0.3, progress)
        }}
      >
        {isRefreshing ? (
          <svg className="h-5 w-5 text-primary" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        ) : (
          <svg
            className="h-5 w-5 text-primary"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19 14l-7 7m0 0l-7-7m7 7V3"
            />
          </svg>
        )}
      </div>
    </div>
  );
}

