/**
 * core/wallpapers.js —— 壁纸库客户端
 *
 * 壁纸库有两个来源，这里把它们合成一份清单：
 *   - 内置：assets/images/background/index.json 描述的图片、纹理与（可选的）内置视频/交互包；
 *   - 用户：配置目录 wallpapers/ 下的图片、视频与交互壁纸包，经 wallpapers/* 端点读写。
 *
 * 用户壁纸不走 localfs/*：那条通道对配置目录整体拒绝访问（凭据库与应用代码都在里面），
 * 所以壁纸有独立端点，文件还有一枚能力令牌，见 wallpaperFileUrl()。
 */
import { sysGet, sysFetch, sysUrl } from './sys.js';

const INDEX_URL = '/assets/images/background/index.json';
const BUILTIN_BASE = '/assets/images/background';
const TEXTURE_BASE = '/assets/images/background/texture';

/** 壁纸类型：静态图片、视频、交互壁纸包、内置交互引擎、纹理。 */
export const WALL_KIND = {
  IMAGE: 'image',
  VIDEO: 'video',
  WEB: 'web',
  ENGINE: 'engine',
  TEXTURE: 'texture',
};

/** 前端兜底的大小上限，服务端会返回更准确的值并覆盖它。 */
export const WALL_LIMITS = {
  maxFileBytes: 512 << 20,
  maxPackBytes: 512 << 20,
};

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'];
const VIDEO_EXTS = ['.mp4', '.webm', '.ogv', '.ogg', '.m4v', '.mov'];
const PACK_EXTS = ['.zip', '.qxp'];
const MAX_NAME_BYTES = 96;

let cacheP = null;
let cacheForceKey = 0;

/** 清空清单缓存，下一次 fetch 会重新拉取 */
export function invalidateWallpaperLibrary() {
  cacheP = null;
  cacheForceKey += 1;
}

function enc(s) {
  return encodeURIComponent(String(s));
}

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i >= 0 ? String(name).slice(i).toLowerCase() : '';
}

/** 按文件名推断类型；无法识别返回空串 */
export function kindOfFile(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.includes(ext)) return WALL_KIND.IMAGE;
  if (VIDEO_EXTS.includes(ext)) return WALL_KIND.VIDEO;
  if (PACK_EXTS.includes(ext)) return WALL_KIND.WEB;
  return '';
}

/** 取可用作壁纸条目标识的稳定 id */
export function wallIdOf(entry) {
  if (!entry) return '';
  if (entry.id) return entry.id;
  if (entry.builtin) return `b:${entry.theme || 'any'}:${entry.name}`;
  return `u:${entry.name}`;
}

/** 拼壁纸文件地址：令牌 + 条目名 + 可选包内相对路径 */
export function wallpaperFileUrl(token, name, rel = '') {
  const segs = [enc(token), enc(name)];
  if (rel) {
    for (const part of String(rel).split('/')) {
      if (part) segs.push(enc(part));
    }
  }
  return sysUrl(`wallpapers/file/${segs.join('/')}`);
}

function builtinEntry(raw, kind) {
  const theme = raw.theme === 'dark' || raw.theme === 'light' ? raw.theme : 'any';
  const dir = kind === WALL_KIND.VIDEO ? 'video' : kind === WALL_KIND.WEB ? 'pack' : theme;
  return {
    id: `b:${dir}:${raw.name}`,
    name: raw.name,
    title: raw.title || raw.name,
    kind,
    theme,
    builtin: true,
    audio: raw.audio === true,
    entry: raw.entry || '',
    url: `${BUILTIN_BASE}/${dir}/${enc(raw.name)}`,
    poster: raw.poster ? `${BUILTIN_BASE}/${dir}/${enc(raw.poster)}` : '',
    size: raw.size || 0,
  };
}

function userEntry(raw, token) {
  const kind = raw.kind === WALL_KIND.VIDEO ? WALL_KIND.VIDEO
    : raw.kind === WALL_KIND.WEB ? WALL_KIND.WEB : WALL_KIND.IMAGE;
  return {
    id: `u:${raw.name}`,
    name: raw.name,
    title: raw.title || raw.name,
    kind,
    theme: raw.theme || 'any',
    builtin: false,
    audio: raw.audio === true,
    entry: raw.entry || '',
    problem: raw.problem || '',
    size: raw.size || 0,
    modTime: raw.modTime || 0,
    url: wallpaperFileUrl(token, raw.name),
  };
}

/**
 * 拉取合并后的壁纸库。
 * 内置清单与用户库各自容错：任一来源失败时另一来源仍然可用。
 */
export async function fetchLibrary({ force = false } = {}) {
  if (cacheP && !force) return cacheP;
  const myKey = cacheForceKey;
  const task = (async () => {
    const out = {
      items: [],
      textures: [],
      dir: '',
      token: '',
      limits: { ...WALL_LIMITS },
      exts: { image: IMAGE_EXTS.slice(), video: VIDEO_EXTS.slice(), pack: PACK_EXTS.slice() },
    };
    try {
      const res = await fetch(INDEX_URL, { cache: 'no-cache' });
      if (res.ok) {
        const idx = await res.json();
        for (const w of idx.wallpapers || []) {
          if (w && w.name) out.items.push(builtinEntry(w, WALL_KIND.IMAGE));
        }
        for (const v of idx.videos || []) {
          if (v && v.name) out.items.push(builtinEntry(v, WALL_KIND.VIDEO));
        }
        for (const p of idx.packs || []) {
          if (p && p.name) out.items.push(builtinEntry(p, WALL_KIND.WEB));
        }
        for (const tex of idx.textures || []) {
          if (!tex || !tex.file || !(tex.w > 0) || !(tex.h > 0)) continue;
          out.textures.push({
            name: tex.name, w: tex.w, h: tex.h,
            url: `${TEXTURE_BASE}/${enc(tex.file)}`,
          });
        }
      }
    } catch (err) {
      console.warn('[wallpapers] 内置清单加载失败', err);
    }
    try {
      const lib = await sysGet('wallpapers/list');
      out.dir = String(lib.dir || '');
      out.token = String(lib.token || '');
      if (lib.maxFileBytes > 0) out.limits.maxFileBytes = lib.maxFileBytes;
      if (lib.maxPackBytes > 0) out.limits.maxPackBytes = lib.maxPackBytes;
      if (Array.isArray(lib.imageExts) && lib.imageExts.length) out.exts.image = lib.imageExts;
      if (Array.isArray(lib.videoExts) && lib.videoExts.length) out.exts.video = lib.videoExts;
      if (Array.isArray(lib.packExts) && lib.packExts.length) out.exts.pack = lib.packExts;
      for (const raw of lib.entries || []) {
        if (raw && raw.name) out.items.push(userEntry(raw, out.token));
      }
    } catch (err) {
      console.warn('[wallpapers] 用户壁纸库读取失败', err);
    }
    return out;
  })();
  cacheP = task;
  try {
    const lib = await task;
    // 期间发生过 invalidate：本次结果已过期，下次重新拉。
    if (myKey !== cacheForceKey) cacheP = null;
    return lib;
  } catch (err) {
    cacheP = null;
    throw err;
  }
}

/** 把上传文件名清洗为安全且长度受控的名字 */
export function safeWallpaperName(raw) {
  const base = String(raw || '').replace(/\\/g, '/').split('/').pop() || '';
  let out = '';
  for (const ch of base) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7f) continue;
    out += '<>:"/\\|?*'.includes(ch) ? '_' : ch;
  }
  out = out.trim();
  if (out === '.' || out === '..') return '';
  const ext = extOf(base);
  const enc2 = new TextEncoder();
  const limit = Math.max(1, MAX_NAME_BYTES - enc2.encode(ext).length);
  if (enc2.encode(out).length > limit) {
    let stem = out;
    while (stem && enc2.encode(stem).length > limit) stem = stem.slice(0, -1);
    out = stem.trim() + ext;
  }
  return out;
}

function byteSizeText(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 把字节数格式化为人类可读的文本 */
export function formatBytes(bytes) {
  return byteSizeText(bytes);
}

/**
 * 上传图片或视频壁纸。
 * 服务端按扩展名判定类型，大小与扩展名都在服务端再校验一遍。
 */
export async function uploadWallpaper(file) {
  if (!file) throw new Error('没有选择文件');
  const name = safeWallpaperName(file.name);
  if (!name) throw new Error('文件名不合法');
  const kind = kindOfFile(name);
  if (kind !== WALL_KIND.IMAGE && kind !== WALL_KIND.VIDEO) {
    throw new Error(`不支持的壁纸类型：${extOf(name) || name}`);
  }
  const lib = await fetchLibrary();
  const limit = kind === WALL_KIND.VIDEO ? lib.limits.maxFileBytes : Math.min(lib.limits.maxFileBytes, 64 << 20);
  if (file.size > limit) throw new Error(`文件过大（上限 ${formatBytes(limit)}）`);
  const res = await sysFetch('POST', 'wallpapers/upload', { query: { name }, blob: file });
  invalidateWallpaperLibrary();
  return res.wallpaper;
}

/**
 * 导入交互壁纸包（zip 内需含 index.html 或 wallpaper.json 声明的入口）。
 * 包会在服务端整体解到临时目录再改名，失败不会留下半个包。
 */
export async function importWallpaperPack(file) {
  if (!file) throw new Error('没有选择壁纸包');
  const name = safeWallpaperName(file.name);
  if (!name) throw new Error('文件名不合法');
  if (!PACK_EXTS.includes(extOf(name))) throw new Error('交互壁纸包必须是 .zip');
  const lib = await fetchLibrary();
  if (file.size > lib.limits.maxPackBytes) {
    throw new Error(`壁纸包过大（上限 ${formatBytes(lib.limits.maxPackBytes)}）`);
  }
  const res = await sysFetch('POST', 'wallpapers/import', { query: { name }, blob: file });
  invalidateWallpaperLibrary();
  return res.wallpaper;
}

/** 删除用户壁纸库里的一个条目（文件或交互包） */
export async function deleteWallpaper(name) {
  const n = String(name || '');
  if (!n || n === '.' || n === '..' || /[/\\]/.test(n)) throw new Error('壁纸名称不合法');
  await sysFetch('POST', 'wallpapers/delete', { body: { name: n } });
  invalidateWallpaperLibrary();
  return { ok: true };
}
