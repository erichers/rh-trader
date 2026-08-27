import React, { useMemo, useState } from 'react';

// A reusable sortable + filterable table. Every column declares how to render and (optionally)
// how to sort/filter. Drop-in for any list — pass rows + columns. Sort state and the filter
// box are local; pass `storageKey` to persist the chosen sort across reloads.

export type Column<T> = {
  key: string;
  label: React.ReactNode;
  render?: (row: T) => React.ReactNode;     // cell content (defaults to row[key])
  sortValue?: (row: T) => number | string;  // comparable for sorting (defaults to row[key])
  filterValue?: (row: T) => string;         // text used by the filter box (defaults to rendered/raw)
  align?: 'left' | 'right' | 'center';
  className?: (row: T) => string;
  th?: React.CSSProperties;
  sortable?: boolean;                        // default true
};

function lsGet(k?: string): { key: string; dir: 1 | -1 } | null {
  if (!k) return null;
  try { const v = JSON.parse(localStorage.getItem('dt:' + k) || 'null'); return v && v.key ? v : null; } catch { return null; }
}
function lsSet(k: string | undefined, v: { key: string; dir: 1 | -1 } | null) {
  if (!k) return; try { localStorage.setItem('dt:' + k, JSON.stringify(v)); } catch { /* noop */ }
}

export function DataTable<T>({ rows, cols, initialSort, storageKey, filter = true, filterPlaceholder = 'filter…', empty = 'No rows.', pageSize, right, dense, rowKey }: {
  rows: T[];
  cols: Column<T>[];
  initialSort?: { key: string; dir?: 1 | -1 };
  storageKey?: string;
  filter?: boolean;
  filterPlaceholder?: string;
  empty?: React.ReactNode;
  pageSize?: number;
  right?: React.ReactNode;
  dense?: boolean;
  rowKey?: (row: T, i: number) => string | number; // unique React key (defaults to id/key/index)
}) {
  const saved = lsGet(storageKey);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(
    saved || (initialSort ? { key: initialSort.key, dir: initialSort.dir ?? -1 } : null),
  );
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const colByKey = useMemo(() => Object.fromEntries(cols.map((c) => [c.key, c])), [cols]);

  const raw = (row: any, k: string) => row?.[k];
  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) => cols.some((c) => {
      const fv = c.filterValue ? c.filterValue(r) : c.sortValue ? String(c.sortValue(r)) : String(raw(r, c.key) ?? '');
      return fv.toLowerCase().includes(needle);
    }));
  }, [rows, q, cols]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const c = colByKey[sort.key]; if (!c) return filtered;
    const val = (r: any) => (c.sortValue ? c.sortValue(r) : raw(r, c.key));
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv)) * sort.dir;
    });
  }, [filtered, sort, colByKey]);

  const pages = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const safePage = Math.min(page, pages - 1); // clamp when rows shrink on a polling refresh
  const view = pageSize ? sorted.slice(safePage * pageSize, (safePage + 1) * pageSize) : sorted;

  const onSort = (c: Column<T>) => {
    if (c.sortable === false) return;
    const next = sort && sort.key === c.key ? { key: c.key, dir: (sort.dir === -1 ? 1 : -1) as 1 | -1 } : { key: c.key, dir: -1 as const };
    setSort(next); lsSet(storageKey, next); setPage(0);
  };

  return (
    <div>
      {(filter || right) && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
          {filter ? (
            <div className="row" style={{ gap: 6 }}>
              <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={filterPlaceholder} style={{ width: 200 }} />
              {q && <button onClick={() => setQ('')} title="clear filter">×</button>}
              <span className="muted" style={{ fontSize: 11 }}>{filtered.length}{filtered.length !== rows.length ? ` of ${rows.length}` : ''}</span>
            </div>
          ) : <span />}
          {right}
        </div>
      )}
      <table className={dense ? 'dense' : undefined}>
        <thead>
          <tr>
            {cols.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} onClick={() => onSort(c)} style={{ cursor: c.sortable === false ? 'default' : 'pointer', textAlign: c.align, userSelect: 'none', whiteSpace: 'nowrap', ...c.th }}>
                  {c.label}{c.sortable === false ? '' : <span style={{ opacity: active ? 1 : 0.25, marginLeft: 3 }}>{active ? (sort!.dir === -1 ? '▾' : '▴') : '↕'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {view.length === 0 && <tr><td colSpan={cols.length} className="muted">{empty}</td></tr>}
          {view.map((row, i) => (
            <tr key={rowKey ? rowKey(row, i) : ((row as any).id ?? (row as any).key ?? i)}>
              {cols.map((c) => (
                <td key={c.key} style={{ textAlign: c.align }} className={c.className ? c.className(row) : undefined}>
                  {c.render ? c.render(row) : String(raw(row, c.key) ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {pageSize && pages > 1 && (
        <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 8 }}>
          <button disabled={safePage === 0} onClick={() => setPage(Math.max(0, safePage - 1))}>‹ prev</button>
          <span className="muted" style={{ fontSize: 12 }}>page {safePage + 1} / {pages}</span>
          <button disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>next ›</button>
        </div>
      )}
    </div>
  );
}
