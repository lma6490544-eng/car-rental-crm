import { Tooltip, type TooltipProps } from 'antd';
import type { TooltipRef } from 'antd/es/tooltip';
import { createContext, useContext, type Ref } from 'react';

export const TouchInputContext = createContext(false);

export function InputTooltip(props: TooltipProps & { ref?: Ref<TooltipRef> }) {
  const touch = useContext(TouchInputContext);
  return (
    <Tooltip
      {...props}
      trigger={touch ? [] : (props.trigger ?? ['hover', 'focus'])}
      title={touch ? null : props.title}
    />
  );
}
