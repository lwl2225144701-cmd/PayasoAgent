import type { PermissionMode } from './types';

export type LanguageMode = 'zh-CN' | 'en-US';
export type ConversationFontSize = number;

const STORAGE_KEYS = {
  permission: 'payaso.permissionMode',
  language: 'payaso.languageMode',
  fontSize: 'payaso.conversationFontSize',
} as const;

const DEFAULT_PERMISSION_MODE: PermissionMode = 'workspace-write';
const DEFAULT_LANGUAGE: LanguageMode = 'zh-CN';
const DEFAULT_FONT_SIZE: ConversationFontSize = 15;
const MIN_CONVERSATION_FONT_SIZE = 12;
const MAX_CONVERSATION_FONT_SIZE = 24;

function isPermissionMode(value: string | null): value is PermissionMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'full-access';
}

function isLanguageMode(value: string | null): value is LanguageMode {
  return value === 'zh-CN' || value === 'en-US';
}

function isConversationFontSize(value: string | null): boolean {
  if (value === null || value.trim() === '') return false;
  const size = Number(value);
  return Number.isInteger(size)
    && size >= MIN_CONVERSATION_FONT_SIZE
    && size <= MAX_CONVERSATION_FONT_SIZE;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage must not prevent the setting from working in this tab.
  }
}

export function readPermissionMode(): PermissionMode {
  const value = read(STORAGE_KEYS.permission);
  return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
}

export function savePermissionMode(mode: PermissionMode): void {
  write(STORAGE_KEYS.permission, mode);
}

export function readLanguageMode(): LanguageMode {
  const value = read(STORAGE_KEYS.language);
  return isLanguageMode(value) ? value : DEFAULT_LANGUAGE;
}

export function saveLanguageMode(mode: LanguageMode): void {
  write(STORAGE_KEYS.language, mode);
}

export function readConversationFontSize(): ConversationFontSize {
  const value = read(STORAGE_KEYS.fontSize);
  return isConversationFontSize(value) ? Number(value) : DEFAULT_FONT_SIZE;
}

export function saveConversationFontSize(size: ConversationFontSize): void {
  write(STORAGE_KEYS.fontSize, String(size));
}

export function applyConversationFontSize(size: ConversationFontSize): void {
  document.documentElement.dataset.conversationFontSize = String(size);
  document.documentElement.style.setProperty('--conversation-font-size', `${size}px`);
}

export {
  DEFAULT_FONT_SIZE,
  MAX_CONVERSATION_FONT_SIZE,
  MIN_CONVERSATION_FONT_SIZE,
};
