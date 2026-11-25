import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ConfigProvider, theme } from 'antd';
import ruRU from 'antd/locale/ru_RU';

type ThemeMode = 'dark' | 'light';
const storageKey = 'avtoliga.theme';
const ThemeContext = createContext<{ mode: ThemeMode; setMode: (mode: ThemeMode) => void } | null>(
  null,
);
const palettes = {
  dark: {
    background: '#0B1724',
    surface: '#102235',
    elevated: '#1A2A3B',
    text: '#F1F5F9',
    muted: '#9BAABD',
    border: '#26384A',
    accent: '#E8C477',
    selected: '#282D2C',
  },
  light: {
    background: '#F4F6F8',
    surface: '#FFFFFF',
    elevated: '#FFFFFF',
    text: '#172B40',
    muted: '#64768A',
    border: '#D5DEE7',
    accent: '#8D681F',
    selected: '#F5E9D1',
  },
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      return localStorage.getItem(storageKey) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      /* Theme switching also works when browser storage is unavailable. */
    }
  }, [mode]);
  const value = useMemo(() => ({ mode, setMode }), [mode]);
  const p = palettes[mode];
  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        locale={ruRU}
        theme={{
          algorithm: mode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: {
            colorPrimary: p.accent,
            colorBgBase: p.background,
            colorBgLayout: p.background,
            colorBgContainer: p.surface,
            colorBgElevated: p.elevated,
            colorTextBase: p.text,
            colorText: p.text,
            colorTextSecondary: p.muted,
            colorBorder: p.border,
            borderRadius: 6,
            fontFamily: 'Inter, Segoe UI, sans-serif',
          },
          components: {
            Layout: { bodyBg: p.background, siderBg: 'transparent' },
            Menu: {
              itemBg: 'transparent',
              activeBarBorderWidth: 0,
              itemSelectedBg: p.selected,
              itemSelectedColor: p.accent,
              itemHoverBg: mode === 'dark' ? '#1A2A3B' : '#EFF3F7',
              darkItemBg: 'transparent',
              darkItemSelectedBg: p.selected,
              darkItemSelectedColor: p.accent,
              darkItemHoverBg: '#1A2A3B',
            },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is required');
  return value;
}
