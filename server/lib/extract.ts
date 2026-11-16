import path from 'node:path';

export interface Extracted {
  kind: 'document' | 'image';
  status: 'ready' | 'no_text' | 'error';
  text: string;
  pages?: number;
  error?: string;
}

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.srt', '.vtt', '.log', '.tex', '.rtf',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.css',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp']);

export const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

export const isImageExt = (ext: string) => IMAGE_EXT.has(ext.toLowerCase());
export const isSupported = (ext: string) => {
  const e = ext.toLowerCase();
  return e === '.pdf' || e === '.docx' || TEXT_EXT.has(e) || IMAGE_EXT.has(e);
};

/** 文本解码：优先 UTF-8；失败时按 GB18030（中文 Windows 常见的 TXT 编码）再试。 */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const main = html.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return { title: stripHtml(title), text: tidy(stripHtml(main)) };
}

export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractText(buf: Uint8Array, filename: string): Promise<Extracted> {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (IMAGE_EXT.has(ext)) return { kind: 'image', status: 'ready', text: '' };

    if (ext === '.pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { totalPages, text } = await pdfText(pdf, { mergePages: false });
      const joined = tidy((text as string[]).map((t, i) => `${t}`.trim() && `[第 ${i + 1} 页]\n${t}`).filter(Boolean).join('\n\n'));
      if (joined.replace(/\[第 \d+ 页\]/g, '').trim().length < 20) {
        return { kind: 'document', status: 'no_text', text: '', pages: totalPages, error: '没有提取到文字。这份 PDF 可能是扫描件或纯图片，目前不支持 OCR。' };
      }
      return { kind: 'document', status: 'ready', text: joined, pages: totalPages };
    }

    if (ext === '.docx') {
      const mammoth = (await import('mammoth')).default;
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
      const text = tidy(value);
      if (!text) return { kind: 'document', status: 'no_text', text: '', error: '文档里没有可提取的文字。' };
      return { kind: 'document', status: 'ready', text };
    }

    if (ext === '.doc') {
      return { kind: 'document', status: 'error', text: '', error: '暂不支持旧版 .doc，请在 Word 中另存为 .docx 后重新上传。' };
    }

    if (TEXT_EXT.has(ext) || ext === '') {
      let text = decodeText(buf);
      if (ext === '.html' || ext === '.htm') text = htmlToText(text).text;
      text = tidy(text);
      if (!text) return { kind: 'document', status: 'no_text', text: '', error: '文件内容为空。' };
      return { kind: 'document', status: 'ready', text };
    }

    return { kind: 'document', status: 'error', text: '', error: `暂不支持 ${ext} 格式。支持 PDF、DOCX、TXT、Markdown 等文本文件和常见图片。` };
  } catch (err) {
    return { kind: 'document', status: 'error', text: '', error: `解析失败：${(err as Error).message}` };
  }
}

/** 按段落切片，目标约 size 个字符，片间保留少量重叠以免割裂上下文。 */
export function chunkText(text: string, size = 1100, overlap = 120): string[] {
  const paras = text.split(/\n{2,}/).flatMap((p) => {
    if (p.length <= size) return [p];
    const parts: string[] = [];
    let rest = p;
    while (rest.length > size) {
      let cut = Math.max(rest.lastIndexOf('。', size), rest.lastIndexOf('\n', size), rest.lastIndexOf('. ', size));
      if (cut < size * 0.5) cut = size;
      parts.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest.trim()) parts.push(rest);
    return parts;
  });
  const chunks: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur.trim());
      cur = cur.slice(-overlap) + '\n\n' + p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
