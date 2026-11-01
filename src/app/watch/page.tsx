'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
// 播放器（artplayer + hls.js）按需加载：拆出独立 chunk，不占首屏 First Load JS
const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { SwitchSourceModal } from '@/components/switch-source';
import { enqueueDownload } from '@/components/download-manager';
import { Icon } from '@/components/icon';
import { FavoriteButton } from '@/components/favorite-button';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityKey } from '@/lib/quality';
import {
  PROGRESS_FINISHED,
  listProgress,
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
  db,
} from '@/lib/db';
import { cn } from '@/lib/utils';

/**
 * 播放页（唯一入口，替代旧版 watch.html → player.html 跳转链）。
 * 状态全部由 URL 驱动：/watch?source=xx&id=..&index=..&title=..
 * 集数列表由服务端详情接口获取；进度与历史走 IndexedDB。
 */
const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['空格'], label: '播放 / 暂停' },
  { keys: ['←', '→'], label: '快退 / 快进 5 秒' },
  { keys: ['↑', '↓'], label: '音量' },
  { keys: ['F'], label: '全屏' },
  { keys: ['S'], label: '截图' },
  { keys: ['Alt', '←', '→'], label: '切换集数' },
];

export default function WatchPage() {
  return (
    <Suspense>
      <WatchContent />
    </Suspense>
  );
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  // 播放器把截图函数挂到这里，顶部「截图」按钮调用
  const captureRef = useRef<(() => void) | null>(null);
  const { verified } = useAuth();

  const sourceKey = searchParams.get('source') || '';
  const vodId = searchParams.get('id') || '';
  const directUrl = searchParams.get('url') || '';
  const titleParam = searchParams.get('title') || '';
  const indexParam = parseInt(searchParams.get('index') || '0', 10) || 0;

  const [reversed, setReversed] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);

  const source = resolveSource(store, sourceKey, {
    url: searchParams.get('sourceUrl') || undefined,
    detail: searchParams.get('detail') || undefined,
  });

  // 详情查询：无 id（纯直连链接分享）时跳过
  const detailQuery = useQuery({
    queryKey: ['detail', sourceKey, vodId, source?.url],
    queryFn: ({ signal }) => api.detail(vodId, source!, signal),
    enabled: Boolean(source && vodId && verified),
    staleTime: 5 * 60_000,
  });

  const episodes = useMemo(() => detailQuery.data?.episodes ?? [], [detailQuery.data]);
  const videoTitle = titleParam || detailQuery.data?.videoInfo?.title || '未知视频';

  // 当前播放地址：优先取剧集列表中的当前集，其次直连 URL 参数
  const currentUrl = useMemo(() => {
    if (episodes.length > 0) {
      const idx = Math.min(Math.max(indexParam, 0), episodes.length - 1);
      return episodes[idx] || directUrl;
    }
    return directUrl;
  }, [episodes, indexParam, directUrl]);

  const currentIndex = useMemo(() => {
    if (episodes.length > 0) return Math.min(Math.max(indexParam, 0), episodes.length - 1);
    return indexParam;
  }, [episodes, indexParam]);

  const goEpisode = useCallback(
    (index: number) => {
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('index', String(index));
      sp.set('url', episodes[index] || directUrl);
      sp.delete('position');
      router.replace(`/watch?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams, episodes, directUrl]
  );

  // 进度恢复优先级：URL position 参数 > IndexedDB 记录（按标题存，换源也能接着看）
  const getRestorePosition = useCallback(async () => {
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) return urlPos;
    const entry = await db.progress.get(progressKeyOf(videoTitle, currentIndex));
    if (!entry || entry.duration <= 0) return 0;
    // 已看完的集重进从头播，否则会停在片尾
    return entry.position / entry.duration >= PROGRESS_FINISHED ? 0 : entry.position;
  }, [searchParams, videoTitle, currentIndex]);

  // 写入观看历史（进入页面即记录，进度后续增量更新）
  useEffect(() => {
    if (!verified || !sourceKey || !currentUrl) return;
    const timer = setTimeout(() => {
      upsertHistory({
        sourceKey,
        sourceUrl: source?.url,
        vodId: vodId || currentUrl,
        title: videoTitle,
        pic: detailQuery.data?.videoInfo?.cover,
        episodeIndex: currentIndex,
        totalEpisodes: episodes.length,
        playbackPosition: 0,
        duration: 0,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, sourceKey, vodId, currentIndex, videoTitle, currentUrl]);

  // 每集的观看比例（集号 → 0..1），驱动剧集列表的「已看 / 45%」标记
  const [episodeProgress, setEpisodeProgress] = useState<Record<number, number>>({});
  const refreshEpisodeProgress = useCallback(() => {
    listProgress(videoTitle)
      .then((rows) => {
        const out: Record<number, number> = {};
        for (const [index, row] of Object.entries(rows)) {
          if (row.duration > 0) out[Number(index)] = Math.min(1, row.position / row.duration);
        }
        setEpisodeProgress(out);
      })
      .catch(() => {});
  }, [videoTitle]);

  // 换集/换片时刷新：进度按标题存，换源后同一部剧的标记照样带过来
  useEffect(() => {
    refreshEpisodeProgress();
  }, [refreshEpisodeProgress, currentIndex, episodes.length]);

  // 播放中与暂停时的进度落盘逻辑一致，共用同一回调。
  // 返回 promise：暂停时要在落盘之后再刷新列表标记，否则读到的是上一次的旧进度
  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (!vodId) return Promise.resolve();
      // 当前集的比例就地更新（只在整数百分比变化时 setState），
      // 这样不依赖 pause/ended 事件——有些源播到片尾并不触发 ended
      if (duration > 0) {
        const ratio = Math.min(1, position / duration);
        setEpisodeProgress((prev) =>
          prev[currentIndex] !== undefined && Math.round(prev[currentIndex] * 100) === Math.round(ratio * 100)
            ? prev
            : { ...prev, [currentIndex]: ratio }
        );
      }
      return Promise.all([
        saveProgress(videoTitle, currentIndex, position, duration),
        updateHistoryProgress(sourceKey, vodId || currentUrl, position, duration),
      ]).catch(() => {});
    },
    [sourceKey, vodId, currentUrl, videoTitle, currentIndex]
  );

  // 自动连播的 800ms 延迟切集要在卸载时取消，避免离开页面后跳转
  const autoNextTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (autoNextTimer.current) clearTimeout(autoNextTimer.current);
  }, []);

  const handleEnded = useCallback(() => {
    // 记成满进度而不是删掉：剧集列表要据此标「已看」，续播则按看完处理
    if (vodId) saveProgress(videoTitle, currentIndex, 1, 1).catch(() => {});
    setEpisodeProgress((prev) => ({ ...prev, [currentIndex]: 1 }));
    if (store.autoplayNext && currentIndex < episodes.length - 1) {
      autoNextTimer.current = setTimeout(() => goEpisode(currentIndex + 1), 800);
    }
  }, [store.autoplayNext, currentIndex, episodes.length, goEpisode, vodId, videoTitle]);

  // Alt+←/→ 集数切换快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        goEpisode(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && currentIndex < episodes.length - 1) {
        e.preventDefault();
        goEpisode(currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [currentIndex, episodes.length, goEpisode]);

  const orderedEpisodes = reversed ? [...episodes].map((_, i) => episodes.length - 1 - i) : episodes.map((_, i) => i);

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-faint text-sm">等待访问验证...</p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-content font-medium mb-2">点播源不存在</h1>
          <p className="text-sm text-muted mb-4">
            该视频来自点播源「{sourceKey}」，但它可能已被删除。请在设置中重新添加后重试。
          </p>
          <Link href="/" className="btn-primary">返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-3">
          <BackButton />
          <HomeButton />
          <div className="min-w-0">
            <h1 className="text-sm font-medium text-content truncate">{videoTitle}</h1>
            <p className="text-xs text-faint">
              {source.name}
              {episodes.length > 0 && ` · 第 ${currentIndex + 1}/${episodes.length} 集`}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {vodId && (
              <FavoriteButton
                showLabel
                subject={{
                  sourceKey,
                  sourceUrl: source?.url,
                  sourceName: source?.name,
                  vodId,
                  title: videoTitle,
                  pic: detailQuery.data?.videoInfo?.cover,
                  typeName: detailQuery.data?.videoInfo?.typeName,
                  year: detailQuery.data?.videoInfo?.year,
                  remarks: detailQuery.data?.videoInfo?.remarks,
                }}
              />
            )}
            <button
              className="btn-ghost btn-sm"
              disabled={!currentUrl}
              onClick={() => captureRef.current?.()}
              title="截取当前画面（S）"
            >
              截图
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                if (!currentUrl) return;
                enqueueDownload({
                  url: currentUrl,
                  // 多集才带集数后缀；单集影片（含电影）文件名就是纯标题
                  title: `${videoTitle}${episodes.length > 1 ? ` 第${currentIndex + 1}集` : ''}`,
                  format: 'MP4',
                });
                // 「已加入下载队列」由 DownloadManager 在真正入队后提示：
                // 这里先提示的话，用户随后取消保存位置会出现「已加入→已取消」的矛盾
              }}
            >
              下载本集
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setSwitchOpen(true)}>
              切换资源
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
          <div>
            <div className="aspect-video bg-black rounded-lg overflow-hidden">
              {currentUrl ? (
                <PlayerShell
                  url={currentUrl}
                  title={videoTitle}
                  adFilter={store.adFilter}
                  autoplayNext={store.autoplayNext}
                  episodeKey={`${sourceKey}:${vodId}:${currentIndex}`}
                  nextUrl={currentIndex + 1 < episodes.length ? episodes[currentIndex + 1] : undefined}
                  nextEpisodeKey={currentIndex + 1 < episodes.length ? `${sourceKey}:${vodId}:${currentIndex + 1}` : undefined}
                  getRestorePosition={getRestorePosition}
                  onTimeUpdate={handleProgress}
                  onPause={(position, duration) => {
                    // 落盘完成后再刷新，「看到 45%」才不会慢一拍
                    handleProgress(position, duration).then(refreshEpisodeProgress);
                  }}
                  onEnded={handleEnded}
                  captureRef={captureRef}
                  onQuality={(height) => {
                    // 播放实测是最权威的画质来源，回写后搜索列表里该「源 + 影片」直接显示
                    if (!sourceKey || !vodId) return;
                    useAppStore.getState().setQuality({
                      [qualityKey(sourceKey, vodId)]: { height, from: 'play', timestamp: Date.now() },
                    });
                  }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {detailQuery.isLoading ? (
                    <Spinner size="lg" />
                  ) : (
                    <p className="text-faint text-sm">
                      {detailQuery.isError ? '视频加载失败，请尝试其他资源' : '无可用播放地址'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 操作栏 */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                className="btn-ghost btn-sm"
                disabled={currentIndex <= 0}
                onClick={() => goEpisode(currentIndex - 1)}
              >
                上一集
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={episodes.length === 0 || currentIndex >= episodes.length - 1}
                onClick={() => goEpisode(currentIndex + 1)}
              >
                下一集
              </button>
              <label className="flex items-center gap-1.5 text-xs text-muted ml-auto cursor-pointer">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#2563eb]"
                  checked={store.autoplayNext}
                  onChange={(e) => store.updateSettings({ autoplayNext: e.target.checked })}
                />
                自动连播
              </label>
            </div>
          </div>

          {/* 剧集侧栏 */}
          <aside className="bg-surface-raised rounded-lg p-3 h-fit">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <h2 className="text-sm font-semibold text-content">
                剧集列表{episodes.length > 0 && `（${episodes.length}）`}
              </h2>
              {/* 排列开关紧贴它所作用的列表：放在这里才看得出它管的是这一栏的顺序 */}
              {episodes.length > 1 && (
                <button
                  className="btn-ghost btn-sm shrink-0"
                  onClick={() => setReversed((v) => !v)}
                  aria-label={reversed ? '切换为正序排列' : '切换为倒序排列'}
                  title="调整剧集列表的排列顺序"
                >
                  <Icon
                    name="arrowDown"
                    className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                  />
                  {reversed ? '正序排列' : '倒序排列'}
                </button>
              )}
            </div>
            {/* 超长剧集（几百集）时只给列表约 11 行高度，超出在卡片内滚动：
                卡片不再随集数变长，右侧也就不会比播放器拖出一截 */}
            {episodes.length === 0 ? (
              detailQuery.isLoading ? (
                <LoadingState />
              ) : (
                <EmptyState variant="plain" title={detailQuery.isError ? '获取剧集失败' : '暂无剧集信息'} />
              )
            ) : (
              <div className="grid grid-cols-5 lg:grid-cols-4 gap-1.5 max-h-[65vh] lg:max-h-[22rem] content-start overflow-y-auto scrollbar-thin pr-1">
                {orderedEpisodes.map((realIndex) => (
                  <EpisodeButton
                    key={realIndex}
                    index={realIndex}
                    active={realIndex === currentIndex}
                    progress={episodeProgress[realIndex]}
                    onClick={() => goEpisode(realIndex)}
                  />
                ))}
              </div>
            )}
            {/* 键位做成 kbd 小块逐行排列，比一行流水文案更好扫 */}
            <div className="hidden md:block mt-3 pt-2.5 border-t border-line">
              <p className="text-[10px] font-medium text-faint mb-1.5">键盘快捷键</p>
              <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[10px] text-muted">
                {SHORTCUTS.map(({ keys, label }) => (
                  <div key={label} className="contents">
                    <dt className="flex items-center gap-1">
                      {keys.map((key) => (
                        <kbd key={key} className="kbd">
                          {key}
                        </kbd>
                      ))}
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </aside>
        </div>
      </main>

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={videoTitle}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          onClose={() => setSwitchOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 集数按钮：激活时自动滚动进可视区（长剧列表）。
 * 看过/看到一半的集数由 progress（0..1）标出来：看完换底色，看一半标百分比。
 * progress 按片名存，换源后同一部剧的标记不变。
 */
function EpisodeButton({
  index,
  active,
  progress,
  onClick,
}: {
  index: number;
  active: boolean;
  progress?: number;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const finished = progress !== undefined && progress >= PROGRESS_FINISHED;
  const watching = progress !== undefined && progress > 0 && !finished;

  return (
    <button
      ref={ref}
      className={cn(
        'btn btn-sm !px-1 gap-1',
        active ? 'episode-active' : 'btn-ghost',
        // 非激活时：看完的换成绿色淡底，正在看的保持普通底只标百分比
        !active && finished && 'bg-success/10 border-success/30 text-success hover:bg-success/20 hover:text-success'
      )}
      onClick={onClick}
      title={finished ? '已看完' : watching ? `已看 ${Math.round(progress * 100)}%` : undefined}
    >
      {index + 1}
      {watching && <span className="text-[9px] leading-none opacity-80">{Math.round(progress * 100)}%</span>}
    </button>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      className="p-2 -ml-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push('/');
      }}
      aria-label="返回"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

/** 首页按钮：直达首页，避免从外链进入时逐级 back */
function HomeButton() {
  return (
    <Link
      href="/"
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
      aria-label="回首页"
      title="回首页"
    >
      <Icon name="home" className="w-5 h-5" />
    </Link>
  );
}
