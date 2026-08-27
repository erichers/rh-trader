import React, { useMemo, useState } from 'react';
import { Icon } from './icons';

// Adjustable dashboard blocks: collapse, hide, and reorder cards — persisted in localStorage.
// The host passes an ordered list of items; BlockBoard handles layout + the "Customize" mode.

export type BlockItem = { id: string; title: React.ReactNode; node: React.ReactNode; right?: React.ReactNode; hidden?: boolean };

type Layout = { order: string[]; collapsed: string[]; hidden: string[] };
function load(key: string): Layout {
  try { const v = JSON.parse(localStorage.getItem('blocks:' + key) || 'null'); if (v && Array.isArray(v.order)) return v; } catch { /* noop */ }
  return { order: [], collapsed: [], hidden: [] };
}
function save(key: string, l: Layout) { try { localStorage.setItem('blocks:' + key, JSON.stringify(l)); } catch { /* noop */ } }

export function BlockBoard({ items, storageKey }: { items: BlockItem[]; storageKey: string }) {
  const [layout, setLayout] = useState<Layout>(() => load(storageKey));
  const [editing, setEditing] = useState(false);
  const set = (l: Layout) => { setLayout(l); save(storageKey, l); };

  // Merge persisted order with any new items (new items append; removed items drop out).
  const ordered = useMemo(() => {
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    const known = layout.order.filter((id) => byId[id]);
    const fresh = items.map((i) => i.id).filter((id) => !known.includes(id));
    return [...known, ...fresh].map((id) => byId[id]).filter(Boolean) as BlockItem[];
  }, [items, layout.order]);

  const isCollapsed = (id: string) => layout.collapsed.includes(id);
  const isHidden = (id: string) => layout.hidden.includes(id);
  const toggle = (arr: string[], id: string) => arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
  const move = (id: string, dir: -1 | 1) => {
    const order = ordered.map((i) => i.id);
    const idx = order.indexOf(id); const j = idx + dir;
    if (idx < 0 || j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j], order[idx]];
    set({ ...layout, order });
  };

  const hiddenItems = ordered.filter((i) => isHidden(i.id));

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        {editing && <button onClick={() => set({ order: items.map((i) => i.id), collapsed: [], hidden: [] })}>Reset layout</button>}
        <button className={editing ? 'primary icon-btn' : 'icon-btn'} onClick={() => setEditing(!editing)}>{editing ? <><Icon name="check" size={15} /> Done</> : <><Icon name="settings" size={15} /> Customize layout</>}</button>
      </div>

      {editing && hiddenItems.length > 0 && (
        <div className="card" style={{ borderColor: 'rgba(245,176,65,.3)' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Hidden blocks (click to restore):</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {hiddenItems.map((i) => <button key={i.id} onClick={() => set({ ...layout, hidden: toggle(layout.hidden, i.id) })}>+ {typeof i.title === 'string' ? i.title : i.id}</button>)}
          </div>
        </div>
      )}

      {ordered.map((it) => {
        if (isHidden(it.id) && !editing) return null;
        if (isHidden(it.id)) return null; // shown in the hidden tray above while editing
        const collapsed = isCollapsed(it.id);
        return (
          <section key={it.id} className="card" style={{ opacity: 1 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', cursor: editing ? 'default' : 'pointer' }} onClick={() => !editing && set({ ...layout, collapsed: toggle(layout.collapsed, it.id) })}>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <span style={{ opacity: 0.6 }}>{collapsed ? '▸' : '▾'}</span>
                <b>{it.title}</b>
              </div>
              <div className="row" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                {it.right}
                {editing && (
                  <span className="row" style={{ gap: 2 }}>
                    <button title="move up" onClick={() => move(it.id, -1)}>↑</button>
                    <button title="move down" onClick={() => move(it.id, 1)}>↓</button>
                    <button title="collapse" onClick={() => set({ ...layout, collapsed: toggle(layout.collapsed, it.id) })}>{collapsed ? 'expand' : 'collapse'}</button>
                    <button title="hide" className="danger" onClick={() => set({ ...layout, hidden: toggle(layout.hidden, it.id) })}>hide</button>
                  </span>
                )}
              </div>
            </div>
            {!collapsed && <div style={{ marginTop: 10 }}>{it.node}</div>}
          </section>
        );
      })}
    </div>
  );
}
