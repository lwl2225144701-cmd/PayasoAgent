import { useCallback, useEffect, useState } from 'react';
import {
  applyThemeMode,
  readThemeMode,
  saveThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from '../theme';

export function useThemeMode(): readonly [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => readThemeMode());

  useEffect(() => {
    applyThemeMode(mode);
    if (mode !== 'system') return undefined;
    return subscribeToSystemTheme(() => applyThemeMode('system'));
  }, [mode]);

  const updateMode = useCallback((nextMode: ThemeMode) => {
    saveThemeMode(nextMode);
    setMode(nextMode);
    applyThemeMode(nextMode);
  }, []);

  return [mode, updateMode] as const;
}
