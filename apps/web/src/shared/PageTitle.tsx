import { createContext, useContext, type ReactNode } from 'react';

export const MobileMenuTriggerContext = createContext<ReactNode>(null);

export function PageTitle({
  children,
  mobileOnly = false,
}: {
  children: ReactNode;
  mobileOnly?: boolean;
}) {
  const menuTrigger = useContext(MobileMenuTriggerContext);
  if (!menuTrigger) return mobileOnly ? null : children;

  return (
    <div className="page-title-with-menu">
      {menuTrigger}
      {children}
    </div>
  );
}
