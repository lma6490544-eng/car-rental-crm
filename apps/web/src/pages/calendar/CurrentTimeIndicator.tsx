import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DAY_MS, moscowDateTimeInput, moscowDayStart } from '../../shared/moscowTime';

const DAY_MINUTES = 24 * 60;

type CurrentTimeIndicatorProps = {
  from: number;
  to: number;
  dayWidth: number;
};

type MoscowClock = {
  dayStart: number;
  minutes: number;
  label: string;
};

const moscowClock = (value: number): MoscowClock => {
  const dateTime = moscowDateTimeInput(value);
  const hours = Number(dateTime.slice(11, 13));
  const minutes = Number(dateTime.slice(14, 16));

  return {
    dayStart: moscowDayStart(dateTime.slice(0, 10)),
    minutes: hours * 60 + minutes,
    label: dateTime.slice(11, 16),
  };
};

export default function CurrentTimeIndicator({ from, to, dayWidth }: CurrentTimeIndicatorProps) {
  const [now, setNow] = useState(() => Date.now());
  const layerRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const scroller = layer?.closest<HTMLElement>('.calendar-grid');
    if (!layer || !scroller) return;
    // The sticky header covers the line while the dot stays above it during vertical scrolling.
    const updateHorizontalClip = () => {
      const clip = `inset(0 0 0 calc(${scroller.scrollLeft}px + var(--calendar-label-width)))`;
      layer.style.clipPath = clip;
      if (markerLayerRef.current) markerLayerRef.current.style.clipPath = clip;
    };
    updateHorizontalClip();
    scroller.addEventListener('scroll', updateHorizontalClip, { passive: true });
    return () => scroller.removeEventListener('scroll', updateHorizontalClip);
  }, []);

  useEffect(() => {
    let interval: number | undefined;
    const update = () => setNow(Date.now());
    const timeout = window.setTimeout(
      () => {
        update();
        interval = window.setInterval(update, 60_000);
      },
      60_000 - (Date.now() % 60_000),
    );

    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);

  const clock = moscowClock(now);
  const visible = clock.dayStart >= from && clock.dayStart < to;

  const dayIndex = (clock.dayStart - from) / DAY_MS;
  const timeOffset = (dayIndex + clock.minutes / DAY_MINUTES) * dayWidth;
  const left = `calc(var(--calendar-label-width) + ${timeOffset}px)`;

  // Sticky group headers paint their own continuation above their opaque background.
  useLayoutEffect(() => {
    const content = layerRef.current?.parentElement;
    if (!content) return;
    content.style.setProperty('--current-time-left', visible ? left : '-20px');
    return (): void => {
      content.style.removeProperty('--current-time-left');
    };
  }, [left, visible]);

  return (
    <>
      <div ref={layerRef} className="current-time-indicator-layer" aria-hidden={!visible}>
        {visible && (
          <div
            className="current-time-indicator"
            style={{ left }}
            aria-label={`Текущее московское время: ${clock.label}`}
            data-time={clock.label}
          />
        )}
      </div>
      <div
        ref={markerLayerRef}
        className="current-time-indicator-layer current-time-indicator-marker-layer"
        aria-hidden="true"
      >
        {visible && (
          <div className="current-time-indicator-marker-track" style={{ left }}>
            <div className="current-time-indicator-marker">
              <span className="current-time-indicator-dot" />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
