// 附件提取逻辑的 schema 版本。**提升提取行为时 +1**：事件里的 extraction
// 带此版本，恢复历史附件时比对判定产物是否过期，过期则用现行逻辑重提
// （refresh-extraction.ts）。这保证提取逻辑升级后，老会话不会再读到
// 旧代码落盘的产物。
export const EXTRACTOR_VERSION = '2';