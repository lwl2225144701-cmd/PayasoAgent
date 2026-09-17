// .docx（OOXML）文本提取：正文在 word/document.xml 的 <w:t> 文本节点里，
// zip 解析复用 attachment-zip.ts（零新依赖 —— sharp 走可选依赖的先例，包体积
// 是 npm 分发的硬约束）。输出契约：段落（</w:p>）转换行、表格单元格
// </w:tc> 转制表、表格行 </w:tr> 转换行（TSV）、<w:tab/> 转制表、<w:br/> 转
// 换行，其余 XML 结构全部剥掉，只留可见文本；XML 实体解码；mc:Fallback
// （同内容的 VML 降级副本）整体剥离防双份提取。
import { openZip } from './zip.js';

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

// mc:Fallback 是 mc:Choice 同内容的旧格式（VML）降级副本 —— 不剥会双份提取。
function removeMcFallback(xml: string): string {
  let output = '';
  let cursor = 0;
  for (;;) {
    const start = xml.indexOf('<mc:Fallback>', cursor);
    if (start < 0) return output + xml.slice(cursor);
    output += xml.slice(cursor, start);
    let depth = 1;
    const tagRe = /<\/?mc:Fallback>/g;
    tagRe.lastIndex = start + 13;
    for (;;) {
      const match = tagRe.exec(xml);
      if (!match) return output; // 未闭合：丢弃余下内容，不让损坏文件拖垮解析
      depth += match[0][1] === '/' ? -1 : 1;
      if (depth === 0) {
        cursor = match.index + match[0].length;
        break;
      }
    }
  }
}

// document.xml 里可见文本只存在于 <w:t>；结构信号（段落/换行/制表/表格）是
// 自闭合或闭标签，直接在流式扫描里翻成纯文本控制符。
// 开节点判定必须是 '<w:t>' 或 '<w:t '（带属性）—— 宽松的 startsWith('<w:t')
// 会把 <w:tc>/<w:tr>/<w:tbl>/<w:type> 全当成文本节点，把整段表格 XML 吞进
// 输出（曾导致表格内容"重复膨胀 + 单元格缺失"）。
function documentXmlToText(xml: string): string {
  let text = '';
  let position = 0;
  while (position < xml.length) {
    const tagStart = xml.indexOf('<', position);
    if (tagStart < 0) break;
    const tagEnd = xml.indexOf('>', tagStart);
    if (tagEnd < 0) break;
    const tag = xml.slice(tagStart, tagEnd + 1);
    if (tag === '</w:p>' || tag === '<w:br/>' || tag === '<w:br>') {
      // 单元格末段紧跟 </w:tc>：换行交给单元格分隔符，避免每格多出一个空行
      if (!xml.startsWith('</w:tc>', tagEnd + 1)) text += '\n';
    } else if (tag === '</w:tc>') {
      text += '\t'; // 表格单元格 → 制表符（TSV 列）
    } else if (tag === '</w:tr>') {
      // 行尾若悬着一个单元格分隔符，收掉后再换行（TSV 行干净收口）
      if (text.endsWith('\t')) text = text.slice(0, -1);
      text += '\n'; // 表格行 → 换行（TSV 行）
    } else if (tag === '<w:tab/>' || tag === '<w:tab>') text += '\t';
    else if ((tag === '<w:t>' || tag.startsWith('<w:t ')) && !tag.endsWith('/>')) {
      const close = xml.indexOf('</w:t>', tagEnd);
      if (close < 0) break;
      text += xml.slice(tagEnd + 1, close);
      position = close + 6;
      continue;
    }
    position = tagEnd + 1;
  }
  return decodeXmlEntities(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n'); // 空段落/空单元格堆出的连续空行压成一行
}

/** 提取 .docx 正文纯文本；非 zip / 缺正文 / 解包失败一律抛错。 */
export function extractDocxText(bytes: Buffer): string {
  const zip = openZip(bytes);
  const document = zip.read('word/document.xml');
  if (!document) throw new Error('.docx 缺少正文（word/document.xml）');
  return documentXmlToText(removeMcFallback(document.toString('utf8')));
}
