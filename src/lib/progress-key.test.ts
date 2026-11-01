import { describe, expect, it } from 'vitest';
import { PROGRESS_FINISHED, progressKeyOf } from './db';

describe('progressKeyOf', () => {
  it('同一部剧不看来源，只看归一化标题 + 集号', () => {
    // 换源后 vodId/sourceKey 都变了，钥匙必须还是同一把
    expect(progressKeyOf('狂飙', 3)).toBe(progressKeyOf(' 狂飙 ', 3));
    expect(progressKeyOf('狂飙：第1季', 3)).toBe(progressKeyOf('狂飙第1季', 3));
    expect(progressKeyOf('狂飙', 3)).not.toBe(progressKeyOf('狂飙', 4));
  });

  it('集号能从 key 前缀切回来（listProgress 依赖这个格式）', () => {
    const key = progressKeyOf('甄嬛传', 12);
    const prefix = key.slice(0, key.lastIndexOf('#') + 1);
    expect(Number(key.slice(prefix.length))).toBe(12);
    // 已看完阈值必须小于 1，否则永远判不出「看完」
    expect(PROGRESS_FINISHED).toBeLessThan(1);
  });
});
