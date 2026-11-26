/**
 * apps/wallpapercat/app.js —— 壁纸猫猫
 *
 * 要点：壁纸的唯一管理入口——图片、视频、交互壁纸包与内置交互引擎都在这里挑选、
 * 上传、删除；外观（目标/主题档/类型/填充/纯色/纹理）与播放（声音、指针、轮播）
 * 也集中在这里。所有改动写进偏好后通过宿主桥重建桌面壁纸，本页面不直接碰宿主 DOM。
 */
import { bootApp, applyWallpaper as hostApply } from '/assets/js/app-bridge.js';
import { h, createView } from '/assets/js/core/vdom.js';
import { signal } from '/assets/js/core/signal.js';
import { toast, confirmAction } from '/assets/js/core/ui.js';
import {
  card, sectionTitle, chipGroup, segmented, sidebarSections, spinner, emptyState, icon, badge,
} from '/assets/js/core/components.js';
import { setupI18n, t, tf, lang } from '/assets/js/core/i18n.js';
import { auditNote } from '/assets/js/core/qxssh-api.js';
import {
  loadWallpapers, refreshWallpapers, getWallpaperItems, getTextureItems,
  getSelectedWallpaperId, getSelectedWallpaperItem, selectWallpaper, settleSelectionAfterDelete,
  getMode, getColorWallpaper, setColorWallpaper,
  getWallpaperFit, setWallpaperFit, wallpaperFitStyle,
  getSelectedTexture, selectTexture, getTextureBase, getTextureLine, getTextureAlpha, getTextureDensity,
  setTextureColors, setTextureDensity, textureTileSize, resetWallpaper,
  TARGET_DESKTOP, TARGET_BOOT, TIER_LIGHT, TIER_DARK, currentTier,
  TEX_ALPHA_MIN, TEX_ALPHA_MAX, TEX_DENSITY_MIN, TEX_DENSITY_MAX,
  getVideoOptions, setVideoOption, getWebOptions, setWebOption, getEngineOptions, setEngineSpeed,
  getRotation, setRotation, rotationCandidates,
  getLibraryMeta, wallTitle, formatBytes,
} from '/assets/js/desktop/wallpaper.js';
import {
  uploadWallpaper, importWallpaperPack, deleteWallpaper, WALL_KIND,
} from '/assets/js/core/wallpapers.js';

const PRESET_COLORS = [
  '#1a1a2e', '#16213e', '#0f3460', '#533483',
  '#1e3a5f', '#2c3e50', '#34495e', '#2d3436',
  '#1b1b1b', '#2b2b2b', '#3d2c2e', '#1f2937',
  '#065f46', '#14532d', '#7c2d12', '#881337',
];

const TABS = [
  { id: 'mine', key: 'app.wallpapercat.tab-mine', icon: 'image' },
  { id: 'system', key: 'app.wallpapercat.tab-system', icon: 'layers' },
  { id: 'look', key: 'app.wallpapercat.tab-look', icon: 'palette' },
  { id: 'play', key: 'app.wallpapercat.tab-play', icon: 'play' },
];

function boot(el) {
  const tab = signal('mine');
  const target = signal(TARGET_DESKTOP);
  const tier = signal(currentTier());
  const loaded = signal(false);
  const rev = signal(0);
  const busy = signal('');
  const liveColor = signal('');

  const isBootTarget = () => target.value === TARGET_BOOT;
  const isCurrentTier = () => tier.value === currentTier();
  const note = (what) => {
    try { auditNote('wallpaper', `${isBootTarget() ? 'boot' : 'desktop'} ${tier.value} ${what}`); } catch { /* 审计失败不影响操作 */ }
  };
  const push = () => { try { hostApply(); } catch { /* 宿主不在时留在下一次刷新生效 */ } };

  function applyAndNote(what) {
    push();
    note(what);
  }

  async function reload(force = true) {
    if (force) await refreshWallpapers();
    else await loadWallpapers();
    loaded.next = true;
    rev.next += 1;
  }

  // ---------- 选择与上传 ----------

  function pickItem(item) {
    if (!item) return;
    if (isBootTarget() && (item.kind === WALL_KIND.VIDEO || item.kind === WALL_KIND.WEB || item.kind === WALL_KIND.ENGINE)) {
      toast(t('app.wallpapercat.boot-only-static'), 'warning');
      return;
    }
    selectWallpaper(item.id, target.value, tier.value);
    applyAndNote(`select ${item.name}`);
    rev.next += 1;
  }

  async function onPickFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    busy.next = 'upload';
    let last = null;
    try {
      for (const file of list) {
        last = await uploadWallpaper(file);
        toast(tf('app.wallpapercat.uploaded', { v1: last.name }), 'success');
      }
      await reload(true);
      if (last) {
        selectWallpaper(`u:${last.name}`, target.value, tier.value);
        applyAndNote(`upload ${last.name}`);
        rev.next += 1;
      }
    } catch (err) {
      toast(t('app.wallpapercat.upload-failed') + (err.message || err), 'error');
    } finally {
      busy.next = '';
    }
  }

  async function onPickPack(file) {
    if (!file) return;
    busy.next = 'import';
    try {
      const item = await importWallpaperPack(file);
      await reload(true);
      selectWallpaper(`u:${item.name}`, target.value, tier.value);
      applyAndNote(`import ${item.name}`);
      rev.next += 1;
      toast(tf('app.wallpapercat.imported', { v1: item.title || item.name }), 'success');
    } catch (err) {
      toast(t('app.wallpapercat.import-failed') + (err.message || err), 'error');
    } finally {
      busy.next = '';
    }
  }

  async function onDelete(item) {
    const ok = await confirmAction(
      t('app.wallpapercat.delete-title'),
      tf('app.wallpapercat.delete-body', { v1: wallTitle(item) }),
    );
    if (!ok) return;
    try {
      await deleteWallpaper(item.name);
      await reload(true);
      const switched = settleSelectionAfterDelete(item.id, target.value, tier.value);
      applyAndNote(`delete ${item.name}`);
      rev.next += 1;
      toast(switched
        ? tf('app.wallpapercat.deleted-switched', { v1: wallTitle(item) })
        : tf('app.wallpapercat.deleted', { v1: wallTitle(item) }), 'success');
    } catch (err) {
      toast(t('app.wallpapercat.delete-failed') + (err.message || err), 'error');
    }
  }

  // ---------- 通用控件 ----------

  function targetBar() {
    return h('div', { class: 'wc-bar' }, [
      h('span', { class: 'wc-bar-label', text: t('app.wallpapercat.field-target') }),
      segmented([
        { value: TARGET_DESKTOP, label: t('app.wallpapercat.target-desktop') },
        { value: TARGET_BOOT, label: t('app.wallpapercat.target-boot') },
      ], target.value, (v) => { target.next = v; liveColor.next = ''; }),
    ]);
  }

  function tierBar() {
    return h('div', { class: 'wc-bar' }, [
      h('span', { class: 'wc-bar-label', text: t('app.wallpapercat.field-tier') }),
      segmented([
        { value: TIER_LIGHT, label: t('app.wallpapercat.tier-light') },
        { value: TIER_DARK, label: t('app.wallpapercat.tier-dark') },
      ], tier.value, (v) => { tier.next = v; liveColor.next = ''; }),
      isCurrentTier() ? null : h('span', { class: 'wc-hint', text: t('app.wallpapercat.tier-not-current') }),
    ]);
  }

  function itemBadges(item) {
    const out = [];
    if (item.kind === WALL_KIND.VIDEO) out.push(badge(t('app.wallpapercat.badge-video'), 'warn'));
    if (item.kind === WALL_KIND.WEB) out.push(badge(t('app.wallpapercat.badge-web'), 'success'));
    if (item.kind === WALL_KIND.ENGINE) out.push(badge(t('app.wallpapercat.badge-engine'), 'success'));
    if (item.problem) out.push(badge(t('app.wallpapercat.badge-broken'), 'danger'));
    return out;
  }

  function subline(item) {
    if (item.problem) return item.problem;
    const bits = [];
    if (item.kind === WALL_KIND.VIDEO) bits.push(t('app.wallpapercat.badge-video'));
    if (item.kind === WALL_KIND.WEB) bits.push(item.entry || 'index.html');
    if (item.size) bits.push(formatBytes(item.size));
    return bits.join(' · ') || (item.builtin ? t('app.wallpapercat.badge-builtin') : '');
  }

  function thumbStyle(item) {
    if (item.kind === WALL_KIND.IMAGE && item.url) {
      return { backgroundImage: `url("${item.url}")` };
    }
    return null;
  }

  function itemCard(item) {
    const on = getSelectedWallpaperId(target.value, tier.value) === item.id;
    const bg = thumbStyle(item);
    const plainIcon = item.kind === WALL_KIND.VIDEO ? 'play'
      : item.kind === WALL_KIND.WEB ? 'grid'
        : item.kind === WALL_KIND.ENGINE ? 'sparkles' : 'image';
    return h('div', { key: item.id, class: 'wc-item' }, [
      h('button', {
        class: `wc-thumb${bg ? '' : ' wc-thumb-plain'}${on ? ' active' : ''}`,
        type: 'button',
        style: bg || undefined,
        dataset: { tip: wallTitle(item) },
        onClick: () => pickItem(item),
      }, [
        bg ? null : h('span', { class: 'wc-thumb-ic', html: icon(plainIcon, 'qicon') }),
        h('span', { class: 'wc-thumb-tags' }, itemBadges(item)),
      ]),
      h('div', { class: 'wc-meta' }, [
        h('span', { class: 'wc-name', text: wallTitle(item), title: wallTitle(item) }),
        h('span', { class: 'wc-sub', text: subline(item) }),
      ]),
      item.builtin ? null : h('button', {
        class: 'wc-del',
        type: 'button',
        'aria-label': tf('app.wallpapercat.delete-aria', { v1: wallTitle(item) }),
        dataset: { tip: t('app.wallpapercat.action-delete') },
        html: icon('trash-2', 'qicon qicon-sm'),
        onClick: () => onDelete(item),
      }),
    ]);
  }

  function grid(list, footer) {
    return h('div', { class: 'wc-grid' }, [
      ...list.map((item) => itemCard(item)),
      footer || null,
    ]);
  }

  // ---------- 我的壁纸 ----------

  function mineTree() {
    const items = getWallpaperItems().filter((x) => !x.builtin);
    const images = items.filter((x) => x.kind === WALL_KIND.IMAGE);
    const videos = items.filter((x) => x.kind === WALL_KIND.VIDEO);
    const packs = items.filter((x) => x.kind === WALL_KIND.WEB);
    const meta = getLibraryMeta();

    const fileInput = { current: null };
    const packInput = { current: null };

    const uploadBtn = h('button', {
      class: 'btn btn-primary btn-sm',
      type: 'button',
      disabled: busy.value === 'upload',
      html: `${icon('upload', 'qicon qicon-sm')}<span>${busy.value === 'upload' ? t('app.wallpapercat.uploading') : t('app.wallpapercat.action-upload')}</span>`,
      onClick: () => { if (fileInput.current) fileInput.current.click(); },
    });
    const importBtn = h('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      disabled: busy.value === 'import',
      html: `${icon('file-stack', 'qicon qicon-sm')}<span>${busy.value === 'import' ? t('app.wallpapercat.importing') : t('app.wallpapercat.action-import')}</span>`,
      onClick: () => { if (packInput.current) packInput.current.click(); },
    });

    const empty = h('div', { class: 'wc-empty' }, [
      h('span', { class: 'wc-empty-ic', html: icon('image', 'qicon') }),
      h('span', { class: 'wc-empty-title', text: t('app.wallpapercat.empty-mine') }),
      h('span', { class: 'wc-empty-desc', text: t('app.wallpapercat.empty-mine-hint') }),
    ]);

    const section = (title, list) => (list.length
      ? h('div', { class: 'wc-section' }, [sectionTitle(title), grid(list)])
      : null);

    return [
      card(t('app.wallpapercat.mine-title'), [
        targetBar(),
        tierBar(),
        h('div', { class: 'wc-actions' }, [uploadBtn, importBtn]),
        h('p', { class: 'wc-note', text: t('app.wallpapercat.upload-hint') }),
        images.length || videos.length || packs.length
          ? h('div', { class: 'wc-sections' }, [
            section(t('app.wallpapercat.section-images'), images),
            section(t('app.wallpapercat.section-videos'), videos),
            section(t('app.wallpapercat.section-packs'), packs),
          ].filter(Boolean))
          : empty,
        h('p', { class: 'wc-path' }, [
          h('span', { text: t('app.wallpapercat.lib-path') }),
          h('code', { text: meta.dir || '-' }),
        ]),
        h('input', {
          ref: fileInput,
          type: 'file',
          accept: 'image/*,video/*',
          multiple: true,
          hidden: true,
          onChange: async (ev) => {
            const files = ev.target.files;
            ev.target.value = '';
            await onPickFiles(files);
          },
        }),
        h('input', {
          ref: packInput,
          type: 'file',
          accept: '.zip,.qxp,application/zip',
          hidden: true,
          onChange: async (ev) => {
            const file = ev.target.files && ev.target.files[0];
            ev.target.value = '';
            await onPickPack(file);
          },
        }),
      ]),
    ];
  }

  // ---------- 系统壁纸 ----------

  function textureSwatch(tex) {
    const base = getTextureBase(target.value, tier.value);
    const line = getTextureLine(target.value, tier.value);
    const a = getTextureAlpha(target.value, tier.value);
    const overlay = `color-mix(in srgb, ${line} ${(a * 100).toFixed(1)}%, transparent)`;
    return {
      backgroundColor: base,
      backgroundImage: `linear-gradient(${overlay} 0 100%)`,
      maskImage: `url("${tex ? tex.url : ''}")`,
      WebkitMaskImage: `url("${tex ? tex.url : ''}")`,
      maskSize: textureTileSize(tex, target.value, tier.value),
      WebkitMaskSize: textureTileSize(tex, target.value, tier.value),
      maskRepeat: 'repeat',
      WebkitMaskRepeat: 'repeat',
    };
  }

  function systemTree() {
    const builtin = getWallpaperItems().filter((x) => x.builtin);
    const engines = builtin.filter((x) => x.kind === WALL_KIND.ENGINE);
    const packs = builtin.filter((x) => x.kind === WALL_KIND.WEB);
    const images = builtin.filter((x) => x.kind === WALL_KIND.IMAGE);
    const videos = builtin.filter((x) => x.kind === WALL_KIND.VIDEO);
    const textures = getTextureItems();

    const textureGrid = textures.length
      ? h('div', { class: 'wc-tex-grid' }, textures.map((tex) => h('button', {
        key: tex.name,
        class: `wc-tex-thumb${(getSelectedTexture(target.value, tier.value) || {}).name === tex.name ? ' active' : ''}`,
        type: 'button',
        dataset: { tip: `${tex.name} · ${tex.w}×${tex.h}` },
        onClick: () => {
          if (isBootTarget()) { /* 启动页同样支持纹理 */ }
          selectTexture(tex.name, target.value, tier.value);
          applyAndNote(`texture ${tex.name}`);
          rev.next += 1;
        },
      }, [h('span', { class: 'wc-tex-inner', style: textureSwatch(tex) })])))
      : emptyState(t('app.wallpapercat.empty-texture'));

    const engineGrid = engines.length
      ? h('div', { class: 'wc-grid wc-grid-engine' }, engines.map((item) => {
        const on = getSelectedWallpaperId(target.value, tier.value) === item.id;
        return h('div', { key: item.id, class: 'wc-item' }, [
          h('button', {
            class: `wc-thumb wc-thumb-plain wc-thumb-engine${on ? ' active' : ''}`,
            type: 'button',
            dataset: { tip: wallTitle(item) },
            onClick: () => pickItem(item),
          }, [
            h('span', { class: 'wc-thumb-ic', html: icon('sparkles', 'qicon') }),
            h('span', { class: 'wc-thumb-tags' }, itemBadges(item)),
          ]),
          h('div', { class: 'wc-meta' }, [
            h('span', { class: 'wc-name', text: wallTitle(item), title: wallTitle(item) }),
            h('span', { class: 'wc-sub', text: item.descKey ? t(item.descKey) : '' }),
          ]),
        ]);
      }))
      : emptyState(t('app.wallpapercat.empty-builtin'));

    return [
      card(t('app.wallpapercat.system-title'), [
        targetBar(),
        tierBar(),
        h('p', { class: 'wc-note', text: t('app.wallpapercat.system-hint') }),
        images.length || videos.length || packs.length
          ? h('div', { class: 'wc-section' }, [sectionTitle(t('app.wallpapercat.section-builtin')), grid([...images, ...videos, ...packs])])
          : null,
        h('div', { class: 'wc-section' }, [
          sectionTitle(t('app.wallpapercat.section-engines')),
          h('p', { class: 'wc-note', text: t('app.wallpapercat.engines-hint') }),
          engineGrid,
        ]),
        h('div', { class: 'wc-section' }, [
          sectionTitle(t('app.wallpapercat.section-textures')),
          textureGrid,
        ]),
      ]),
    ];
  }

  // ---------- 外观 ----------

  function previewStyle() {
    const mode = getMode(target.value, tier.value);
    if (mode === 'color') return { backgroundColor: liveColor.value || getColorWallpaper(target.value, tier.value) };
    if (mode === 'texture') return textureSwatch(getSelectedTexture(target.value, tier.value));
    const item = getSelectedWallpaperItem(target.value, tier.value);
    if (item && item.kind === WALL_KIND.IMAGE && item.url) {
      return { backgroundImage: `url("${item.url}")`, ...wallpaperFitStyle(getWallpaperFit(target.value, tier.value)) };
    }
    return { backgroundColor: 'var(--muted)' };
  }

  function lookTree() {
    const mode = getMode(target.value, tier.value);
    const item = getSelectedWallpaperItem(target.value, tier.value);
    const currentColor = getColorWallpaper(target.value, tier.value);
    const texName = (getSelectedTexture(target.value, tier.value) || {}).name || '';

    const chips = chipGroup([
      { id: 'image', label: t('app.wallpapercat.kind-image'), icon: 'image' },
      { id: 'color', label: t('app.wallpapercat.kind-color'), icon: 'sun' },
      { id: 'texture', label: t('app.wallpapercat.kind-texture'), icon: 'layers' },
      { id: 'dynamic', label: t('app.wallpapercat.kind-dynamic'), icon: 'play' },
    ], mode === 'image' ? 'image' : mode === 'color' ? 'color' : mode === 'texture' ? 'texture' : 'dynamic', (id) => {
      if (id === 'image') {
        resetWallpaper(target.value, tier.value);
        applyAndNote('reset');
        toast(t('app.wallpapercat.reset-done'), 'success');
      } else if (id === 'color') {
        setColorWallpaper(liveColor.value || currentColor, target.value, tier.value);
        applyAndNote(`color ${currentColor}`);
      } else if (id === 'texture') {
        if (!getTextureItems().length) { toast(t('app.wallpapercat.empty-texture'), 'warning'); return; }
        const cur = getSelectedTexture(target.value, tier.value) || getTextureItems()[0];
        selectTexture(cur.name, target.value, tier.value);
        applyAndNote(`texture ${cur.name}`);
      } else {
        if (isBootTarget()) { toast(t('app.wallpapercat.boot-only-static'), 'warning'); return; }
        if (item && (item.kind === WALL_KIND.VIDEO || item.kind === WALL_KIND.WEB || item.kind === WALL_KIND.ENGINE)) {
          pickItem(item);
        } else {
          const firstEngine = getWallpaperItems().find((x) => x.kind === WALL_KIND.ENGINE);
          const firstVideo = getWallpaperItems().find((x) => x.kind === WALL_KIND.VIDEO);
          const pick = firstEngine || firstVideo;
          if (!pick) { toast(t('app.wallpapercat.no-dynamic'), 'warning'); return; }
          pickItem(pick);
        }
      }
      rev.next += 1;
    }, { cls: 'wc-chips' });

    const colorInput = h('input', {
      type: 'color',
      value: currentColor,
      class: 'wc-color-native',
      onInput: (ev) => {
        setColorWallpaper(ev.target.value, target.value, tier.value);
        liveColor.next = ev.target.value;
        push();
      },
      onChange: (ev) => { note(`color ${ev.target.value}`); liveColor.next = ''; },
    });

    const presets = h('div', { class: 'wc-color-presets' }, [
      ...PRESET_COLORS.map((c) => h('button', {
        key: c,
        class: `wc-color-dot${mode === 'color' && currentColor === c ? ' active' : ''}`,
        type: 'button',
        style: { backgroundColor: c },
        dataset: { tip: c },
        onClick: () => {
          setColorWallpaper(c, target.value, tier.value);
          applyAndNote(`color ${c}`);
          rev.next += 1;
        },
      })),
      h('div', { class: 'wc-color-custom' }, [colorInput, h('span', { text: t('app.wallpapercat.color-custom') })]),
    ]);

    const fitChips = (mode === 'image' || mode === 'video' || mode === 'web' || mode === 'engine')
      ? chipGroup([
        { id: 'cover', label: t('app.wallpapercat.fit-cover') },
        { id: 'contain', label: t('app.wallpapercat.fit-contain') },
        { id: 'fill', label: t('app.wallpapercat.fit-fill') },
        { id: 'center', label: t('app.wallpapercat.fit-center') },
      ], getWallpaperFit(target.value, tier.value), (id) => {
        setWallpaperFit(id, target.value, tier.value);
        applyAndNote(`fit ${id}`);
        rev.next += 1;
      }, { cls: 'wc-chips' })
      : null;

    const texBase = getTextureBase(target.value, tier.value);
    const texLine = getTextureLine(target.value, tier.value);
    const texA = getTextureAlpha(target.value, tier.value);
    const texDensity = getTextureDensity(target.value, tier.value);

    const colorField = (label, field, value) => h('div', { class: 'wc-field' }, [
      h('span', { class: 'wc-field-label', text: label }),
      h('input', {
        type: 'color',
        value,
        class: 'wc-color-native',
        'aria-label': label,
        onInput: (ev) => {
          setTextureColors({ [field]: ev.target.value }, target.value, tier.value);
          push();
        },
        onChange: (ev) => note(`${label} ${ev.target.value}`),
      }),
    ]);

    const textureSection = mode === 'texture'
      ? h('div', { class: 'wc-section' }, [
        sectionTitle(tf('app.wallpapercat.texture-pick', { v1: getTextureItems().length })),
        h('div', { class: 'wc-tex-grid' }, getTextureItems().map((tex) => h('button', {
          key: tex.name,
          class: `wc-tex-thumb${texName === tex.name ? ' active' : ''}`,
          type: 'button',
          dataset: { tip: tex.name },
          onClick: () => {
            selectTexture(tex.name, target.value, tier.value);
            applyAndNote(`texture ${tex.name}`);
            rev.next += 1;
          },
        }, [h('span', { class: 'wc-tex-inner', style: textureSwatch(tex) })]))),
        h('div', { class: 'wc-fields' }, [
          colorField(t('app.wallpapercat.tex-bg'), 'base', texBase),
          colorField(t('app.wallpapercat.tex-line'), 'line', texLine),
        ]),
        h('div', { class: 'wc-field wc-field-col' }, [
          h('span', { class: 'wc-field-label', text: `${t('app.wallpapercat.tex-opacity')} · ${(texA * 100).toFixed(0)}%` }),
          h('input', {
            class: 'wc-range', type: 'range',
            min: String(TEX_ALPHA_MIN), max: String(TEX_ALPHA_MAX), step: '0.01',
            value: String(texA),
            onInput: (ev) => { setTextureColors({ alpha: Number(ev.target.value) }, target.value, tier.value); push(); },
            onChange: (ev) => note(`alpha ${ev.target.value}`),
          }),
        ]),
        h('div', { class: 'wc-field wc-field-col' }, [
          h('span', { class: 'wc-field-label', text: `${t('app.wallpapercat.tex-density')} · ${texDensity.toFixed(2)}` }),
          h('input', {
            class: 'wc-range', type: 'range',
            min: String(TEX_DENSITY_MIN), max: String(TEX_DENSITY_MAX), step: '0.05',
            value: String(texDensity),
            onInput: (ev) => { setTextureDensity(Number(ev.target.value), target.value, tier.value); push(); },
            onChange: (ev) => note(`density ${ev.target.value}`),
          }),
        ]),
      ])
      : null;

    const currentDesc = (() => {
      if (mode === 'color') return t('app.wallpapercat.kind-color');
      if (mode === 'texture') return texName ? `${t('app.wallpapercat.kind-texture')} · ${texName}` : t('app.wallpapercat.kind-texture');
      if (!item) return t('app.wallpapercat.none-selected');
      return wallTitle(item);
    })();

    return [
      card(t('app.wallpapercat.look-title'), [
        targetBar(),
        tierBar(),
        chips,
        isBootTarget() ? h('p', { class: 'wc-note', text: t('app.wallpapercat.boot-only-static') }) : null,
        mode === 'color' ? h('div', { class: 'wc-section' }, [sectionTitle(t('app.wallpapercat.color-title')), presets]) : null,
        textureSection,
        fitChips ? h('div', { class: 'wc-section' }, [sectionTitle(t('app.wallpapercat.field-fit')), fitChips]) : null,
        h('div', { class: 'wc-section' }, [
          sectionTitle(t('app.wallpapercat.preview')),
          h('div', { class: 'wc-preview', style: previewStyle() }),
          h('p', { class: 'wc-note', text: currentDesc }),
        ]),
        h('div', { class: 'wc-actions' }, [
          h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            html: `${icon('refresh', 'qicon qicon-sm')}<span>${t('app.wallpapercat.action-reload')}</span>`,
            onClick: async () => {
              try {
                await reload(true);
                push();
                toast(t('app.wallpapercat.reloaded'), 'success');
              } catch (err) {
                toast(t('app.wallpapercat.reload-failed') + (err.message || err), 'error');
              }
            },
          }),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            html: `${icon('trash-2', 'qicon qicon-sm')}<span>${t('app.wallpapercat.action-reset')}</span>`,
            onClick: () => {
              resetWallpaper(target.value, tier.value);
              applyAndNote('reset');
              rev.next += 1;
              toast(t('app.wallpapercat.reset-done'), 'success');
            },
          }),
        ]),
      ]),
    ];
  }

  // ---------- 播放与轮播 ----------

  function toggleRow(label, checked, onChange, hint) {
    return h('label', { class: 'wc-switch' }, [
      h('input', {
        type: 'checkbox',
        ref: (el) => { if (el) el.checked = checked; },
        onChange: (ev) => onChange(ev.target.checked),
      }),
      h('span', { class: 'wc-switch-main' }, [
        h('span', { class: 'wc-switch-label', text: label }),
        hint ? h('span', { class: 'wc-switch-hint', text: hint }) : null,
      ].filter(Boolean)),
    ]);
  }

  function rangeRow(label, value, min, max, step, onInput, onDone, format) {
    const shown = format ? format(value) : String(value);
    return h('div', { class: 'wc-field wc-field-col' }, [
      h('span', { class: 'wc-field-label', text: `${label} · ${shown}` }),
      h('input', {
        class: 'wc-range', type: 'range',
        min: String(min), max: String(max), step: String(step),
        value: String(value),
        onInput: (ev) => { onInput(Number(ev.target.value)); push(); },
        onChange: (ev) => { if (onDone) onDone(Number(ev.target.value)); },
      }),
    ]);
  }

  function playTree() {
    const vid = getVideoOptions(target.value, tier.value);
    const web = getWebOptions(target.value, tier.value);
    const eng = getEngineOptions(target.value, tier.value);
    const rot = getRotation();
    const candidates = rotationCandidates();
    const poolIds = rot.pool.length ? rot.pool : candidates.map((x) => x.id);

    const videoCard = card(t('app.wallpapercat.video-title'), [
      toggleRow(t('app.wallpapercat.video-audio'), vid.audio, (v) => { setVideoOption('audio', v, target.value, tier.value); note(`audio ${v}`); rev.next += 1; },
        t('app.wallpapercat.video-audio-hint')),
      rangeRow(t('app.wallpapercat.video-volume'), Math.round(vid.volume * 100), 0, 100, 1,
        (v) => setVideoOption('volume', v / 100, target.value, tier.value),
        (v) => note(`volume ${v}`), (v) => `${Math.round(v)}%`),
      rangeRow(t('app.wallpapercat.video-rate'), vid.rate, 0.25, 2, 0.05,
        (v) => setVideoOption('rate', v, target.value, tier.value),
        (v) => note(`rate ${v}`), (v) => `${v.toFixed(2)}×`),
      toggleRow(t('app.wallpapercat.video-loop'), vid.loop, (v) => { setVideoOption('loop', v, target.value, tier.value); rev.next += 1; }),
      toggleRow(t('app.wallpapercat.video-pause-hidden'), vid.pauseHidden, (v) => { setVideoOption('pauseHidden', v, target.value, tier.value); rev.next += 1; },
        t('app.wallpapercat.video-pause-hidden-hint')),
    ]);

    const webCard = card(t('app.wallpapercat.web-title'), [
      toggleRow(t('app.wallpapercat.web-interact'), web.interact, (v) => { setWebOption('interact', v, target.value, tier.value); rev.next += 1; },
        t('app.wallpapercat.web-interact-hint')),
      toggleRow(t('app.wallpapercat.web-capture'), web.capture, (v) => { setWebOption('capture', v, target.value, tier.value); rev.next += 1; },
        t('app.wallpapercat.web-capture-hint')),
      h('p', { class: 'wc-note', text: t('app.wallpapercat.web-note') }),
      h('p', { class: 'wc-note wc-note-dim', text: t('app.wallpapercat.web-protocol') }),
    ]);

    const engineCard = card(t('app.wallpapercat.engine-title'), [
      rangeRow(t('app.wallpapercat.engine-speed'), eng.speed, 0.2, 3, 0.1,
        (v) => setEngineSpeed(v, target.value, tier.value),
        (v) => note(`speed ${v}`), (v) => `${v.toFixed(1)}×`),
      h('p', { class: 'wc-note', text: t('app.wallpapercat.engine-hint') }),
    ]);

    const poolRows = candidates.length
      ? candidates.map((item) => h('label', { key: item.id, class: 'wc-switch' }, [
        h('input', {
          type: 'checkbox',
          ref: (el) => { if (el) el.checked = poolIds.includes(item.id); },
          onChange: (ev) => {
            const set = new Set(poolIds);
            if (ev.target.checked) set.add(item.id); else set.delete(item.id);
            setRotation({ pool: [...set] });
            rev.next += 1;
          },
        }),
        h('span', { class: 'wc-switch-main' }, [
          h('span', { class: 'wc-switch-label', text: wallTitle(item) }),
          h('span', { class: 'wc-switch-hint', text: item.kind === WALL_KIND.VIDEO ? t('app.wallpapercat.badge-video')
            : item.kind === WALL_KIND.WEB ? t('app.wallpapercat.badge-web')
              : item.kind === WALL_KIND.ENGINE ? t('app.wallpapercat.badge-engine') : t('app.wallpapercat.badge-image') }),
        ]),
      ]))
      : [emptyState(t('app.wallpapercat.rotate-none'))];

    const rotateCard = card(t('app.wallpapercat.rotate-title'), [
      toggleRow(t('app.wallpapercat.rotate-on'), rot.on, (v) => { setRotation({ on: v }); note(`rotate ${v}`); rev.next += 1; },
        t('app.wallpapercat.rotate-on-hint')),
      rangeRow(t('app.wallpapercat.rotate-interval'), rot.seconds, 10, 3600, 10,
        (v) => setRotation({ seconds: v }),
        (v) => note(`rotate ${v}s`), (v) => `${Math.round(v)}s`),
      toggleRow(t('app.wallpapercat.rotate-shuffle'), rot.shuffle, (v) => { setRotation({ shuffle: v }); rev.next += 1; }),
      sectionTitle(tf('app.wallpapercat.rotate-pool', { v1: poolIds.length })),
      h('p', { class: 'wc-note', text: t('app.wallpapercat.rotate-pool-hint') }),
      h('div', { class: 'wc-pool' }, poolRows),
    ]);

    return [videoCard, webCard, engineCard, rotateCard];
  }

  // ---------- 根视图 ----------

  const contentByTab = { mine: mineTree, system: systemTree, look: lookTree, play: playTree };

  function rootTree() {
    lang();
    void rev.value;
    const body = loaded.value ? contentByTab[tab.value]() : [spinner(t('app.wallpapercat.loading'))];
    const sidebar = h('aside', { class: 'cmp-sidebar' }, sidebarSections([
      { items: TABS.map((x) => ({ id: x.id, label: t(x.key), icon: x.icon })) },
    ], tab.value, (id) => { tab.next = id; }));
    const nodes = (Array.isArray(body) ? body : [body]).filter(Boolean);
    return h('div', { class: 'app-wc' }, [
      sidebar,
      h('div', { class: 'wc-content' }, [
        h('div', { class: 'wc-content-head' }, [
          h('span', { class: 'wc-title', text: t('app.wallpapercat.name') }),
          h('span', { class: 'wc-sub', text: t('app.wallpapercat.head-sub') }),
        ]),
        h('div', { class: 'wc-content-scroll' }, [
          h('div', { class: 'wc-stack' }, nodes),
        ]),
      ]),
    ]);
  }

  const view = createView(el);
  view.update(rootTree);

  reload(false).catch(() => { loaded.next = true; });

  return () => { view.unmount(); };
}

setupI18n(new URL('./language', import.meta.url).href, {
  languages: ['zh-CN', 'en-US'],
}).catch(() => { }).then(() => {
  bootApp(({ root }) => boot(root));
});
