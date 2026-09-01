import { useCallback, useEffect, useState } from 'react';
import type { PermissionMode } from '../types';
import {
  applyConversationFontSize,
  readConversationFontSize,
  readLanguageMode,
  readPermissionMode,
  saveConversationFontSize,
  saveLanguageMode,
  savePermissionMode,
  type ConversationFontSize,
  type LanguageMode,
} from '../preferences';

export function useGeneralSettings() {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => readPermissionMode());
  const [language, setLanguage] = useState<LanguageMode>(() => readLanguageMode());
  const [fontSize, setFontSize] = useState<ConversationFontSize>(() => readConversationFontSize());

  useEffect(() => {
    savePermissionMode(permissionMode);
  }, [permissionMode]);

  useEffect(() => {
    saveLanguageMode(language);
    document.documentElement.dataset.language = language;
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    saveConversationFontSize(fontSize);
    applyConversationFontSize(fontSize);
  }, [fontSize]);

  const updatePermissionMode = useCallback((mode: PermissionMode) => {
    savePermissionMode(mode);
    setPermissionMode(mode);
  }, []);

  const updateLanguage = useCallback((mode: LanguageMode) => {
    saveLanguageMode(mode);
    setLanguage(mode);
  }, []);

  const updateFontSize = useCallback((size: ConversationFontSize) => {
    saveConversationFontSize(size);
    applyConversationFontSize(size);
    setFontSize(size);
  }, []);

  return {
    permissionMode,
    setPermissionMode: updatePermissionMode,
    language,
    setLanguage: updateLanguage,
    fontSize,
    setFontSize: updateFontSize,
  };
}
