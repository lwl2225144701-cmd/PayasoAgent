export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'payaso.themeMode';

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Private browsing / blocked storage should not prevent theme switching.
  }
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyThemeMode(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveThemeMode(mode);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  root.style.colorScheme = resolved;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute('content', resolved === 'dark' ? '#0f1115' : '#f5f7fb');
  return resolved;
}

export function subscribeToSystemTheme(listener: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => listener();
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }
  media.addListener(onChange);
  return () => media.removeListener(onChange);
}
