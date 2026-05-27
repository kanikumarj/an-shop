/* ═══════════════════════════════════════════════════════════════════════
   INDIANMADE — Interactive JavaScript
   3D Parallax, Particle Canvas, Animations, Slider
   ═══════════════════════════════════════════════════════════════════════ */

"use strict";

// ── Utility ─────────────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (min, max) => Math.random() * (max - min) + min;

// ════════════════════════════════════════════════════════════════════════
// 1. NAVBAR
// ════════════════════════════════════════════════════════════════════════
(function initNavbar() {
  const navbar    = $('#navbar');
  const hamburger = $('#hamburger');
  const navLinks  = $('#nav-links');

  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 40);
    updateScrollTopBtn();
  }, { passive: true });

  hamburger?.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    navLinks?.classList.toggle('open');
  });

  // Close mobile menu on link click
  $$('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      hamburger?.classList.remove('open');
      navLinks?.classList.remove('open');
    });
  });

  // Active link based on scroll
  const sections = $$('section[id]');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        $$('.nav-link').forEach(l => l.classList.remove('active'));
        const link = $(`.nav-link[href="#${entry.target.id}"]`);
        link?.classList.add('active');
      }
    });
  }, { threshold: 0.4 });
  sections.forEach(s => observer.observe(s));
})();

// ════════════════════════════════════════════════════════════════════════
// 2. PARTICLE CANVAS (Hero Background)
// ════════════════════════════════════════════════════════════════════════
(function initParticleCanvas() {
  const canvas = $('#particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  let W, H, particles = [], animId;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = canvas.parentElement.offsetHeight;
    if (!animId) animate();
  }

  class Particle {
    constructor() { this.reset(true); }
    reset(init = false) {
      this.x     = rnd(0, W);
      this.y     = init ? rnd(0, H) : H + 20;
      this.size  = rnd(0.5, 2.5);
      this.speed = rnd(0.2, 0.8);
      this.drift = rnd(-0.3, 0.3);
      this.alpha = rnd(0.1, 0.6);
      this.hue   = rnd(20, 45);       // golden-orange range
      this.life  = 0;
      this.maxLife = rnd(200, 400);
    }
    update() {
      this.y -= this.speed;
      this.x += Math.sin(this.life * 0.02) * this.drift;
      this.life++;
      if (this.y < -10 || this.life > this.maxLife) this.reset();
    }
    draw() {
      const fade = this.life < 40
        ? this.life / 40
        : this.life > this.maxLife - 40
        ? (this.maxLife - this.life) / 40
        : 1;
      ctx.save();
      ctx.globalAlpha = this.alpha * fade;
      ctx.fillStyle = `hsl(${this.hue}, 90%, 65%)`;
      ctx.shadowColor = `hsl(${this.hue}, 90%, 65%)`;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Spice dust particles (orange/red specks)
  class DustParticle {
    constructor() { this.reset(true); }
    reset(init = false) {
      this.x     = rnd(0, W);
      this.y     = init ? rnd(0, H) : rnd(-20, H * 0.5);
      this.vx    = rnd(-0.4, 0.4);
      this.vy    = rnd(0.05, 0.3);
      this.size  = rnd(1, 4);
      this.alpha = rnd(0.05, 0.25);
      this.life  = 0;
      this.maxLife = rnd(300, 600);
      this.hue   = rnd(15, 50);
    }
    update() {
      this.x += this.vx + Math.sin(this.life * 0.01) * 0.2;
      this.y += this.vy;
      this.life++;
      if (this.y > H + 10 || this.life > this.maxLife) this.reset();
    }
    draw() {
      const fade = this.life < 60
        ? this.life / 60
        : this.life > this.maxLife - 60
        ? (this.maxLife - this.life) / 60
        : 1;
      ctx.save();
      ctx.globalAlpha = this.alpha * fade;
      ctx.fillStyle = `hsl(${this.hue}, 85%, 55%)`;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function init() {
    particles = [];
    for (let i = 0; i < 80; i++)  particles.push(new Particle());
    for (let i = 0; i < 40; i++)  particles.push(new DustParticle());
  }

  function animate() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => { p.update(); p.draw(); });
    animId = requestAnimationFrame(animate);
  }

  window.addEventListener('resize', () => { resize(); init(); }, { passive: true });
  resize();
  init();
})();

// ════════════════════════════════════════════════════════════════════════
// 3. MOUSE PARALLAX (Hero 3D effect)
// ════════════════════════════════════════════════════════════════════════
(function initParallax() {
  const scene    = $('#scene3d');
  const wrapper  = $('#paradoxWrapper');
  const left     = $('#heroLeft');
  const floats   = $$('.float-item');
  if (!scene) return;

  let mouseX = 0, mouseY = 0;
  let targetX = 0, targetY = 0;
  let curX = 0, curY = 0;

  document.addEventListener('mousemove', e => {
    const cx = window.innerWidth  / 2;
    const cy = window.innerHeight / 2;
    mouseX = (e.clientX - cx) / cx;
    mouseY = (e.clientY - cy) / cy;
  }, { passive: true });

  function tick() {
    curX = lerp(curX, mouseX, 0.06);
    curY = lerp(curY, mouseY, 0.06);

    if (wrapper) {
      // Subtle tilt on the paradox triangle
      wrapper.style.transform = `
        rotate(${curX * 8}deg)
        rotateX(${-curY * 6}deg)
        rotateY(${curX * 6}deg)
      `;
    }

    if (left) {
      left.style.transform = `translate(${curX * -6}px, ${curY * -4}px)`;
    }

    floats.forEach((el, i) => {
      const depth = 0.5 + (i % 4) * 0.5;
      el.style.transform = `translate(${curX * depth * 16}px, ${curY * depth * 10}px)`;
    });

    requestAnimationFrame(tick);
  }
  tick();
})();

// ════════════════════════════════════════════════════════════════════════
// 4. SCROLL-TRIGGERED ANIMATIONS
// ════════════════════════════════════════════════════════════════════════
(function initScrollAnimations() {
  const targets = $$('[data-animate], [data-animate-delay]');

  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el    = entry.target;
      const delay = parseInt(el.dataset.animateDelay || el.dataset.delay || 0, 10);
      setTimeout(() => {
        el.classList.add('animated');
      }, delay);
      io.unobserve(el);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  targets.forEach(el => io.observe(el));

  // Stagger child elements inside grids
  $$('.categories-grid .cat-card, .products-grid .product-card, .combos-grid .combo-card, .features-grid .feature-card, .how-grid .how-step').forEach((el, i) => {
    el.dataset.animate = '';
    el.dataset.animateDelay = i * 80;
    io.observe(el);
  });
})();

// ════════════════════════════════════════════════════════════════════════
// 5. COUNTER ANIMATION (Hero Stats)
// ════════════════════════════════════════════════════════════════════════
(function initCounters() {
  const counters = $$('.stat-number[data-target]');
  if (!counters.length) return;

  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el     = entry.target;
      const target = parseInt(el.dataset.target, 10);
      let start = 0;
      const duration = 1800;
      const step = timestamp => {
        if (!start) start = timestamp;
        const progress = Math.min((timestamp - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.floor(eased * target).toLocaleString('en-IN');
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      io.unobserve(el);
    });
  }, { threshold: 0.5 });

  counters.forEach(c => io.observe(c));
})();

// ════════════════════════════════════════════════════════════════════════
// 6. REVIEWS SLIDER
// ════════════════════════════════════════════════════════════════════════
(function initSlider() {
  const track  = $('#reviewsTrack');
  const dots   = $$('.dot');
  const prevBtn = $('#prevBtn');
  const nextBtn = $('#nextBtn');
  if (!track) return;

  const cards      = $$('.review-card', track);
  let current      = 0;
  let autoId       = null;
  const VISIBLE    = window.innerWidth > 768 ? 3 : 1;
  const total      = cards.length;
  const maxSlide   = total - VISIBLE;

  function goTo(idx) {
    current = clamp(idx, 0, maxSlide);
    const cardW  = cards[0].offsetWidth + 24; // gap
    track.style.transform = `translateX(-${current * cardW}px)`;
    dots.forEach((d, i) => d.classList.toggle('active', i === current));
  }

  function next() { goTo(current >= maxSlide ? 0 : current + 1); }
  function prev() { goTo(current <= 0 ? maxSlide : current - 1); }

  nextBtn?.addEventListener('click', () => { clearInterval(autoId); next(); startAuto(); });
  prevBtn?.addEventListener('click', () => { clearInterval(autoId); prev(); startAuto(); });

  dots.forEach((dot, i) => {
    dot.addEventListener('click', () => { clearInterval(autoId); goTo(i); startAuto(); });
  });

  function startAuto() { autoId = setInterval(next, 4500); }
  startAuto();

  // Touch/swipe support
  let touchStartX = 0;
  track.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend',   e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) { clearInterval(autoId); dx < 0 ? next() : prev(); startAuto(); }
  }, { passive: true });

  window.addEventListener('resize', () => goTo(current), { passive: true });
})();

// ════════════════════════════════════════════════════════════════════════
// 7. SCROLL TO TOP
// ════════════════════════════════════════════════════════════════════════
function updateScrollTopBtn() {
  const btn = $('#scrollTopBtn');
  btn?.classList.toggle('visible', window.scrollY > 500);
}

$('#scrollTopBtn')?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ════════════════════════════════════════════════════════════════════════
// 8. ADD TO CART — Micro Animation
// ════════════════════════════════════════════════════════════════════════
$$('.btn-add-cart').forEach(btn => {
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const original = this.textContent;

    // Ripple effect
    const ripple = document.createElement('span');
    ripple.style.cssText = `
      position:absolute;width:100%;height:100%;top:0;left:0;
      border-radius:inherit;background:rgba(255,255,255,0.25);
      transform:scale(0);animation:rippleAnim 0.5s ease-out forwards;
    `;
    if (!document.querySelector('#rippleStyle')) {
      const style = document.createElement('style');
      style.id = 'rippleStyle';
      style.textContent = '@keyframes rippleAnim{to{transform:scale(2);opacity:0}}';
      document.head.appendChild(style);
    }
    this.style.position = 'relative';
    this.style.overflow = 'hidden';
    this.appendChild(ripple);
    setTimeout(() => ripple.remove(), 500);

    this.textContent = '✓ Added!';
    this.style.background = 'linear-gradient(135deg, #2e7d32, #43a047)';
    this.style.color = '#fff';

    // Call store cart
    try {
      const prodId = parseInt(this.id.split('-')[1], 10);
      const product = window.PRODUCTS.find(p => p.id === prodId);
      if (product && window.Cart) {
        window.Cart.addItem(product, 1, '250g');
      }
    } catch (err) {
      console.error("Cart error:", err);
    }

    setTimeout(() => {
      this.textContent = original;
      this.style.background = '';
      this.style.color = '';
    }, 2000);
  });
});

// 8.1. COMBO BUTTONS — Add Combo and Go to Cart
$$('.btn-combo').forEach(btn => {
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    let comboId = 11; // default to festival
    if (this.id === 'btn-combo-2') comboId = 13;
    if (this.id === 'btn-combo-3') comboId = 14;

    const product = window.PRODUCTS.find(p => p.id === comboId);
    if (product && window.Cart) {
      window.Cart.addItem(product, 1, '1 Pack');
      window.location.href = 'cart.html';
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 9. WISHLIST TOGGLE
// ════════════════════════════════════════════════════════════════════════
$$('.product-wishlist').forEach(btn => {
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const isWished = this.textContent.trim() === '♥';
    this.textContent = isWished ? '♡' : '♥';
    this.style.color = isWished ? '' : '#ff6b6b';
    this.style.borderColor = isWished ? '' : 'rgba(255,100,100,0.3)';
  });
});

// ════════════════════════════════════════════════════════════════════════
// 10. NEWSLETTER SUBMIT
// ════════════════════════════════════════════════════════════════════════
function handleNewsletterSubmit(e) {
  e.preventDefault();
  const emailInput  = $('#nl-email');
  const btn         = $('#btn-subscribe');
  const email       = emailInput?.value.trim();
  if (!email) return;

  const orig = btn.textContent;
  btn.textContent = '✓ Subscribed!';
  btn.style.background = 'linear-gradient(135deg, #2e7d32, #43a047)';
  btn.style.color = '#fff';

  setTimeout(() => {
    btn.textContent = orig;
    btn.style.background = '';
    btn.style.color = '';
    if (emailInput) emailInput.value = '';
  }, 3000);
}
window.handleNewsletterSubmit = handleNewsletterSubmit;

// ════════════════════════════════════════════════════════════════════════
// 11. 3D CARD TILT (Product & Category Cards)
// ════════════════════════════════════════════════════════════════════════
(function initCardTilt() {
  const tiltCards = $$('.product-card, .combo-card, .cat-card, .feature-card');

  tiltCards.forEach(card => {
    card.addEventListener('mousemove', function (e) {
      const rect   = this.getBoundingClientRect();
      const relX   = e.clientX - rect.left;
      const relY   = e.clientY - rect.top;
      const cx     = rect.width  / 2;
      const cy     = rect.height / 2;
      const rotX   = clamp((relY - cy) / cy * -6, -8, 8);
      const rotY   = clamp((relX - cx) / cx *  6, -8, 8);
      this.style.transform = `translateY(-10px) rotateX(${rotX}deg) rotateY(${rotY}deg) scale(1.01)`;
      this.style.transition = 'transform 0.1s ease';
    });

    card.addEventListener('mouseleave', function () {
      this.style.transform = '';
      this.style.transition = 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1)';
    });
  });
})();

// ════════════════════════════════════════════════════════════════════════
// 12. SMOOTH SCROLL
// ════════════════════════════════════════════════════════════════════════
$$('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    const target = $(this.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = 80;
    const top    = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

// ════════════════════════════════════════════════════════════════════════
// 13. HERO TITLE WORD REVEAL
// ════════════════════════════════════════════════════════════════════════
(function initHeroReveal() {
  const lines = $$('.title-line');
  lines.forEach((line, i) => {
    line.style.opacity = '0';
    line.style.transform = 'translateY(20px)';
    line.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    setTimeout(() => {
      line.style.opacity = '1';
      line.style.transform = 'translateY(0)';
    }, 400 + i * 150);
  });

  const badge = $('.hero-badge');
  if (badge) {
    badge.style.opacity = '0';
    badge.style.transform = 'translateY(10px)';
    badge.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    setTimeout(() => {
      badge.style.opacity = '1';
      badge.style.transform = 'translateY(0)';
    }, 200);
  }

  const subtitle = $('.hero-subtitle');
  if (subtitle) {
    subtitle.style.opacity = '0';
    subtitle.style.transition = 'opacity 0.7s ease';
    setTimeout(() => { subtitle.style.opacity = '1'; }, 1000);
  }

  const cta = $('.hero-cta');
  if (cta) {
    cta.style.opacity = '0';
    cta.style.transform = 'translateY(16px)';
    cta.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
    setTimeout(() => {
      cta.style.opacity = '1';
      cta.style.transform = 'translateY(0)';
    }, 1200);
  }

  const stats = $('.hero-stats');
  if (stats) {
    stats.style.opacity = '0';
    stats.style.transition = 'opacity 0.7s ease';
    setTimeout(() => { stats.style.opacity = '1'; }, 1500);
  }
})();

// ════════════════════════════════════════════════════════════════════════
// 14. PARALLAX SCROLL (sections floating effect)
// ════════════════════════════════════════════════════════════════════════
(function initScrollParallax() {
  const heroBgGlow = $('.hero-bg-glow');

  window.addEventListener('scroll', () => {
    const sy = window.scrollY;
    if (heroBgGlow) {
      heroBgGlow.style.transform = `translateY(${sy * 0.3}px)`;
    }
  }, { passive: true });
})();

// ════════════════════════════════════════════════════════════════════════
// 15. DYNAMIC AMBIENT GLOW — cursor proximity effect
// ════════════════════════════════════════════════════════════════════════
(function initCursorGlow() {
  const glow = document.createElement('div');
  glow.style.cssText = `
    position:fixed;width:400px;height:400px;border-radius:50%;
    background:radial-gradient(circle,rgba(200,105,10,0.07) 0%,transparent 70%);
    pointer-events:none;z-index:0;transform:translate(-50%,-50%);
    transition:opacity 0.3s;
  `;
  document.body.appendChild(glow);

  let glowX = 0, glowY = 0, targetGX = 0, targetGY = 0;

  document.addEventListener('mousemove', e => {
    targetGX = e.clientX;
    targetGY = e.clientY;
  }, { passive: true });

  document.addEventListener('mouseleave', () => { glow.style.opacity = '0'; });
  document.addEventListener('mouseenter', () => { glow.style.opacity = '1'; });

  (function animGlow() {
    glowX = lerp(glowX, targetGX, 0.08);
    glowY = lerp(glowY, targetGY, 0.08);
    glow.style.left = glowX + 'px';
    glow.style.top  = glowY + 'px';
    requestAnimationFrame(animGlow);
  })();
})();

// ════════════════════════════════════════════════════════════════════════
// 16. BUTTON HOVER SOUND (Visual feedback only — no actual audio)
// ════════════════════════════════════════════════════════════════════════
$$('.btn-combo, .btn-primary').forEach(btn => {
  btn.addEventListener('mouseenter', function () {
    this.style.letterSpacing = '0.02em';
  });
  btn.addEventListener('mouseleave', function () {
    this.style.letterSpacing = '';
  });
});

// ════════════════════════════════════════════════════════════════════════
// 17. SCROLL PROGRESS INDICATOR
// ════════════════════════════════════════════════════════════════════════
(function initScrollProgress() {
  const bar = document.createElement('div');
  bar.style.cssText = `
    position:fixed;top:0;left:0;height:2px;width:0%;
    background:linear-gradient(90deg,#c8690a,#f5a623,#ffe29a);
    z-index:9999;transition:width 0.1s linear;
    box-shadow:0 0 8px rgba(245,166,35,0.6);
  `;
  document.body.appendChild(bar);

  window.addEventListener('scroll', () => {
    const scrollTop  = window.scrollY;
    const docHeight  = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width  = (docHeight > 0 ? (scrollTop / docHeight) * 100 : 0) + '%';
  }, { passive: true });
})();

// ════════════════════════════════════════════════════════════════════════
// 18. INIT LOG
// ════════════════════════════════════════════════════════════════════════
console.log('%c🍛 Indianmade — Premium Homemade Snacks', 'font-size:16px;font-weight:bold;color:#f5a623;');
console.log('%cPowered by cinematic web design ✨', 'color:#b8a890;font-size:12px;');
