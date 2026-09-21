/** Persisted sidebar collapse. Default expanded. */

export const SIDEBAR_COLLAPSED_KEY = 'rh.sidebar.collapsed';

export type SidebarStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function readSidebarCollapsed(storage: SidebarStorage | null | undefined): boolean {
  try {
    return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(storage: SidebarStorage | null | undefined, collapsed: boolean): void {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* private mode or a blocked store */
  }
}
