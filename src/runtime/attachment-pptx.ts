// .pptx（OOXML 演示文稿）文本提取：文字在 ppt/slides/slideN.xml 的 <a:t>
// 文本节点里（DrawingML）。每张幻灯片一节，段落（</a:p>）转换行，换行符
// （<a:br/>）转 \n，制表（<a:tab/>）转 \t，其余结构剥掉。
// 开节点判定收紧为 '<a:t>' 或 '<a:t ' —— 避免把 <a:tab/> 等当成文本节点。
import { zipEntry, zipEntryNames } from './attachment-zip.js';

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function slideXmlToText(xml: string): string {
  let text = '';
  let position = 0;
  while (position < xml.length) {
    const tagStart = xml.indexOf('<', position);
    if (tagStart < 0) break;
    const tagEnd = xml.indexOf('>', tagStart);
    if (tagEnd < 0) break;
    const tag = xml.slice(tagStart, tagEnd + 1);
    if (tag === '</a:p>') text += '\n';
    else if (tag === '<a:br/>' || tag === '<a:br>') text += '\n';
    else if (tag === '<a:tab/>' || tag === '<a:tab>') text += '\t';
    else if ((tag === '<a:t>' || tag.startsWith('<a:t ')) && !tag.endsWith('/>')) {
      const close = xml.indexOf('</a:t>', tagEnd);
      if (close < 0) break;
      text += xml.slice(tagEnd + 1, close);
      position = close;
    }
    position = tagEnd + 1;
  }
  return decodeXmlEntities(text).replace(/\r\n/g, '\n');
}

/** 提取 .pptx 全部幻灯片文本；每张幻灯片以 "--- 幻灯片 N ---" 分节。 */
export function extractPptxText(bytes: Buffer): string {
  const slides = zipEntryNames(bytes)
    .map((name) => SLIDE_RE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  if (slides.length === 0) throw new Error('.pptx 缺少幻灯片（ppt/slides/slideN.xml）');
  const parts: string[] = [];
  for (const match of slides) {
    const xml = zipEntry(bytes, match[0]);
    if (!xml) continue;
    const text = slideXmlToText(xml.toString('utf8')).replace(/\n{3,}/g, '\n\n').trim();
    if (text) parts.push(`--- 幻灯片 ${match[1]} ---\n${text}`);
  }
  if (parts.length === 0) throw new Error('.pptx 未提取到文本');
  return parts.join('\n\n');
}
