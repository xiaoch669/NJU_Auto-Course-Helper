// ==UserScript==
// @name         南大研究生新生课程助手
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  真后台播放：原生/Video.js 双拦截 + 可选静音自启 + 自动下一节 + DOM 复,代码完全由GPT5生成。
// @author       xiaoch669
// @match        https://*.lms.nju.edu.cn/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const log = (...a) => console.log('[TM-课程助手]', ...a);
  const warn = (...a) => console.warn('[TM-课程助手]', ...a);

  // ---------------- 1) 伪装前台 + 阻断事件（尽早执行） ----------------
  (function spoofVisibility() {
    try {
      const define = (proto, key, val) => {
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc || desc.configurable) {
          Object.defineProperty(proto, key, { get: () => val, configurable: true });
        } else {
          Object.defineProperty(document, key, { get: () => val });
        }
      };
      define(Document.prototype, 'hidden', false);
      define(Document.prototype, 'visibilityState', 'visible');
      document.hasFocus = () => true;

      const stop = e => e.stopImmediatePropagation();
      ['visibilitychange', 'webkitvisibilitychange', 'blur', 'focus', 'pagehide', 'freeze']
        .forEach(ev => {
          window.addEventListener(ev, stop, true);
          document.addEventListener(ev, stop, true);
        });
      log('前台伪装/事件阻断已启用');
    } catch (e) {
      warn('前台伪装失败', e);
    }
  })();

  // ---------------- 2) 劫持原生媒体 API（在库挂钩之前） ----------------
  let userGesture = false;
  window.addEventListener('pointerdown', () => userGesture = true, true);
  window.addEventListener('keydown',   () => userGesture = true, true);

  (function hijackNativeMedia() {
    const proto = HTMLMediaElement.prototype;
    const _pause = proto.pause;
    const _play  = proto.play;

    proto.pause = function (...args) {
      // 后台强制暂停 → 拦截
      if (document.hidden && !userGesture) {
        log('拦截原生 pause 于后台', this);
        return;
      }
      return _pause.apply(this, args);
    };

    proto.play = function (...args) {
      const p = _play.apply(this, args);
      if (p && typeof p.catch === 'function') {
        p.catch(err => {
          // Autoplay 策略：先静音再自启
          if (err && err.name === 'NotAllowedError') {
            warn('play() 被策略阻止，尝试静音自启');
            this.muted = true; this.setAttribute('muted', '');
            _play.call(this).catch(() => { /* 可能仍需用户点击 */ });
            needUserClickOverlay();
          } else {
            warn('play() 失败:', err && err.name || err);
          }
        });
      }
      return p;
    };
    log('原生 HTMLMediaElement.pause/play 已劫持');
  })();

  // ---------------- 3) Video.js 层拦截（若存在） ----------------
  (function hijackVideoJS() {
    const tryHook = () => {
      if (typeof window.videojs !== 'undefined') {
        // 请求实例的方式不一，统一拦截原型更稳妥
        const vjs = window.videojs;
        if (vjs && vjs.Player && vjs.Player.prototype) {
          const p = vjs.Player.prototype;
          if (!p.__tm_patched) {
            p.__tm_patched = true;
            const _pp = p.pause;
            p.pause = function (...args) {
              if (document.hidden && !userGesture) {
                log('拦截 Video.js pause 于后台', this);
                return;
              }
              return _pp.apply(this, args);
            };
            log('Video.js Player.pause 已劫持');
          }
        }
      }
    };
    // 多次尝试，兼容后载入
    const t = setInterval(() => { tryHook(); }, 300);
    setTimeout(() => clearInterval(t), 10000);
  })();

  // ---------------- 4) 发现/绑定视频 + 自动化 ----------------
  const bindVideo = (video) => {
    if (!video || video.dataset.tmBound) return;
    video.dataset.tmBound = '1';

    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'auto';

    // 后台被 pause 时，尝试立即恢复
    const onPause = () => {
      if (document.hidden && !userGesture) {
        log('收到 pause 事件（后台），尝试恢复播放');
        video.play().catch(() => {});
      }
    };
    video.addEventListener('pause', onPause, true);

    // 元数据就绪即尝试启动（静音策略优先）
    const attemptAutoplay = () => {
      if (!video) return;
      const tryPlay = () => video.play().catch(() => {});
      // 优先静音自启，降低策略阻挡概率
      if (!userGesture) {
        video.muted = true; video.setAttribute('muted', '');
      }
      tryPlay();
    };
    if (video.readyState > 0) attemptAutoplay();
    else video.addEventListener('loadedmetadata', attemptAutoplay, { once: true });

    // 播放结束 → 自动点击“下一个”
    video.addEventListener('ended', () => {
      log('视频结束，尝试下一节');
      flashTitle('【▶ 播放结束，正在切换下一节】');
      clickNext();
    });

    log('已绑定视频元素', video);
  };

  // 初始扫描 + 监听后续视频
  const scan = () => document.querySelectorAll('video').forEach(bindVideo);
  new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan, { once: true });
  } else {
    scan();
  }

  // ---------------- 5) UI 与工具 ----------------
  let overlayShown = false;
  function needUserClickOverlay() {
    if (overlayShown) return;
    overlayShown = true;
    const btn = document.createElement('div');
    btn.id = 'tm-play-overlay';
    btn.textContent = '▶️ 点击授权播放（解除浏览器限制）';
    btn.addEventListener('click', () => {
      try {
        // 尝试激活音频上下文，增强后台保活
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          ctx.resume && ctx.resume();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0; // 静音
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          log('后台保活音频已启动');
        }
      } catch (e) {
        warn('启动后台保活失败', e);
      }
      userGesture = true; // 已有用户手势
      btn.remove();
      overlayShown = false;

      // 让当前视频“带声”恢复（如你需要）
      const v = document.querySelector('video');
      if (v) {
        v.muted = false; v.removeAttribute('muted');
        v.play().catch(() => {});
      }
    });
    document.documentElement.appendChild(btn);
  }

  function clickNext() {
    // 1) 明文按钮
    const textMatch = Array.from(document.querySelectorAll('button, a, span'))
      .find(el => /下一个|下一节|下一页|下一项/.test(el.textContent || ''));
    if (textMatch) { textMatch.click(); return true; }

    // 2) 常见播放器“下一集”按钮
    const candidates = [
      '.vjs-next-control', '.next', '[aria-label="Next"]', '.ant-pagination-next', '.next-btn'
    ].join(',');
    const el = document.querySelector(candidates);
    if (el) { el.click(); return true; }

    return false;
  }

  let flasher;
  const originalTitle = document.title;
  function flashTitle(msg) {
    clearInterval(flasher);
    let on = false;
    flasher = setInterval(() => {
      document.title = on ? msg : originalTitle;
      on = !on;
    }, 800);
    setTimeout(() => { clearInterval(flasher); document.title = originalTitle; }, 8000);
  }

  GM_addStyle(`
    #tm-play-overlay {
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,.5); color: #fff; font-size: 20px; z-index: 2147483647;
      cursor: pointer; user-select: none; backdrop-filter: blur(1px);
    }
  `);

  log('脚本已加载（document-start），等待视频出现并自动接管');
})();
