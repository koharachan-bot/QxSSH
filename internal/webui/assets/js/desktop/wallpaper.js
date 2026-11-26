/**
 * desktop/wallpaper.js —— 桌面与启动页壁纸
 *
 * 要点：
 *   - 壁纸模式从「图片 / 纯色 / 纹理」扩到「图片 / 纯色 / 纹理 / 视频 / 交互包 / 内置引擎」；
 *   - 前三种沿用 .desk 的 background 与 .qx-texture 层，动态三种统一用 body 下的
 *     .qx-wall-layer 承载（video / iframe / canvas），避免与桌面 vdom 抢节点；
 *   - 选择值统一存条目 id（b:/u:/e: 前缀），读取时对旧的文件名做一次回退匹配；
 *   - 动态壁纸的暂停、音量、指针广播与轮播都收在本文件，界面层只需改偏好。
 */
import { dom } from '../core/vdom.js';
import {
  fetchLibrary, invalidateWallpaperLibrary, wallpaperFileUrl, WALL_KIND, formatBytes,
} from '../core/wallpapers.js';
import { getPref, setPref, delPref, getJSONPref, setJSONPref } from '../core/prefs.js';
import { listWallEngines, getWallEngine } from './wallpaper-engine.js';
import { t } from '../core/i18n.js';

/** 桌面壁纸目标标识 */
export const TARGET_DESKTOP = 'desktop';
/** 启动页壁纸目标标识 */
export const TARGET_BOOT = 'boot';

/** 浅色主题档位 */
export const TIER_LIGHT = 'light';
/** 深色主题档位 */
export const TIER_DARK = 'dark';

/** 取当前主题档位（浅色 / 深色） */
export function currentTier() {
  if (typeof document === 'undefined') return TIER_LIGHT;
  return document.documentElement.classList.contains('dark') ? TIER_DARK : TIER_LIGHT;
}

function normTier(tier) {
  return tier === TIER_DARK || tier === TIER_LIGHT ? tier : currentTier();
}

function keyOf(target, name, tier) {
  const prefix = target === TARGET_BOOT ? 'qx-bootwall' : 'qx-wallpaper';
  return `${prefix}-${normTier(tier)}-${name}`;
}

const K_MODE = 'mode';
const K_COLOR = 'color';
const K_NAME = 'name';
const K_FIT = 'fit';
const K_TEX_NAME = 'tex';
const K_TEX_BASE = 'tex-base';
const K_TEX_LINE = 'tex-line';
const K_TEX_A = 'tex-a';
const K_TEX_DENSITY = 'tex-density';

// 动态壁纸的播放参数：视频看前五个，交互包看 web-*，内置引擎看 eng-*。
const K_VID_AUDIO = 'vid-audio';
const K_VID_VOL = 'vid-vol';
const K_VID_RATE = 'vid-rate';
const K_VID_LOOP = 'vid-loop';
const K_VID_PAUSE_HIDDEN = 'vid-pause-hidden';
const K_WEB_INTERACT = 'web-interact';
const K_WEB_CAPTURE = 'web-capture';
const K_ENG_SPEED = 'eng-speed';

// 轮播参数是全局的（不分目标与主题档）。
const K_ROT_ON = 'qx-wall-rotate-on';
const K_ROT_SEC = 'qx-wall-rotate-sec';
const K_ROT_POOL = 'qx-wall-rotate-pool';
const K_ROT_SHUFFLE = 'qx-wall-rotate-shuffle';

const DEFAULT_TEXTURE = 'topography';

/** 图片与动态壁纸共用的填充方式。视频层用 CSS object-fit 实现同样的语义。 */
const FITS = ['cover', 'contain', 'fill', 'tile', 'center'];

/** 纹理透明度下限 */
export const TEX_ALPHA_MIN = 0.05;
/** 纹理透明度上限 */
export const TEX_ALPHA_MAX = 1;

/** 纹理密度下限 */
export const TEX_DENSITY_MIN = 0.5;
/** 纹理密度上限 */
export const TEX_DENSITY_MAX = 4;

const TEX_TILE_FLOOR = 2;

let cachedAll = null;
let cachedTextures = null;
let cachedEngines = null;
let libraryMeta = { dir: '', token: '', limits: { maxFileBytes: 0, maxPackBytes: 0 } };

/** 取壁纸库的元信息（库路径、能力令牌、上传上限） */
export function getLibraryMeta() {
  return libraryMeta;
}

function engineItems() {
  if (cachedEngines) return cachedEngines;
  cachedEngines = listWallEngines().map((e) => ({
    id: `e:${e.id}`,
    name: e.id,
    title: e.id,
    nameKey: e.nameKey,
    descKey: e.descKey,
    kind: WALL_KIND.ENGINE,
    theme: 'any',
    builtin: true,
    engine: e.id,
    audio: e.audio === true,
    url: '',
  }));
  return cachedEngines;
}

/** 条目的显示名：内置引擎走词条，其余用条目名或包声明的标题 */
export function wallTitle(item) {
  if (!item) return '';
  if (item.nameKey) {
    const v = t(item.nameKey);
    if (v && v !== item.nameKey) return v;
  }
  return item.title || item.name || '';
}

/** 加载并缓存壁纸清单（含内置引擎），force 为 true 时强制刷新 */
export async function loadWallpapers(force = false) {
  if (cachedAll && !force) return cachedAll;
  let lib = null;
  try {
    lib = await fetchLibrary({ force });
    cachedAll = (lib.items || []).concat(engineItems());
    cachedTextures = (lib.textures || []).filter((x) => x && x.name && x.url);
    libraryMeta = {
      dir: lib.dir || '',
      token: lib.token || '',
      limits: lib.limits || { maxFileBytes: 0, maxPackBytes: 0 },
    };
  } catch {
    cachedAll = cachedAll || engineItems();
    cachedTextures = cachedTextures || [];
  }
  return cachedAll;
}

/** 刷新清单并丢弃缓存（导入、上传、删除之后调用） */
export async function refreshWallpapers() {
  invalidateWallpaperLibrary();
  cachedAll = null;
  cachedTextures = null;
  return loadWallpapers(true);
}

/** 取已缓存的壁纸条目 */
export function getWallpaperItems() {
  return cachedAll || engineItems();
}

/** 取内置交互引擎条目 */
export function getEngineItems() {
  return engineItems();
}

/** 按 id 取条目；也接受旧版本存下的裸文件名 */
export function findWallpaper(idOrName) {
  const key = String(idOrName || '');
  if (!key) return null;
  const list = getWallpaperItems();
  return list.find((w) => w.id === key) || list.find((w) => w.name === key) || null;
}

/** 取全部壁纸地址列表 */
export function getDefaultWallpapers() {
  return getWallpaperItems().filter((w) => w.url).map((w) => w.url);
}

/** 取已缓存的纹理条目 */
export function getTextureItems() {
  return cachedTextures || [];
}

/** 取当前选中的条目 id（兼容旧值：裸文件名会解析成对应 id） */
export function getSelectedWallpaperId(target = TARGET_DESKTOP, tier) {
  const raw = getPref(keyOf(target, K_NAME, tier), '');
  if (!raw) return '';
  const hit = findWallpaper(raw);
  return hit ? hit.id : raw;
}

/** 取当前选中的壁纸条目 */
export function getSelectedWallpaperItem(target = TARGET_DESKTOP, tier) {
  return findWallpaper(getSelectedWallpaperId(target, tier));
}

/** 取当前选中的壁纸名（返回 id，保留旧函数名以免调用方大改） */
export function getSelectedWallpaperName(target = TARGET_DESKTOP, tier) {
  return getSelectedWallpaperId(target, tier);
}

/** 判断选中的壁纸是否仍存在（清单为空时视为可用） */
export function isSelectionResolvable(target = TARGET_DESKTOP, tier) {
  const list = getWallpaperItems();
  if (!list.length) return true;
  const id = getSelectedWallpaperId(target, tier);
  if (!id) return true;
  return list.some((w) => w.id === id);
}

function firstImageItem() {
  const list = getWallpaperItems();
  return list.find((w) => w.kind === WALL_KIND.IMAGE) || list[0] || null;
}

/** 取应生效的壁纸地址：选中项优先，否则取第一张图片 */
export function getDefaultWallpaper(target = TARGET_DESKTOP, tier) {
  const list = getWallpaperItems();
  if (!list.length) return '';
  const hit = findWallpaper(getSelectedWallpaperId(target, tier));
  return (hit && hit.url) || (firstImageItem() || {}).url || '';
}

/** 取壁纸模式：image / color / texture / video / web / engine */
export function getMode(target = TARGET_DESKTOP, tier) {
  const v = getPref(keyOf(target, K_MODE, tier), 'texture');
  return ['image', 'color', 'texture', 'video', 'web', 'engine'].includes(v) ? v : 'texture';
}

/** 取纯色壁纸的颜色 */
export function getColorWallpaper(target = TARGET_DESKTOP, tier) {
  return getPref(keyOf(target, K_COLOR, tier), '') || '#1a1a2e';
}

/** 取壁纸填充方式 */
export function getWallpaperFit(target = TARGET_DESKTOP, tier) {
  const v = getPref(keyOf(target, K_FIT, tier), '');
  return FITS.includes(v) ? v : 'cover';
}

/** 设置壁纸填充方式并立即应用 */
export function setWallpaperFit(fit, target = TARGET_DESKTOP, tier) {
  if (FITS.includes(fit)) setPref(keyOf(target, K_FIT, tier), fit);
  else delPref(keyOf(target, K_FIT, tier));
  applyWallpaper(target);
}

/** 把填充方式转换为 CSS 背景样式对象 */
export function wallpaperFitStyle(fit = getWallpaperFit()) {
  const base = { backgroundPosition: 'center' };
  switch (fit) {
    case 'contain':
      return { ...base, backgroundSize: 'contain', backgroundRepeat: 'no-repeat' };
    case 'fill':
      return { ...base, backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' };
    case 'tile':
      return { ...base, backgroundSize: 'auto', backgroundRepeat: 'repeat' };
    case 'center':
      return { ...base, backgroundSize: 'auto', backgroundRepeat: 'no-repeat' };
    default:
      return { ...base, backgroundSize: 'cover', backgroundRepeat: 'no-repeat' };
  }
}

/** 把填充方式转换为 video / canvas / iframe 的 object-fit 取值 */
export function fitToObjectFit(fit = getWallpaperFit()) {
  switch (fit) {
    case 'contain': return 'contain';
    case 'fill': return 'fill';
    case 'center': return 'none';
    default: return 'cover';
  }
}

/** 设置壁纸模式并立即应用 */
export function setMode(mode, target = TARGET_DESKTOP, tier) {
  if (['image', 'color', 'texture', 'video', 'web', 'engine'].includes(mode)) {
    setPref(keyOf(target, K_MODE, tier), mode);
  }
  applyWallpaper(target);
}

/** 取当前选中的纹理条目（默认 topography 或第一个） */
export function getSelectedTexture(target = TARGET_DESKTOP, tier) {
  const list = getTextureItems();
  const name = getPref(keyOf(target, K_TEX_NAME, tier), '') || '';
  if (name) return list.find((x) => x.name === name) || null;
  return list.find((x) => x.name === DEFAULT_TEXTURE) || list[0] || null;
}

/** 取纹理底色，未自定义时跟随主题变量 */
export function getTextureBase(target = TARGET_DESKTOP, tier) {
  return getPref(keyOf(target, K_TEX_BASE, tier), '') || texThemeColor('--qx-tex-base', '#E7EAF0', tier);
}

/** 取纹理线条色，未自定义时跟随主题变量 */
export function getTextureLine(target = TARGET_DESKTOP, tier) {
  return getPref(keyOf(target, K_TEX_LINE, tier), '') || texThemeColor('--qx-tex-line', '#44506B', tier);
}

/** 取纹理透明度，取值夹在上下限内 */
export function getTextureAlpha(target = TARGET_DESKTOP, tier) {
  const v = parseFloat(getPref(keyOf(target, K_TEX_A, tier), ''));
  return Number.isFinite(v)
    ? Math.min(TEX_ALPHA_MAX, Math.max(TEX_ALPHA_MIN, v))
    : texThemeAlpha(tier);
}

let tierProbe = null;

function texThemeColor(prop, fallback, tier) {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') return fallback;
  if (normTier(tier) === currentTier()) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(prop).trim();
    return v || fallback;
  }
  if (!tierProbe) {
    tierProbe = dom('div', { class: TIER_DARK, 'aria-hidden': 'true' });
    tierProbe.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden;pointer-events:none';
  }
  if (!tierProbe.isConnected) document.body.appendChild(tierProbe);
  const v = getComputedStyle(tierProbe).getPropertyValue(prop).trim();
  return v || fallback;
}

function texThemeAlpha(tier) {
  const v = parseFloat(texThemeColor('--qx-tex-a', '', tier));
  return Number.isFinite(v) ? Math.min(TEX_ALPHA_MAX, Math.max(TEX_ALPHA_MIN, v)) : 0.4;
}

/** 取纹理密度，取值夹在上下限内 */
export function getTextureDensity(target = TARGET_DESKTOP, tier) {
  const v = parseFloat(getPref(keyOf(target, K_TEX_DENSITY, tier), ''));
  if (!Number.isFinite(v)) return 1;
  return Math.min(TEX_DENSITY_MAX, Math.max(TEX_DENSITY_MIN, v));
}

/** 按密度计算纹理平铺尺寸，返回 CSS background-size 值 */
export function textureTileSize(tex, target = TARGET_DESKTOP, tier) {
  const w = tex && tex.w > 0 ? tex.w : 600;
  const h = tex && tex.h > 0 ? tex.h : 600;
  const d = getTextureDensity(target, tier);
  const px = (n) => Math.max(TEX_TILE_FLOOR, n / d);
  return `${px(w).toFixed(1)}px ${px(h).toFixed(1)}px`;
}

/** 选中纹理并切换为纹理模式 */
export function selectTexture(name, target = TARGET_DESKTOP, tier) {
  if (name) setPref(keyOf(target, K_TEX_NAME, tier), String(name));
  setPref(keyOf(target, K_MODE, tier), 'texture');
  applyWallpaper(target);
}

/** 设置纹理的底色、线条色与透明度，空值表示恢复主题默认 */
export function setTextureColors({ base, line, alpha } = {}, target = TARGET_DESKTOP, tier) {
  if (base) setPref(keyOf(target, K_TEX_BASE, tier), base); else delPref(keyOf(target, K_TEX_BASE, tier));
  if (line) setPref(keyOf(target, K_TEX_LINE, tier), line); else delPref(keyOf(target, K_TEX_LINE, tier));
  if (Number.isFinite(alpha)) setPref(keyOf(target, K_TEX_A, tier), String(alpha));
  else delPref(keyOf(target, K_TEX_A, tier));
  applyWallpaper(target);
}

/** 设置纹理密度 */
export function setTextureDensity(density, target = TARGET_DESKTOP, tier) {
  if (Number.isFinite(density)) setPref(keyOf(target, K_TEX_DENSITY, tier), String(density));
  else delPref(keyOf(target, K_TEX_DENSITY, tier));
  applyWallpaper(target);
}

/**
 * 选中壁纸条目并按其类型切换模式，返回该条目是否仍存在。
 * 传 id 或旧的文件名都可以；不存在时保留原来的模式，交给调用方提示。
 */
export function selectWallpaper(idOrName, target = TARGET_DESKTOP, tier) {
  const item = findWallpaper(idOrName);
  const id = item ? item.id : String(idOrName || '');
  setPref(keyOf(target, K_NAME, tier), id);
  if (item) {
    const mode = item.kind === WALL_KIND.VIDEO ? 'video'
      : item.kind === WALL_KIND.WEB ? 'web'
        : item.kind === WALL_KIND.ENGINE ? 'engine' : 'image';
    setPref(keyOf(target, K_MODE, tier), mode);
  }
  applyWallpaper(target);
  return isSelectionResolvable(target, tier);
}

/** 设置纯色壁纸并切换为纯色模式 */
export function setColorWallpaper(color, target = TARGET_DESKTOP, tier) {
  if (color) setPref(keyOf(target, K_COLOR, tier), color);
  else delPref(keyOf(target, K_COLOR, tier));
  setPref(keyOf(target, K_MODE, tier), 'color');
  applyWallpaper(target);
}

/** 被删壁纸正好是当前选中项时，回退到第一张内置图片 */
export function settleSelectionAfterDelete(idOrName, target = TARGET_DESKTOP, tier) {
  const cur = getSelectedWallpaperId(target, tier);
  const item = findWallpaper(idOrName);
  const targetId = item ? item.id : String(idOrName || '');
  if (cur !== targetId && cur !== targetId.replace(/^u:/, '')) return false;
  const fallback = firstImageItem();
  if (!fallback) return false;
  setPref(keyOf(target, K_NAME, tier), fallback.id);
  setPref(keyOf(target, K_MODE, tier), 'image');
  applyWallpaper(target);
  return true;
}

/** 重置壁纸相关设置，恢复默认图片模式 */
export function resetWallpaper(target = TARGET_DESKTOP, tier) {
  for (const k of [K_COLOR, K_NAME, K_FIT, K_TEX_NAME, K_TEX_BASE, K_TEX_LINE, K_TEX_A, K_TEX_DENSITY,
    K_VID_AUDIO, K_VID_VOL, K_VID_RATE, K_VID_LOOP, K_WEB_INTERACT, K_WEB_CAPTURE, K_ENG_SPEED]) {
    delPref(keyOf(target, k, tier));
  }
  setPref(keyOf(target, K_MODE, tier), 'image');
  applyWallpaper(target);
}

// ---------------------------------------------------------------------------
// 动态壁纸参数
// ---------------------------------------------------------------------------

function boolPref(key, def = false) {
  const raw = getPref(key, '');
  if (raw === '') return def;
  return raw === '1' || raw === 'true';
}

function numPref(key, def, min, max) {
  const v = parseFloat(getPref(key, ''));
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

/** 取视频壁纸的播放参数 */
export function getVideoOptions(target = TARGET_DESKTOP, tier) {
  return {
    audio: boolPref(keyOf(target, K_VID_AUDIO, tier), false),
    volume: numPref(keyOf(target, K_VID_VOL, tier), 0.6, 0, 1),
    rate: numPref(keyOf(target, K_VID_RATE, tier), 1, 0.25, 2),
    loop: boolPref(keyOf(target, K_VID_LOOP, tier), true),
    pauseHidden: boolPref(keyOf(target, K_VID_PAUSE_HIDDEN, tier), true),
  };
}

/** 视频参数名到偏好键的映射 */
const VIDEO_FIELDS = {
  audio: K_VID_AUDIO, volume: K_VID_VOL, rate: K_VID_RATE,
  loop: K_VID_LOOP, pauseHidden: K_VID_PAUSE_HIDDEN,
};

/** 写视频壁纸参数，值留空表示删除（恢复默认） */
export function setVideoOption(name, value, target = TARGET_DESKTOP, tier) {
  const field = VIDEO_FIELDS[name];
  if (!field) return;
  const key = keyOf(target, field, tier);
  if (value === '' || value === null || value === undefined) delPref(key);
  else setPref(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  applyWallpaper(target);
}

/** 取交互壁纸包的播放参数 */
export function getWebOptions(target = TARGET_DESKTOP, tier) {
  return {
    interact: boolPref(keyOf(target, K_WEB_INTERACT, tier), true),
    capture: boolPref(keyOf(target, K_WEB_CAPTURE, tier), false),
  };
}

/** 写交互壁纸包参数 */
export function setWebOption(name, value, target = TARGET_DESKTOP, tier) {
  const key = name === 'capture' ? K_WEB_CAPTURE : K_WEB_INTERACT;
  if (value === '' || value === null || value === undefined) delPref(keyOf(target, key, tier));
  else setPref(keyOf(target, key, tier), value ? '1' : '0');
  applyWallpaper(target);
}

/** 取内置引擎参数（动画速度倍率） */
export function getEngineOptions(target = TARGET_DESKTOP, tier) {
  return { speed: numPref(keyOf(target, K_ENG_SPEED, tier), 1, 0.2, 3) };
}

/** 写内置引擎参数 */
export function setEngineSpeed(value, target = TARGET_DESKTOP, tier) {
  if (Number.isFinite(value)) setPref(keyOf(target, K_ENG_SPEED, tier), String(value));
  else delPref(keyOf(target, K_ENG_SPEED, tier));
  applyWallpaper(target);
}

// ---------------------------------------------------------------------------
// 轮播
// ---------------------------------------------------------------------------

/** 取轮播设置 */
export function getRotation() {
  const pool = getJSONPref(K_ROT_POOL, []);
  return {
    on: boolPref(K_ROT_ON, false),
    seconds: numPref(K_ROT_SEC, 300, 10, 86400),
    shuffle: boolPref(K_ROT_SHUFFLE, true),
    pool: Array.isArray(pool) ? pool.map(String) : [],
  };
}

/** 写轮播设置并重排定时器 */
export function setRotation(patch = {}) {
  if ('on' in patch) setPref(K_ROT_ON, patch.on ? '1' : '0');
  if ('seconds' in patch) {
    const v = Number(patch.seconds);
    if (Number.isFinite(v)) setPref(K_ROT_SEC, String(Math.min(86400, Math.max(10, v))));
  }
  if ('shuffle' in patch) setPref(K_ROT_SHUFFLE, patch.shuffle ? '1' : '0');
  if ('pool' in patch) setJSONPref(K_ROT_POOL, Array.isArray(patch.pool) ? patch.pool : []);
  scheduleRotation();
}

/** 可参与轮播的条目：有实际画面的壁纸，纹理与纯色除外 */
export function rotationCandidates() {
  return getWallpaperItems().filter((w) => !w.problem && w.kind !== WALL_KIND.TEXTURE);
}

let rotationTimer = 0;

function rotationPool() {
  const cfg = getRotation();
  const all = rotationCandidates();
  if (!cfg.pool.length) return all;
  const picked = cfg.pool.map((id) => all.find((w) => w.id === id)).filter(Boolean);
  return picked.length ? picked : all;
}

/** 重新安排下一次轮播；关闭或候选不足时清空定时器 */
export function scheduleRotation() {
  if (rotationTimer) {
    clearTimeout(rotationTimer);
    rotationTimer = 0;
  }
  if (typeof window === 'undefined') return;
  const cfg = getRotation();
  if (!cfg.on) return;
  const pool = rotationPool();
  if (pool.length < 2) return;
  rotationTimer = setTimeout(() => {
    rotationTimer = 0;
    try {
      stepRotation();
    } catch (err) {
      console.warn('[wallpaper] 轮播切换失败', err);
    }
    scheduleRotation();
  }, cfg.seconds * 1000);
}

function stepRotation() {
  const cfg = getRotation();
  const pool = rotationPool();
  if (pool.length < 2) return;
  const curId = getSelectedWallpaperId(TARGET_DESKTOP, currentTier());
  let next;
  if (cfg.shuffle) {
    const others = pool.filter((w) => w.id !== curId);
    next = others[Math.floor(Math.random() * others.length)];
  } else {
    const i = pool.findIndex((w) => w.id === curId);
    next = pool[(i + 1) % pool.length];
  }
  if (next) selectWallpaper(next.id, TARGET_DESKTOP, currentTier());
}

// ---------------------------------------------------------------------------
// 动态层渲染
// ---------------------------------------------------------------------------

const LAYER_CLASS = 'qx-wall-layer';
const DYNAMIC_BODY_CLASS = 'qx-wall-dynamic';
const CAPTURE_BODY_CLASS = 'qx-wall-capture';

let layerEl = null;
let activeKind = '';
let engineHandle = null;
let engineRaf = 0;
let engineResize = null;
let lastFrame = 0;
let lastDark = null;
let audioUnlockOff = null;
let pointerBoundOn = null;
let pointerDown = false;
let videoEl = null;
let frameEl = null;

function deskEl() {
  return document.querySelector('.desk') || document.querySelector('.desk-area');
}

function ensureLayer() {
  if (typeof document === 'undefined') return null;
  if (layerEl && layerEl.isConnected) return layerEl;
  layerEl = document.createElement('div');
  layerEl.className = LAYER_CLASS;
  layerEl.setAttribute('aria-hidden', 'true');
  // 挂在 body 下、#root 之前：桌面本身由 vdom 反复 patch，往 .desk 里塞节点
  // 会被下一次 diff 当成未知子节点处理掉。
  const root = document.getElementById('root');
  if (root && root.parentNode === document.body) document.body.insertBefore(layerEl, root);
  else document.body.prepend(layerEl);
  return layerEl;
}

function clearLayerChildren() {
  if (layerEl) layerEl.textContent = '';
  videoEl = null;
  frameEl = null;
}

function stopEngine() {
  if (engineRaf) {
    cancelAnimationFrame(engineRaf);
    engineRaf = 0;
  }
  if (engineResize) {
    window.removeEventListener('resize', engineResize);
    engineResize = null;
  }
  if (engineHandle && typeof engineHandle.destroy === 'function') {
    try { engineHandle.destroy(); } catch { /* 引擎清理失败不影响换壁纸 */ }
  }
  engineHandle = null;
  lastDark = null;
}

/** 彻底拆掉动态层，回到静态壁纸 */
function removeDynamicLayer() {
  stopEngine();
  unbindPointer();
  disarmAudioUnlock();
  clearLayerChildren();
  if (layerEl) {
    layerEl.remove();
    layerEl = null;
  }
  activeKind = '';
  if (typeof document !== 'undefined') {
    document.body.classList.remove(DYNAMIC_BODY_CLASS, CAPTURE_BODY_CLASS);
    // 动态模式把 .desk 的背景简写清成了 none，回静态壁纸时要把内联覆盖撤掉，
    // 否则 --desk-ambient 这类主题背景色会一起丢掉。
    const desk = document.querySelector('.desk');
    if (desk) desk.style.removeProperty('background');
  }
}

function unbindPointer() {
  if (pointerBoundOn) {
    pointerBoundOn.removeEventListener('pointermove', onDeskPointer);
    pointerBoundOn.removeEventListener('pointerdown', onDeskPointerDown);
    pointerBoundOn.removeEventListener('pointerup', onDeskPointerUp);
    pointerBoundOn = null;
  }
  pointerDown = false;
}

function onDeskPointerDown(ev) {
  pointerDown = true;
  onDeskPointer(ev);
}

function onDeskPointerUp() {
  pointerDown = false;
}

function onDeskPointer(ev) {
  if (!layerEl) return;
  const x = ev.clientX;
  const y = ev.clientY;
  if (activeKind === 'engine' && engineHandle && typeof engineHandle.pointer === 'function') {
    engineHandle.pointer(x, y, pointerDown);
    return;
  }
  if (activeKind === 'web' && frameEl && frameEl.contentWindow) {
    try {
      frameEl.contentWindow.postMessage({ __qxWall: 1, type: 'pointer', x, y, down: pointerDown }, '*');
    } catch { /* 包页面沙箱化后 postMessage 仍可用，失败只说明帧已卸载 */ }
  }
}

function bindPointer(area) {
  unbindPointer();
  if (!area) return;
  pointerBoundOn = area;
  area.addEventListener('pointermove', onDeskPointer, { passive: true });
  area.addEventListener('pointerdown', onDeskPointerDown, { passive: true });
  area.addEventListener('pointerup', onDeskPointerUp, { passive: true });
}

function renderEngine(desk, item) {
  const layer = ensureLayer();
  if (!layer) return;
  const def = getWallEngine(item.engine);
  if (!def) {
    removeDynamicLayer();
    desk.style.background = '';
    return;
  }
  const dark = normTier() === TIER_DARK;
  if (activeKind !== 'engine' || !engineHandle || lastDark !== dark) {
    stopEngine();
    clearLayerChildren();
    const canvas = document.createElement('canvas');
    canvas.className = 'qx-wall-canvas';
    layer.append(canvas);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (engineHandle && typeof engineHandle.resize === 'function') engineHandle.resize(w, h, dpr);
    };
    engineHandle = def.create({
      ctx: canvas.getContext('2d'), w: window.innerWidth, h: window.innerHeight, dpr, dark,
    }) || {};
    if (typeof engineHandle.resize === 'function') engineHandle.resize(window.innerWidth, window.innerHeight, dpr);
    window.addEventListener('resize', resize);
    engineResize = resize;
    lastDark = dark;
    const speed = getEngineOptions().speed;
    lastFrame = 0;
    let elapsed = 0;
    const loop = (ts) => {
      engineRaf = requestAnimationFrame(loop);
      if (!lastFrame) lastFrame = ts;
      const dt = Math.min(0.1, (ts - lastFrame) / 1000);
      lastFrame = ts;
      if (document.hidden) return;
      elapsed += dt * speed;
      try { engineHandle.draw(dt * speed, elapsed); } catch (err) { console.warn('[wallpaper] 引擎绘制失败', err); }
    };
    engineRaf = requestAnimationFrame(loop);
  }
  activeKind = 'engine';
  document.body.classList.add(DYNAMIC_BODY_CLASS);
  document.body.classList.remove(CAPTURE_BODY_CLASS);
  desk.style.background = 'none';
  bindPointer(desk.querySelector?.('.desk-area') || desk);
}

function renderVideo(desk, item, opts) {
  const layer = ensureLayer();
  if (!layer) return;
  if (activeKind !== 'video' || !videoEl || !videoEl.isConnected) {
    stopEngine();
    clearLayerChildren();
    const v = document.createElement('video');
    v.className = 'qx-wall-video';
    v.playsInline = true;
    v.autoplay = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    layer.append(v);
    videoEl = v;
  }
  if (videoEl.dataset.src !== item.url) {
    videoEl.src = item.url;
    videoEl.dataset.src = item.url;
    videoEl.load();
  }
  videoEl.style.objectFit = fitToObjectFit(getWallpaperFit());
  const wantAudio = opts.audio === true;
  videoEl.loop = opts.loop;
  videoEl.playbackRate = opts.rate;
  videoEl.volume = opts.volume;
  videoEl.muted = !wantAudio;
  activeKind = 'video';
  document.body.classList.add(DYNAMIC_BODY_CLASS);
  document.body.classList.remove(CAPTURE_BODY_CLASS);
  desk.style.background = 'none';
  unbindPointer();
  unlockAudio(videoEl, wantAudio, opts.volume);
  videoEl.play().catch(() => {
    // 自动播放被拦时先静音播，等用户第一次点桌面再解锁声音。
    videoEl.muted = true;
    videoEl.play().catch(() => { /* 连静音都播不了就保持静止首帧 */ });
  });
}

function renderWeb(desk, item, opts) {
  const layer = ensureLayer();
  if (!layer) return;
  if (activeKind !== 'web' || !frameEl || !frameEl.isConnected) {
    stopEngine();
    clearLayerChildren();
    const f = document.createElement('iframe');
    f.className = 'qx-wall-frame';
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups');
    f.setAttribute('allow', 'autoplay; fullscreen');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('aria-hidden', 'true');
    layer.append(f);
    frameEl = f;
  }
  const src = item.builtin
    ? `${item.url}/${String(item.entry || 'index.html')}`
    : (() => {
      const meta = getLibraryMeta();
      return wallpaperFileUrl(meta.token, item.name, item.entry || 'index.html');
    })();
  if (frameEl.dataset.src !== src) {
    frameEl.src = src;
    frameEl.dataset.src = src;
  }
  activeKind = 'web';
  document.body.classList.add(DYNAMIC_BODY_CLASS);
  document.body.classList.toggle(CAPTURE_BODY_CLASS, opts.capture === true);
  desk.style.background = 'none';
  bindPointer(desk.querySelector?.('.desk-area') || desk);
  if (opts.capture) {
    // 接管指针时桌面图标暂时点不到：给一次明确的可退出口。
    toastHint();
  }
}

let hintDone = false;

function toastHint() {
  if (hintDone || typeof document === 'undefined') return;
  hintDone = true;
  const tip = document.createElement('div');
  tip.className = 'qx-wall-capture-tip';
  tip.textContent = t('app.core.wall-capture-tip');
  document.body.append(tip);
  const off = (ev) => {
    if (ev && ev.key !== 'Escape') return;
    document.body.classList.remove(CAPTURE_BODY_CLASS);
    tip.remove();
    window.removeEventListener('keydown', off, true);
  };
  window.addEventListener('keydown', off, true);
  setTimeout(() => off(), 4000);
}

function disarmAudioUnlock() {
  if (!audioUnlockOff) return;
  try { audioUnlockOff(); } catch { /* 已经卸下 */ }
  audioUnlockOff = null;
}

/**
 * 浏览器只在「用户手势」之后才允许有声播放，所以带声音的视频壁纸要先静音起播，
 * 等桌面上出现第一次点击/按键再解除静音；切换壁纸或关掉声音时把监听摘掉。
 */
function unlockAudio(video, wantAudio, volume) {
  disarmAudioUnlock();
  if (!wantAudio || typeof window === 'undefined') return;
  const unlock = async () => {
    disarmAudioUnlock();
    try {
      video.muted = false;
      video.volume = volume;
      await video.play();
    } catch { /* 仍被策略拦住就继续静音播放 */ }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  audioUnlockOff = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
}

// 页面切到后台时暂停视频：看不见的时候不该继续解码烧 CPU 与电量。
// 引擎在 requestAnimationFrame 里自己跳过隐藏帧，不必单独处理。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (activeKind !== 'video' || !videoEl) return;
    if (document.hidden) videoEl.pause();
    else videoEl.play().catch(() => { });
  });
}

const TEX_LAYER_CLASS = 'qx-texture';

function removeTextureLayer() {
  document.querySelector(`body > .${TEX_LAYER_CLASS}`)?.remove();
}

function ensureTextureLayer(target, tier) {
  const tex = getSelectedTexture(target, tier);
  if (!tex) {
    removeTextureLayer();
    return null;
  }
  let el = document.querySelector(`body > .${TEX_LAYER_CLASS}`);
  if (!el) {
    el = dom('div', { class: TEX_LAYER_CLASS, 'aria-hidden': 'true' });
    document.body.appendChild(el);
  }
  el.style.setProperty('--qx-tex-src', `url("${tex.url}")`);
  el.style.setProperty('--qx-tex-size', textureTileSize(tex, target, tier));
  el.style.setProperty('--qx-tex-base', getTextureBase(target, tier));
  el.style.setProperty('--qx-tex-line', getTextureLine(target, tier));
  el.style.setProperty('--qx-tex-a', String(getTextureAlpha(target, tier)));
  return el;
}

/** 把当前设置应用到桌面或启动页 */
export async function applyWallpaper(target = TARGET_DESKTOP, tier) {
  if (target === TARGET_BOOT) {
    await applyBootWallpaper(true, tier);
    return;
  }
  const desk = deskEl();
  if (!desk) {
    if (getMode(target, tier) !== 'texture') removeTextureLayer();
    return;
  }

  const mode = getMode(target, tier);

  if (mode !== 'color') {
    await loadWallpapers();
    if (!isSelectionResolvable(target, tier)
      || (mode === 'texture' && !getSelectedTexture(target, tier))) {
      await loadWallpapers(true);
    }
  }

  if (mode === 'color') {
    removeTextureLayer();
    removeDynamicLayer();
    desk.style.backgroundColor = getColorWallpaper(target, tier);
    desk.style.backgroundImage = 'none';
    desk.style.backgroundSize = '';
    desk.style.backgroundPosition = '';
    desk.style.backgroundRepeat = '';
    scheduleRotation();
    return;
  }

  if (mode === 'texture') {
    removeDynamicLayer();
    const el = ensureTextureLayer(target, tier);
    if (el) {
      desk.style.background = 'none';
      scheduleRotation();
      return;
    }
  }

  // 图片与三种动态壁纸共用的收尾：清掉纹理层与旧背景。
  removeTextureLayer();
  const item = findWallpaper(getSelectedWallpaperId(target, tier));

  if (item && !item.problem && mode === 'video' && item.kind === WALL_KIND.VIDEO) {
    renderVideo(desk, item, getVideoOptions(target, tier));
    scheduleRotation();
    return;
  }
  if (item && !item.problem && mode === 'web' && item.kind === WALL_KIND.WEB) {
    renderWeb(desk, item, getWebOptions(target, tier));
    scheduleRotation();
    return;
  }
  if (item && mode === 'engine' && item.kind === WALL_KIND.ENGINE) {
    renderEngine(desk, item);
    scheduleRotation();
    return;
  }

  // 其余情况（含动态条目缺失或损坏）：回退到静态图片。
  removeDynamicLayer();
  const url = (item && item.url) || (firstImageItem() || {}).url || '';
  if (!url) {
    desk.style.background = 'none';
    scheduleRotation();
    return;
  }
  desk.style.backgroundColor = '';
  desk.style.backgroundImage = `url("${url}")`;
  Object.assign(desk.style, wallpaperFitStyle(getWallpaperFit(target, tier)));
  scheduleRotation();
}

async function applyBootWallpaper(ensureLoaded, tier) {
  const el = document.querySelector(`.${TEX_LAYER_CLASS}`);
  if (!el) return;
  if (ensureLoaded) {
    await loadWallpapers();
    if (!isSelectionResolvable(TARGET_BOOT, tier)
      || (getMode(TARGET_BOOT, tier) === 'texture' && !getSelectedTexture(TARGET_BOOT, tier))) {
      await loadWallpapers(true);
    }
  }
  // 启动页只承载静态壁纸：动态壁纸在启动页既没必要，也要避免和首屏动画抢帧。
  let mode = getMode(TARGET_BOOT, tier);
  if (mode === 'video' || mode === 'web' || mode === 'engine') mode = 'image';

  if (mode === 'color') {
    el.classList.add('no-mask');
    el.style.backgroundImage = 'none';
    el.style.backgroundColor = getColorWallpaper(TARGET_BOOT, tier);
    return;
  }
  if (mode === 'texture') {
    const tex = getSelectedTexture(TARGET_BOOT, tier);
    if (tex) {
      el.classList.remove('no-mask');
      el.style.backgroundImage = '';
      el.style.backgroundColor = '';
      el.style.setProperty('--qx-tex-src', `url("${tex.url}")`);
      el.style.setProperty('--qx-tex-size', textureTileSize(tex, TARGET_BOOT, tier));
      el.style.setProperty('--qx-tex-base', getTextureBase(TARGET_BOOT, tier));
      el.style.setProperty('--qx-tex-line', getTextureLine(TARGET_BOOT, tier));
      el.style.setProperty('--qx-tex-a', String(getTextureAlpha(TARGET_BOOT, tier)));
      return;
    }
  }

  el.classList.add('no-mask');
  el.style.backgroundColor = '';
  const url = getDefaultWallpaper(TARGET_BOOT, tier);
  el.style.backgroundImage = url ? `url("${url}")` : 'none';
  if (url) Object.assign(el.style, wallpaperFitStyle(getWallpaperFit(TARGET_BOOT, tier)));
}

/** 在桌面启动时调用一次：应用已存的壁纸并开始轮播计时 */
export function initWallpaper() {
  scheduleRotation();
  return applyWallpaper(TARGET_DESKTOP);
}

/** 供界面显示用的压缩体积文案 */
export { formatBytes };
