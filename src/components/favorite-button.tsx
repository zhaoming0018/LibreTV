'use client';

/**
 * 收藏按钮：
 * - 未收藏：点开弹目录菜单，选一个目录即收藏；
 * - 已收藏：星标金色，菜单里可「移动目录」或「取消收藏」；
 * - 菜单底部可新建目录（回车提交）。
 * 数据落在 IndexedDB（与观看历史同库），单用户本地存储。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addFavorite,
  addFavoriteFolder,
  getFavorite,
  listFavoriteFolders,
  moveFavorite,
  removeFavorite,
  type FavoriteEntry,
  type FavoriteFolderEntry,
} from '@/lib/db';
import { useToast } from './toast';
import { Icon } from './icon';
import { cn } from '@/lib/utils';

export interface FavoriteSubject {
  sourceKey: string;
  sourceUrl?: string;
  sourceName?: string;
  vodId: string;
  title: string;
  pic?: string;
  typeName?: string;
  year?: string;
  remarks?: string;
}

export function FavoriteButton({
  subject,
  className,
  size = 'md',
  showLabel = false,
  onChanged,
}: {
  subject: FavoriteSubject;
  className?: string;
  /** sm：卡片角标；md：详情页常规按钮 */
  size?: 'sm' | 'md';
  showLabel?: boolean;
  /** 收藏状态变化后通知父级刷新列表 */
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [fav, setFav] = useState<FavoriteEntry | null>(null);
  const [folders, setFolders] = useState<FavoriteFolderEntry[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const [f, fs] = await Promise.all([
      getFavorite(subject.sourceKey, subject.vodId),
      listFavoriteFolders(),
    ]);
    setFav(f ?? null);
    setFolders(fs);
  }, [subject.sourceKey, subject.vodId]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  // 点击组件外部 / Esc 关闭菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDismiss = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [open]);

  // 菜单用 fixed 定位并挂到 body：卡片有 overflow-hidden，内联菜单会被裁掉
  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) {
      setOpen(true);
      return;
    }
    const width = 208;
    const right = Math.max(8, window.innerWidth - r.right);
    const spaceBelow = window.innerHeight - r.bottom;
    setMenuStyle(
      spaceBelow < 260
        ? { position: 'fixed', right, bottom: window.innerHeight - r.top + 6, width, zIndex: 80, maxHeight: Math.min(360, r.top - 12) }
        : { position: 'fixed', right, top: r.bottom + 6, width, zIndex: 80, maxHeight: Math.min(360, spaceBelow - 12) }
    );
    setOpen(true);
  };

  const pick = async (folderId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (fav) {
        await moveFavorite(subject.sourceKey, subject.vodId, folderId);
        toast('已移动收藏目录', 'success');
      } else {
        await addFavorite({ ...subject, folderId });
        const name = folders.find((f) => f.id === folderId)?.name ?? '';
        toast(`已收藏到「${name}」`, 'success');
      }
      await refresh();
      onChanged?.();
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : '收藏失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const createAndPick = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const folder = await addFavoriteFolder(name);
      setNewName('');
      await pick(folder.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : '新建目录失败', 'error');
      setBusy(false);
    }
  };

  const unfavorite = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await removeFavorite(subject.sourceKey, subject.vodId);
      toast('已取消收藏', 'success');
      await refresh();
      onChanged?.();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const btnCls =
    size === 'sm'
      ? 'p-1.5 rounded-md bg-black/55 text-white/90 hover:bg-black/75 backdrop-blur-sm'
      : 'btn-ghost btn-sm';

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        className={cn(btnCls, 'transition-colors', showLabel && 'flex items-center gap-1.5')}
        title={fav ? '已收藏（点击管理）' : '收藏'}
        aria-label={fav ? '已收藏，点击管理' : '收藏'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          toggleMenu();
        }}
      >
        <Icon
          name={fav ? 'starFilled' : 'star'}
          className={cn(size === 'sm' ? 'w-5 h-5' : 'w-4 h-4', fav ? 'text-amber-400' : '')}
        />
        {showLabel && <span className="hidden sm:inline">{fav ? '已收藏' : '收藏'}</span>}
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="rounded-lg border border-line bg-surface-raised shadow-xl py-1.5 animate-fade-in overflow-y-auto scrollbar-thin"
            style={menuStyle}
            role="menu"
            onClick={(e) => e.stopPropagation()}
          >
          <p className="px-3 py-1 text-[11px] text-faint">{fav ? '移动到目录' : '收藏到目录'}</p>
          {fav && (
            <button
              type="button"
              role="menuitem"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-red-500 hover:bg-hover transition-colors"
              onClick={unfavorite}
            >
              <Icon name="trash" className="w-4 h-4 shrink-0" />
              取消收藏
            </button>
          )}
          <div className="max-h-56 overflow-y-auto scrollbar-thin">
            {folders.map((f) => (
              <button
                key={f.id}
                type="button"
                role="menuitem"
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-content hover:bg-hover transition-colors"
                onClick={() => pick(f.id)}
              >
                <Icon name="folder" className="w-4 h-4 text-faint shrink-0" />
                <span className="flex-1 truncate">{f.name}</span>
                {fav?.folderId === f.id && <Icon name="check" className="w-4 h-4 text-accent shrink-0" />}
              </button>
            ))}
          </div>
          <div className="mt-1 pt-1.5 border-t border-line px-2 pb-1">
            <div className="flex items-center gap-1.5">
              <input
                className="input h-7 text-xs flex-1 min-w-0"
                placeholder="新建目录…"
                value={newName}
                maxLength={20}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    createAndPick();
                  }
                }}
              />
              <button
                type="button"
                className="btn-ghost btn-sm shrink-0 !px-2"
                disabled={!newName.trim() || busy}
                onClick={createAndPick}
                aria-label="新建并收藏至此目录"
              >
                <Icon name="plus" className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>,
          document.body
        )}
    </div>
  );
}
