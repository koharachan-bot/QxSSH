/**
 * desktop/connwatch.js —— 当前主机的连接健康监控
 * 要点：按固定间隔探测当前主机，连续失败即判定断线并回调，供桌面自动退回开机页；
 * 浏览器离线时以短间隔连测，尽量在秒级确认；切换主机等场景可临时暂停。
 */
import { createPoller } from '../core/dom.js';
import { probeHost } from '../core/qxssh-api.js';

const PROBE_MS = 30000;
const FAST_MS = 6000;
const LOST_AFTER = 2;
const OFFLINE_RETRY_MS = 1200;

/**
 * 监控某台主机的连通性。
 * @param {string} hostId 目标主机 id
 * @param {{ onLost?: () => void, interval?: number, threshold?: number }} opts
 *        onLost 连续失败达到阈值时触发一次；interval 探测间隔毫秒；threshold 判定断线的连续失败次数
 * @returns {{ pause: () => void, resume: () => void, stop: () => void, poke: () => void }}
 */
export function watchConnection(hostId, opts = {}) {
  const { onLost, interval = PROBE_MS, threshold = LOST_AFTER } = opts;
  let fails = 0;
  let paused = false;
  let lost = false;
  let inFlight = false;

  const poller = createPoller(check, interval, { immediate: false, hiddenPause: false });

  async function check() {
    if (paused || lost || inFlight) return;
    inFlight = true;
    try {
      let ok = false;
      try {
        const r = await probeHost(hostId);
        ok = !!(r && r.ok);
        if (!ok) console.warn('[connwatch] 探测失败', r && r.error);
      } catch (err) {
        console.warn('[connwatch] 探测异常', err);
      }
      if (paused || lost) return;
      if (ok) {
        fails = 0;
        poller.setPeriod(interval);
        return;
      }
      fails += 1;
      // 一旦探测失败就切到快速确认，稳定后再回到常规间隔
      poller.setPeriod(FAST_MS);
      if (fails < threshold) return;
      lost = true;
      poller.dispose();
      try {
        onLost?.();
      } catch (err) {
        console.error('[connwatch] onLost 回调出错', err);
      }
    } finally {
      inFlight = false;
    }
  }

  // 浏览器判定离线时短间隔连测，尽快确认整条链路是否已断
  const onOffline = async () => {
    for (let i = 0; i < threshold; i += 1) {
      if (lost || paused) return;
      await check();
      if (lost || paused) return;
      if (i < threshold - 1) await new Promise((r) => { setTimeout(r, OFFLINE_RETRY_MS); });
    }
  };
  window.addEventListener('offline', onOffline);

  poller.start();

  return {
    pause() { paused = true; },
    resume() { paused = false; },
    poke() { check(); },
    stop() {
      poller.dispose();
      window.removeEventListener('offline', onOffline);
    },
  };
}
