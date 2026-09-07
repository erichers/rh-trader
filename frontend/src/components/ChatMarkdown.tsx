import type { ReactNode } from 'react';

/** Words that look like tickers but are prose / macro labels. */
const TICKER_STOP = new Set([
  'AND', 'OR', 'THE', 'FOR', 'TO', 'ON', 'IN', 'AT', 'OF', 'VS', 'BE', 'IS', 'IT',
  'WE', 'MY', 'ALL', 'NOT', 'NO', 'YES', 'IF', 'CEO', 'CFO', 'IPO', 'ETF', 'ETFS',
  'USD', 'GDP', 'CPI', 'PPI', 'FOMC', 'ATH', 'ATL', 'RSI', 'SMA', 'EMA', 'YOY',
  'QOQ', 'YTD', 'DTE', 'ITM', 'OTM', 'ATM', 'IV', 'PE', 'EPS', 'AI', 'USA', 'FED',
]);

function safeHref(href: string): string | null {
  const h = String(href || '').trim();
  if (!h) return null;
  if (h.startsWith('#/')) return h;
  if (/^https?:\/\//i.test(h)) return h;
  return null;
}

function ExternalOrAppLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <>{children}</>;
  if (safe.startsWith('#/')) {
    const ticker = safe.match(/^#\/ticker\/([A-Z.]{1,12})$/i);
    return (
      <a className={ticker ? 'symlink' : undefined} href={safe} title={ticker ? `Open ${ticker[1].toUpperCase()} detail` : undefined}>
        {children}
      </a>
    );
  }
  return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function linkTickers(text: string, keyPrefix: string): ReactNode[] {
  const re = /\$?[A-Z]{1,5}(?:\/[A-Z]{1,5})+|\b[A-Z]{2,5}\b/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const start = m.index;
    if (start > last) out.push(text.slice(last, start));
    const parts = raw.replace(/^\$/, '').split('/');
    const linkable = parts.every((p) => !TICKER_STOP.has(p) && /^[A-Z]{2,5}$/.test(p));
    if (!linkable) {
      out.push(raw);
    } else {
      parts.forEach((p, i) => {
        if (i) out.push('/');
        out.push(
          <a key={`${keyPrefix}-t${n++}`} className="symlink" href={`#/ticker/${p}`} title={`Open ${p} detail`}>{p}</a>,
        );
      });
    }
    last = start + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  // [news id:14] / [news #14] → in-app news link (real https cites are normal markdown links).
  const pre = text.replace(/\[news\s*(?:id|#)\s*:\s*(\d+)\]/gi, '[news #$1](#/news)');
  const tokenRe = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = tokenRe.exec(pre))) {
    if (m.index > last) out.push(...linkTickers(pre.slice(last, m.index), `${keyPrefix}-${n}`));
    if (m[1] != null) {
      out.push(<code key={`${keyPrefix}-c${n}`}>{m[1]}</code>);
    } else if (m[2] != null) {
      out.push(<ExternalOrAppLink key={`${keyPrefix}-a${n}`} href={m[3]}>{m[2]}</ExternalOrAppLink>);
    } else {
      out.push(<strong key={`${keyPrefix}-b${n}`}>{linkTickers(m[4] ?? m[5] ?? '', `${keyPrefix}-b${n}`)}</strong>);
    }
    n += 1;
    last = m.index + m[0].length;
  }
  if (last < pre.length) out.push(...linkTickers(pre.slice(last), `${keyPrefix}-t`));
  return out;
}

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] };

function parseBlocks(src: string): Block[] {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    const text = para.join(' ').replace(/\s+/g, ' ').trim();
    para = [];
    if (text) blocks.push({ t: 'p', text });
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push(list);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ t: 'h', level: heading[1].length, text: heading[2] });
      continue;
    }
    if (ul) {
      flushPara();
      if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; }
      list.items.push(ul[1]);
      continue;
    }
    if (ol) {
      flushPara();
      if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

/** Safe Markdown subset for Ask AI bubbles: headings, bold, lists, links. No raw HTML. */
export function ChatMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.t === 'h') {
          const Tag = (b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
          return <Tag key={i}>{renderInline(b.text, `h${i}`)}</Tag>;
        }
        if (b.t === 'ul') {
          return (
            <ul key={i}>
              {b.items.map((item, j) => <li key={j}>{renderInline(item, `u${i}-${j}`)}</li>)}
            </ul>
          );
        }
        if (b.t === 'ol') {
          return (
            <ol key={i}>
              {b.items.map((item, j) => <li key={j}>{renderInline(item, `o${i}-${j}`)}</li>)}
            </ol>
          );
        }
        return <p key={i}>{renderInline(b.text, `p${i}`)}</p>;
      })}
    </div>
  );
}
