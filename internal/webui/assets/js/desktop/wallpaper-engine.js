/**
 * desktop/wallpaper-engine.js —— 内置交互壁纸引擎
 *
 * 要点：引擎在宿主页面里直接画 canvas，所以能拿到真实指针、随主题换色，
 * 又不会和桌面图标抢点击（canvas 本身 pointer-events: none，指针来自桌面层广播）。
 *
 * 每个引擎只需实现 create(env) 并返回：
 *   draw(dt, time)        每帧调用，dt 为秒、time 为累计秒
 *   pointer(x, y, down)   指针位置（相对 canvas 的 CSS 像素）与是否按下
 *   resize(w, h, dpr)     尺寸变化
 *   destroy()             可选的清理
 *
 * 颜色一律从 env.palette 取，切换主题时由宿主重建引擎，引擎自己不必关心主题。
 */

const engines = new Map();

/** 注册一个内置交互壁纸引擎 */
export function defineWallEngine(def) {
  if (!def || !def.id || typeof def.create !== 'function') {
    throw new Error('defineWallEngine: 需要 id 与 create');
  }
  engines.set(def.id, def);
  return def.id;
}

/** 列出全部内置引擎（按注册顺序） */
export function listWallEngines() {
  return [...engines.values()];
}

/** 按 id 取引擎 */
export function getWallEngine(id) {
  return engines.get(String(id || '')) || null;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// 猫爪/星尘：一群粒子被指针吸引，按下时炸开，暗色偏星光、亮色偏墨点。
defineWallEngine({
  id: 'stardust',
  nameKey: 'app.wallpapercat.engine.stardust',
  descKey: 'app.wallpapercat.engine.stardust.desc',
  audio: false,
  interactive: true,
  create(env) {
    const { ctx } = env;
    let w = env.w;
    let h = env.h;
    let dpr = env.dpr;
    let parts = [];
    let px = -9999;
    let py = -9999;
    let down = false;
    let burst = 0;

    const palette = () => (env.dark
      ? ['rgba(255,255,255,', 'rgba(160,200,255,', 'rgba(120,255,220,']
      : ['rgba(30,40,70,', 'rgba(60,90,160,', 'rgba(20,120,110,']);

    function spawn(n, x, y) {
      const cols = palette();
      for (let i = 0; i < n; i++) {
        parts.push({
          x: x ?? rand(0, w),
          y: y ?? rand(0, h),
          vx: rand(-8, 8),
          vy: rand(-8, 8),
          r: rand(0.6, 2.4),
          c: cols[(Math.random() * cols.length) | 0],
          a: rand(0.25, 0.85),
        });
      }
    }

    function target() {
      return Math.max(90, Math.min(420, Math.round((w * h) / 14000)));
    }

    spawn(target());
    if (w * h > 1600000) spawn(80);

    return {
      resize(nw, nh, ndpr) {
        w = nw;
        h = nh;
        dpr = ndpr;
        if (parts.length > target() * 1.6) parts = parts.slice(0, target());
        while (parts.length < target()) spawn(1);
      },
      pointer(x, y, isDown) {
        if (isDown && !down) burst = 1;
        down = isDown;
        px = x;
        py = y;
      },
      draw(dt) {
        const step = Math.min(dt, 0.05);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const pull = down ? 260 : 90;
        const radius = down ? 320 : 200;
        for (const p of parts) {
          const dx = px - p.x;
          const dy = py - p.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < radius * radius && d2 > 1) {
            const d = Math.sqrt(d2);
            const f = (1 - d / radius) * pull;
            p.vx += (dx / d) * f * step;
            p.vy += (dy / d) * f * step;
          }
          if (burst > 0) {
            p.vx += rand(-260, 260) * step * burst;
            p.vy += rand(-260, 260) * step * burst;
          }
          p.vx *= 0.985;
          p.vy *= 0.985;
          p.x += p.vx * step;
          p.y += p.vy * step;
          if (p.x < -20) p.x = w + 20;
          if (p.x > w + 20) p.x = -20;
          if (p.y < -20) p.y = h + 20;
          if (p.y > h + 20) p.y = -20;
          ctx.beginPath();
          ctx.fillStyle = p.c + p.a.toFixed(3) + ')';
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
        if (burst > 0) burst = Math.max(0, burst - step * 2.2);
      },
      destroy() {
        parts = [];
      },
    };
  },
});

// 极光：几层错相位的正弦带叠出流动感，指针靠近时局部提亮。
defineWallEngine({
  id: 'aurora',
  nameKey: 'app.wallpapercat.engine.aurora',
  descKey: 'app.wallpapercat.engine.aurora.desc',
  audio: false,
  interactive: true,
  create(env) {
    const { ctx } = env;
    let w = env.w;
    let h = env.h;
    let dpr = env.dpr;
    let px = 0.5;
    let py = 0.5;
    let push = 0;

    const bands = [
      { speed: 0.11, amp: 0.16, freq: 1.7, hue: 0, alpha: 0.5 },
      { speed: 0.17, amp: 0.11, freq: 2.4, hue: 1, alpha: 0.42 },
      { speed: 0.07, amp: 0.21, freq: 1.2, hue: 2, alpha: 0.32 },
    ];

    return {
      resize(nw, nh, ndpr) { w = nw; h = nh; dpr = ndpr; },
      pointer(x, y) {
        px = Math.max(0, Math.min(1, x / Math.max(1, w)));
        py = Math.max(0, Math.min(1, y / Math.max(1, h)));
        push = 1;
      },
      draw(dt, time) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const cols = env.dark
          ? ['rgba(80,220,190,', 'rgba(90,150,255,', 'rgba(190,120,255,']
          : ['rgba(30,150,140,', 'rgba(60,110,200,', 'rgba(140,80,190,'];
        push = Math.max(0, push - dt * 0.6);
        const lift = push * 0.12 * (0.5 + py);
        for (let i = 0; i < bands.length; i++) {
          const b = bands[i];
          const baseY = h * (0.34 + i * 0.2) - lift * h;
          const grad = ctx.createLinearGradient(0, baseY - h * 0.3, 0, baseY + h * 0.3);
          grad.addColorStop(0, cols[b.hue] + '0)');
          grad.addColorStop(0.5, cols[b.hue] + b.alpha.toFixed(2) + ')');
          grad.addColorStop(1, cols[b.hue] + '0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(0, h);
          const steps = 48;
          for (let s = 0; s <= steps; s++) {
            const t2 = s / steps;
            const wave = Math.sin(t2 * Math.PI * 2 * b.freq + time * b.speed * Math.PI * 2 + i * 1.7)
              + 0.45 * Math.sin(t2 * Math.PI * 5.3 - time * b.speed * 3.1 + i);
            const sway = (px - 0.5) * 0.1 * Math.sin(t2 * Math.PI);
            const y = baseY + wave * h * b.amp + sway * h;
            ctx.lineTo(t2 * w, y);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fill();
        }
      },
      destroy() {},
    };
  },
});

// 雨窗：斜雨丝与缓慢下滑的水珠，指针经过留下涟漪。
defineWallEngine({
  id: 'rain',
  nameKey: 'app.wallpapercat.engine.rain',
  descKey: 'app.wallpapercat.engine.rain.desc',
  audio: false,
  interactive: true,
  create(env) {
    const { ctx } = env;
    let w = env.w;
    let h = env.h;
    let dpr = env.dpr;
    let drops = [];
    let ripples = [];
    let px = -9999;
    let py = -9999;

    function makeDrop() {
      return { x: rand(-w * 0.2, w), y: rand(-h, h), len: rand(8, 26), sp: rand(220, 520), a: rand(0.08, 0.28) };
    }

    function fill() {
      const n = Math.max(40, Math.min(260, Math.round((w * h) / 14000)));
      drops = [];
      for (let i = 0; i < n; i++) drops.push(makeDrop());
    }
    fill();

    return {
      resize(nw, nh, ndpr) { w = nw; h = nh; dpr = ndpr; fill(); },
      pointer(x, y) {
        px = x;
        py = y;
        if (ripples.length < 24) ripples.push({ x, y, r: 2, a: 0.5 });
      },
      draw(dt) {
        const step = Math.min(dt, 0.05);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const stroke = env.dark ? 'rgba(200,220,255,' : 'rgba(40,60,90,';
        ctx.lineWidth = 1;
        for (const d of drops) {
          d.y += d.sp * step;
          d.x += d.sp * step * 0.18;
          if (d.y > h + 40) {
            d.y = rand(-60, -10);
            d.x = rand(-w * 0.2, w);
          }
          ctx.strokeStyle = stroke + d.a.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - d.len * 0.18, d.y - d.len);
          ctx.stroke();
        }
        for (let i = ripples.length - 1; i >= 0; i--) {
          const r = ripples[i];
          r.r += 70 * step;
          r.a -= step * 0.55;
          if (r.a <= 0) { ripples.splice(i, 1); continue; }
          ctx.strokeStyle = stroke + r.a.toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (px > -9000) {
          const glow = ctx.createRadialGradient(px, py, 0, px, py, 140);
          const c = env.dark ? 'rgba(150,190,255,' : 'rgba(80,120,190,';
          glow.addColorStop(0, c + '0.16)');
          glow.addColorStop(1, c + '0)');
          ctx.fillStyle = glow;
          ctx.fillRect(px - 140, py - 140, 280, 280);
        }
      },
      destroy() { drops = []; ripples = []; },
    };
  },
});

// 星轨：同心的光点在椭圆轨道上绕行，指针位置把中心拉过去。
defineWallEngine({
  id: 'orbit',
  nameKey: 'app.wallpapercat.engine.orbit',
  descKey: 'app.wallpapercat.engine.orbit.desc',
  audio: false,
  interactive: true,
  create(env) {
    const { ctx } = env;
    let w = env.w;
    let h = env.h;
    let dpr = env.dpr;
    let cx = 0.5;
    let cy = 0.5;
    let tx = 0.5;
    let ty = 0.5;

    const rings = [
      { n: 7, r: 0.16, sp: 0.22, size: 1.6 },
      { n: 11, r: 0.24, sp: -0.16, size: 1.3 },
      { n: 16, r: 0.33, sp: 0.1, size: 1.05 },
      { n: 22, r: 0.43, sp: -0.07, size: 0.85 },
    ];

    return {
      resize(nw, nh, ndpr) { w = nw; h = nh; dpr = ndpr; },
      pointer(x, y) {
        tx = Math.max(0.12, Math.min(0.88, x / Math.max(1, w)));
        ty = Math.max(0.12, Math.min(0.88, y / Math.max(1, h)));
      },
      draw(dt, time) {
        const step = Math.min(dt, 0.05);
        cx += (tx - cx) * Math.min(1, step * 2.4);
        cy += (ty - cy) * Math.min(1, step * 2.4);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const min = Math.min(w, h);
        const baseX = cx * w;
        const baseY = cy * h;
        const col = env.dark ? '200,220,255' : '40,60,100';
        for (let i = 0; i < rings.length; i++) {
          const ring = rings[i];
          ctx.strokeStyle = `rgba(${col},0.06)`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(baseX, baseY, min * ring.r, min * ring.r * 0.62, 0, 0, Math.PI * 2);
          ctx.stroke();
          for (let k = 0; k < ring.n; k++) {
            const ang = time * ring.sp + (k / ring.n) * Math.PI * 2 + i * 0.9;
            const x = baseX + Math.cos(ang) * min * ring.r;
            const y = baseY + Math.sin(ang) * min * ring.r * 0.62;
            const a = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(ang * 2 + i));
            ctx.fillStyle = `rgba(${col},${a.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, ring.size, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        const glow = ctx.createRadialGradient(baseX, baseY, 0, baseX, baseY, min * 0.3);
        glow.addColorStop(0, env.dark ? 'rgba(140,180,255,0.16)' : 'rgba(90,120,200,0.12)');
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
      },
      destroy() {},
    };
  },
});
