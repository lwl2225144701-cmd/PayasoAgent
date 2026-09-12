// Shared attachment contract used by Host request handling and Runtime
// normalization. Keeping it outside either layer prevents Runtime from
// depending on the Host facade for a data-only type.
export interface CreateRunAttachmentInput {
  name: string;
  mimeType: string;
  dataBase64: string;
  /** Normalized dimensions; absent when normalization was not available. */
  width?: number;
  height?: number;
  /** Original dimensions before normalization, for example "5000x3000". */
  originalDimensions?: string;
}
