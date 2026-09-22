// 附件持久引用：Host、Harness 与界面共享的数据契约，不包含文件内容。
export interface AttachmentExtraction {
  status: 'extracted' | 'partial' | 'failed';
  path?: string;
  sha256?: string;
  sizeBytes?: number;
  message?: string;
  /**
   * 产出该提取结果所用的提取逻辑版本（见 attachments/extraction-version.ts）。
   * 旧版本/缺失 = 产物过期：会话恢复时用现行逻辑重提，避免「代码已修但旧会话
   * 读到的还是旧产物」（如乱码闸门上线前落盘的二进制 .txt）。
   */
  extractorVersion?: string;
}
export interface TextAttachmentRef {
  name: string;
  path: string;
  sizeBytes?: number;
  sha256?: string;
  kind?: 'text' | 'binary';
  extraction?: AttachmentExtraction;
}
