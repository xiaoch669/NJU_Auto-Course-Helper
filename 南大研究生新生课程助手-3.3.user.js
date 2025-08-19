// ==UserScript==
// @name         南大研究生新生课程助手
// @namespace    http://tampermonkey.net/
// @version      3.3
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

  // ---------- 可配置项 ----------
  const DEFAULT_PLAYBACK_RATE = 2; // <- 默认播放速率（修改为 1.5、2 等）
  // --------------------------------

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

  // ---------------- 2) 用户手势检测 ----------------
  let userGesture = false;
  window.addEventListener('pointerdown', () => userGesture = true, true);
  window.addEventListener('keydown',   () => userGesture = true, true);

  // ---------------- 3) 劫持原生媒体 API（在库挂钩之前） ----------------
  (function hijackNativeMedia() {
    try {
      const proto = HTMLMediaElement.prototype;
      const _pause = proto.pause;
      const _play  = proto.play;

      proto.pause = function (...args) {
        if (document.hidden && !userGesture) {
          log('拦截原生 pause 于后台', this);
          return;
        }
        return _pause.apply(this, args);
      };

      proto.play = function (...args) {
        // 尝试在 play 前设置默认速率
        try {
          if (typeof DEFAULT_PLAYBACK_RATE === 'number' && this.playbackRate !== DEFAULT_PLAYBACK_RATE) {
            this.playbackRate = DEFAULT_PLAYBACK_RATE;
          }
        } catch (e) { /* 忽略 */ }

        const p = _play.apply(this, args);
        if (p && typeof p.catch === 'function') {
          p.catch(err => {
            if (err && err.name === 'NotAllowedError') {
              warn('play() 被策略阻止，尝试静音自启');
              try { this.muted = true; this.setAttribute('muted', ''); } catch(e){}
              _play.call(this).catch(() => {});
              needUserClickOverlay();
            } else {
              warn('play() 失败:', err && err.name || err);
            }
          });
        }
        return p;
      };

      log('原生 HTMLMediaElement.pause/play 已劫持（含默认速率设置）');
    } catch (e) {
      warn('劫持 HTMLMediaElement 失败', e);
    }
  })();

  // ---------------- 4) Video.js 层拦截（若存在） ----------------
  (function hijackVideoJS() {
    const tryHook = () => {
      try {
        if (typeof window.videojs !== 'undefined') {
          const vjs = window.videojs;
          if (vjs && vjs.Player && vjs.Player.prototype) {
            const p = vjs.Player.prototype;
            if (!p.__tm_patched) {
              p.__tm_patched = true;

              // pause 拦截
              const _pp = p.pause;
              p.pause = function (...args) {
                if (document.hidden && !userGesture) {
                  log('拦截 Video.js pause 于后台', this);
                  return;
                }
                return _pp.apply(this, args);
              };

              // play 拦截：尝试在 video.js 层设置速率
              const _play = p.play;
              p.play = function (...args) {
                try {
                  if (typeof this.playbackRate === 'function') {
                    this.playbackRate(DEFAULT_PLAYBACK_RATE);
                  } else if (this.tech && typeof this.tech === 'function') {
                    const tech = this.tech(true) || (this.tech && this.tech());
                    if (tech && typeof tech.setPlaybackRate === 'function') {
                      tech.setPlaybackRate(DEFAULT_PLAYBACK_RATE);
                    }
                  } else if (this.el_ && this.el_.querySelector) {
                    const v = this.el_.querySelector('video');
                    if (v) v.playbackRate = DEFAULT_PLAYBACK_RATE;
                  }
                } catch (e) { /* 忽略 */ }
                return _play.apply(this, args);
              };

              log('Video.js Player.pause/play 已劫持，并尝试设置默认速率');
            }
          }
        }
      } catch (e) {
        // 若有异常，不影响主流程
      }
    };

    const t = setInterval(() => { tryHook(); }, 300);
    setTimeout(() => clearInterval(t), 10000);
  })();

  // ---------------- 5) 强健的等待与播放工具 ----------------
  function waitForVideo(timeout = 12000, interval = 250) {
    return new Promise((resolve) => {
      const start = Date.now();
      const found = document.querySelector('video');
      if (found) { resolve(found); return; }

      const timer = setInterval(() => {
        const v = document.querySelector('video');
        if (v) {
          clearInterval(timer);
          resolve(v);
          return;
        }
        if (Date.now() - start > timeout) {
          clearInterval(timer);
          resolve(null);
        }
      }, interval);
    });
  }

  async function robustPlay(video, opts = {}) {
    if (!video) return false;
    const maxAttempts = opts.maxAttempts || 6;
    const baseDelay = opts.baseDelay || 250; // ms

    try { if (typeof DEFAULT_PLAYBACK_RATE === 'number') video.playbackRate = DEFAULT_PLAYBACK_RATE; } catch(e){}

    try { video.playsInline = true; video.setAttribute('playsinline', ''); } catch(e){}

    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (!userGesture && i > 0) {
          try { video.muted = true; video.setAttribute('muted', ''); } catch(e){}
        }
        const p = video.play();
        if (p && typeof p.then === 'function') {
          await p;
        }
        return true;
      } catch (err) {
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
      }
    }
    return false;
  }

  // ---------------- 6) 绑定视频并自动化（改进版） ----------------
  const bindVideo = (video) => {
    if (!video || video.dataset.tmBound) return;
    video.dataset.tmBound = '1';

    try {
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.preload = 'auto';
    } catch(e){}

    try { if (typeof DEFAULT_PLAYBACK_RATE === 'number') video.playbackRate = DEFAULT_PLAYBACK_RATE; } catch(e){}

    const onPause = () => {
      if (document.hidden && !userGesture) {
        log('收到 pause 事件（后台），尝试恢复播放');
        video.play().catch(() => {});
      }
    };
    video.addEventListener('pause', onPause, true);

    const attemptAutoplay = () => {
      if (!video) return;
      if (!userGesture) { try { video.muted = true; video.setAttribute('muted',''); } catch(e){} }
      robustPlay(video).then(ok => {
        if (!ok) needUserClickOverlay();
      });
    };
    if (video.readyState > 0) attemptAutoplay();
    else video.addEventListener('loadedmetadata', attemptAutoplay, { once: true });

    video.addEventListener('ended', () => {
      log('视频结束，尝试下一节');
      flashTitle('【▶ 播放结束，正在切换下一节】');
      clickNextAndPlay();
    });

    const obs = new MutationObserver(() => {
      try { if (typeof DEFAULT_PLAYBACK_RATE === 'number') video.playbackRate = DEFAULT_PLAYBACK_RATE; } catch(e){}
    });
    obs.observe(video, { attributes: true });

    log('已绑定视频元素', video);
  };

  // ---------------- 7) 更高效的 DOM 监听（addedNodes 优先） ----------------
  const domObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach(node => {
          if (!node || node.nodeType !== 1) return;
          if (node.tagName === 'VIDEO') bindVideo(node);
          else {
            try {
              const v = node.querySelector && node.querySelector('video');
              if (v) bindVideo(v);
            } catch(e){}
          }
        });
      }
    }
  });
  domObserver.observe(document.documentElement, { childList: true, subtree: true });

  // 初始扫描（保底）
  function initialScan() { document.querySelectorAll('video').forEach(bindVideo); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialScan, { once: true });
  } else initialScan();

  // SPA 支持
  window.addEventListener('hashchange', () => { initialScan(); });
  window.addEventListener('popstate', () => { initialScan(); });

  // ---------------- 8) 下一节点击 + 跳转后播放 ----------------
  function clickNext() {
    const textMatch = Array.from(document.querySelectorAll('button, a, span'))
      .find(el => /下一个|下一节|下一页|下一项/.test(el.textContent || ''));
    if (textMatch) { textMatch.click(); return true; }

    const candidates = [
      '.vjs-next-control', '.next', '[aria-label="Next"]', '.ant-pagination-next', '.next-btn'
    ].join(',');
    const el = document.querySelector(candidates);
    if (el) { el.click(); return true; }

    return false;
  }

  async function clickNextAndPlay() {
    const clicked = clickNext();
    if (!clicked) return;
    const video = await waitForVideo(12000, 300);
    if (!video) {
      log('跳转后未能找到 video 元素');
      return;
    }
    bindVideo(video);
    setTimeout(() => {
      robustPlay(video).then(ok => {
        if (!ok) needUserClickOverlay();
      });
    }, 400);
  }

  // ---------------- 9) UI 与工具 ----------------
  let overlayShown = false;
  function needUserClickOverlay() {
    if (overlayShown) return;
    overlayShown = true;
    const btn = document.createElement('div');
    btn.id = 'tm-play-overlay';
    btn.textContent = '▶️ 点击授权播放（解除浏览器限制）';
    btn.addEventListener('click', () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          const ctx = new Ctx();
          ctx.resume && ctx.resume();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          log('后台保活音频已启动');
        }
      } catch (e) {
        warn('启动后台保活失败', e);
      }
      userGesture = true;
      btn.remove();
      overlayShown = false;

      const v = document.querySelector('video');
      if (v) {
        try { v.muted = false; v.removeAttribute('muted'); } catch(e){}
        v.play().catch(() => {});
      }
    });
    document.documentElement.appendChild(btn);
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

  log('脚本已加载（document-start），等待视频出现并自动接管（含默认速率 ' + DEFAULT_PLAYBACK_RATE + 'x）');
})();
