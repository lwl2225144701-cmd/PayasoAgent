// Host 上传输入及预处理产物；正文只在创建附件时使用，不进入事件。
export interface CreateRunAttachmentInput {
  extraction?: {
    status: 'extracted' | 'partial' | 'failed';
    text?: string;
    message?: string;
    /** 提取逻辑版本（extraction-version.ts）；随产物发布，恢复时据此判定过期。 */
    extractorVersion?: string;
  };
  name: string;
  mimeType: string;
  dataBase64: string;
  /** 归一化后的图片尺寸；无法归一化时缺省。 */
  width?: number;
  height?: number;
  /** 归一化前的图片尺寸，例如 "5000x3000"。 */
  originalDimensions?: string;
}
