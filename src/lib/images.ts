import { api } from './api';

// Markdown stores images by repo-relative path (img/x.png, task-notes/img/x.png)
// so notes stay portable. The editors need a URL the browser can load, so
// content is converted on the way in and back on the way out.

const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

// Splits "url" or `url "title"` or `url 'title'` into [url, title].
function splitUrlTitle(raw: string): [string, string] {
  const m = raw.match(/^(\S+)(?:\s+(["'(].*["')]\s*))?$/);
  return m ? [m[1], m[2] ?? ''] : [raw, ''];
}

function rewrite(content: string, map: (src: string) => string): string {
  return content.replace(IMAGE_MD_RE, (match, alt, raw) => {
    const [src, title] = splitUrlTitle(raw);
    const next = map(src);
    if (next === src) return match;
    return title ? `![${alt}](${next} ${title})` : `![${alt}](${next})`;
  });
}

/** Stored markdown → markdown the editor can display. */
export function toDisplayMarkdown(content: string): string {
  return rewrite(content, (src) => (/^(https?:|data:|blob:)/.test(src) ? src : api.resolveImageUrl(src)));
}

/** Editor markdown → markdown to store. */
export function toStoredMarkdown(content: string): string {
  return rewrite(content, (src) => (src.startsWith('blob:') ? api.unresolveImageUrl(src) : src));
}
