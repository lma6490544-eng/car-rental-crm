import { InputTooltip } from '../../shared/InputTooltip';
import type { TooltipRef } from 'antd/es/tooltip';
import { cloneElement, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactElement, ReactNode } from 'react';

export default function CalendarEventTooltip({
  children,
  title,
}: {
  children: ReactElement<{
    onPointerMove?: (event: PointerEvent<HTMLElement>) => void;
  }>;
  title: ReactNode;
}) {
  const tooltip = useRef<TooltipRef>(null);
  const [cursorOffset, setCursorOffset] = useState(0);

  useLayoutEffect(() => {
    tooltip.current?.forceAlign();
  }, [cursorOffset]);

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const { left, width } = event.currentTarget.getBoundingClientRect();
    setCursorOffset(Math.round(left + width / 2 - event.clientX));
    children.props.onPointerMove?.(event);
  }

  return (
    <InputTooltip
      ref={tooltip}
      title={title}
      mouseEnterDelay={0.5}
      align={{
        targetOffset: [cursorOffset, 0],
        overflow: { shiftX: true, shiftY: true, adjustY: true },
      }}
    >
      {cloneElement(children, { onPointerMove: handlePointerMove })}
    </InputTooltip>
  );
}
