'use client';

/**
 * 我的收藏：按目录分组浏览。
 * - 顶部目录 tab（含「全部」与各目录计数），可新建目录；
 * - 网格卡片：点击进播放页，右上角星标可移动/取消收藏；
 * - 数据来自 IndexedDB（与观看历史同库），单用户本地。
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/header';
import { Icon } from '@/components/icon';
import { SmartImage } from '@/components/smart-image';
import { FavoriteButton } from '@/components/favorite-button';
import { EmptyState } from '@/components/states';
import { useAppStore } from '@/lib/store';
import { useToast } from '@/components/toast';
import {
  addFavoriteFolder,
  ensureFavoriteFolders,
  favoriteCountByFolder,
  listFavoriteFolders,
  listFavorites,
  type FavoriteEntry,
  type FavoriteFolderEntry,
} from '@/lib/db';
import { buildWatchUrl, cn } from '@/lib/utils';

const ALL = '__all__';

export default function FavoritesPage() {
  const router = useRouter();
  const { toast } = useToast();
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);

  const [folders, setFolders] = useState<FavoriteFolderEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [items, setItems] = useState<FavoriteEntry[]>([]);
  const [active, setActive] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const refresh = useCallback(async () => {
    await ensureFavoriteFolders();
    const [fs, list] = await Promise.all([listFavoriteFolders(), listFavorites()]);
    setFolders(fs);
    setCounts(await favoriteCountByFolder());
    setItems(list);
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [refresh]);

  const shown = active === ALL ? items : items.filter((i) => i.folderId === active);
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name ?? '未分类';

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const f = await addFavoriteFolder(name);
      setNewName('');
      setCreating(false);
      await refresh();
      setActive(f.id);
      toast(`已创建目录「${f.name}」`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '新建目录失败', 'error');
    }
  };

  const open = (f: FavoriteEntry) => {
    router.push(
      buildWatchUrl({
        sourceKey: f.sourceKey,
        vodId: f.vodId,
        index: 0,
        title: f.title,
        sourceUrl: f.sourceUrl,
      })
    );
  };

  const total = items.length;

  return (
    <>
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h1 className="text-xl font-semibold text-content flex items-center gap-2">
            <Icon name="starFilled" className="w-5 h-5 text-amber-400" />
            我的收藏
            <span className="text-sm font-normal text-faint">（{total}）</span>
          </h1>
          {!creating ? (
            <button className="btn-ghost btn-sm" onClick={() => setCreating(true)}>
              <Icon name="plus" className="w-4 h-4" />
              新建目录
            </button>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                className="input h-8 text-sm w-36"
                placeholder="目录名"
                maxLength={20}
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFolder();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
              />
              <button className="btn-primary btn-sm" onClick={createFolder} disabled={!newName.trim()}>
                创建
              </button>
              <button
                className="btn-ghost btn-sm"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                }}
              >
                取消
              </button>
            </div>
          )}
        </div>

        {/* 目录 tab */}
        <div className="flex flex-wrap gap-1.5 mb-5">
          <button
            className={cn(
              'px-3 py-1.5 rounded-full text-sm transition-colors',
              active === ALL ? 'bg-accent text-white' : 'bg-chip text-muted hover:text-content'
            )}
            onClick={() => setActive(ALL)}
          >
            全部 <span className="opacity-70">{total}</span>
          </button>
          {folders.map((f) => {
            const n = counts[f.id] ?? 0;
            return (
              <button
                key={f.id}
                className={cn(
                  'px-3 py-1.5 rounded-full text-sm transition-colors',
                  active === f.id ? 'bg-accent text-white' : 'bg-chip text-muted hover:text-content'
                )}
                onClick={() => setActive(f.id)}
              >
                {f.name} <span className="opacity-70">{n}</span>
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="text-center text-faint text-sm py-16">加载中…</div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon="star"
            title={active === ALL ? '还没有收藏' : '这个目录还是空的'}
            description="在搜索结果的卡片上点星标，即可收藏到指定目录"
          />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {shown.map((f) => (
              <div key={f.id} className="card group overflow-hidden">
                <div
                  className="relative aspect-[2/3] bg-chip cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => open(f)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      open(f);
                    }
                  }}
                >
                  {f.pic ? (
                    <SmartImage
                      url={f.pic}
                      mode={imageProxyMode}
                      customProxy={customImageProxy}
                      alt={f.title}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Icon name="star" className="w-8 h-8 text-faint" />
                    </div>
                  )}
                  <FavoriteButton
                    subject={{
                      sourceKey: f.sourceKey,
                      sourceUrl: f.sourceUrl,
                      sourceName: f.sourceName,
                      vodId: f.vodId,
                      title: f.title,
                      pic: f.pic,
                      typeName: f.typeName,
                      year: f.year,
                      remarks: f.remarks,
                    }}
                    size="sm"
                    className="absolute top-1.5 right-1.5 z-10"
                    onChanged={refresh}
                  />
                  <span className="absolute top-1.5 left-1.5 max-w-[calc(100%-3.5rem)] truncate tag bg-black/70 text-white/90 pointer-events-none">
                    {folderName(f.folderId)}
                  </span>
                </div>
                <div className="p-2">
                  <p className="text-sm font-medium text-content truncate" title={f.title}>
                    {f.title}
                  </p>
                  <p className="text-[11px] text-faint truncate mt-0.5">
                    {f.typeName ? `${f.typeName} · ` : ''}
                    {f.sourceName ?? ''}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-center text-xs text-faint mt-8">
          收藏保存在本机浏览器（IndexedDB），清理浏览器数据会一并清空。{' '}
          <Link href="/" className="text-accent hover:underline">
            去搜索
          </Link>
        </p>
      </main>
    </>
  );
}
