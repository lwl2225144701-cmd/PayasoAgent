// 附件持久引用：Host、Harness 与界面共享的数据契约，不包含文件内容。
export interface AttachmentExtraction {
  status: 'extracted' | 'partial' | 'failed';
  path?: string;
  sha256?: string;
  sizeBytes?: number;
  message?: string;
}
export interface TextAttachmentRef {
  name: string;
  path: string;
  sizeBytes?: number;
  sha256?: string;
  kind?: 'text' | 'binary';
  extraction?: AttachmentExtraction;
}
