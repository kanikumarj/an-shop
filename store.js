"use strict";

// ─── Backend API URL ──────────────────────────────────────────────────────────
// Detect backend URL dynamically
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
window.BACKEND_URL = isLocal ? 'http://localhost:5000' : 'https://an-shop.onrender.com';

// ─── API Helper ───────────────────────────────────────────────────────────────
window.API = {
  async request(path, options = {}) {
    const token = window.Auth.getToken();
    const headers = { ...options.headers };
    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${window.BACKEND_URL}/api/v1${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
    return data;
  },

  get(path, opts = {})    { return this.request(path, { ...opts, method: 'GET' }); },
  post(path, body, opts)  { return this.request(path, { ...opts, method: 'POST',  body: JSON.stringify(body) }); },
  patch(path, body, opts) { return this.request(path, { ...opts, method: 'PATCH', body: JSON.stringify(body) }); },
  put(path, body, opts)   { return this.request(path, { ...opts, method: 'PUT',   body: JSON.stringify(body) }); },
  del(path, opts = {})    { return this.request(path, { ...opts, method: 'DELETE' }); },
};

// ─── Google OAuth Configuration ───────────────────────────────────────────────
window.GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";

const STATIC_PRODUCTS = [
  {id:1,name:'Homemade Murukku',cat:'snacks',price:149,orig:199,rating:4.9,count:128,emoji:'🌀',tags:['bestseller'],badge:'🔥 Hot',bt:'hot',desc:'Crispy spiral snack with sesame & cumin',color:'rgba(200,100,0,0.14)'},
  {id:2,name:'Kerala Banana Chips',cat:'snacks',price:129,orig:169,rating:4.8,count:94,emoji:'🍌',tags:['bestseller'],badge:'⭐ Top',bt:'best',desc:'Thin-sliced coconut oil fried chips',color:'rgba(255,200,0,0.1)'},
  {id:3,name:'Sambar Powder',cat:'spices',price:99,orig:139,rating:4.9,count:203,emoji:'🌶️',tags:['bestseller'],badge:'🏆 Best',bt:'best',desc:'Chettinad-style aromatic blend',color:'rgba(180,30,0,0.13)'},
  {id:4,name:'Homemade Cookies',cat:'snacks',price:179,orig:229,rating:4.7,count:67,emoji:'🍪',tags:['new'],badge:'✨ New',bt:'new',desc:'Cardamom & jaggery soft cookies',color:'rgba(120,70,0,0.12)'},
  {id:5,name:'Rasam Powder',cat:'spices',price:89,orig:120,rating:4.8,count:156,emoji:'🫙',tags:['bestseller'],badge:'💛 Fav',bt:'hot',desc:'Tangy south Indian rasam blend',color:'rgba(200,120,0,0.1)'},
  {id:6,name:'Garam Masala',cat:'spices',price:120,orig:159,rating:4.9,count:184,emoji:'🌿',tags:['bestseller'],badge:'🔥 Hot',bt:'hot',desc:'Whole spice premium masala blend',color:'rgba(60,100,0,0.12)'},
  {id:7,name:'Spicy Mixture',cat:'snacks',price:139,orig:189,rating:4.6,count:73,emoji:'🥣',tags:['new'],badge:'✨ New',bt:'new',desc:'Crunchy south Indian mixed snack',color:'rgba(180,80,0,0.1)'},
  {id:8,name:'Idli Dosa Mix',cat:'powders',price:149,orig:199,rating:4.8,count:112,emoji:'🫓',tags:['new'],badge:'✨ New',bt:'new',desc:'Ready-to-use fermented batter mix',color:'rgba(220,180,0,0.08)'},
  {id:9,name:'Chakli',cat:'snacks',price:159,orig:199,rating:4.7,count:88,emoji:'🌸',tags:[],badge:'',bt:'',desc:'Crispy spiral rice flour delicacy',color:'rgba(200,100,20,0.1)'},
  {id:10,name:'Coconut Chutney Pwd',cat:'powders',price:99,orig:130,rating:4.9,count:167,emoji:'🥥',tags:['bestseller'],badge:'🏆 Best',bt:'best',desc:'Instant coconut chutney powder',color:'rgba(220,200,100,0.08)'},
  {id:11,name:'Festival Bundle',cat:'combos',price:499,orig:699,rating:5.0,count:45,emoji:'🎁',tags:['bestseller'],badge:'⭐ Value',bt:'best',desc:'Festival snack + spice collection',color:'rgba(150,50,200,0.08)'},
  {id:12,name:'Tamarind Rice Mix',cat:'powders',price:110,orig:149,rating:4.7,count:92,emoji:'🍚',tags:[],badge:'',bt:'',desc:'Authentic puliyodharai rice mix',color:'rgba(160,100,0,0.1)'},
  {id:13,name:'Spice Collection',cat:'combos',price:449,orig:649,rating:4.9,count:38,emoji:'🌶️',tags:['bestseller'],badge:'⭐ Value',bt:'best',desc:'6 Premium spice powders for the authentic home cook',color:'rgba(200,80,0,0.1)'},
  {id:14,name:'Family Combo Pack',cat:'combos',price:899,orig:1299,rating:4.9,count:52,emoji:'👨‍👩‍👧‍👦',tags:['bestseller'],badge:'⭐ Value',bt:'best',desc:'Everything your family needs — snacks + spices, all in one',color:'rgba(245,166,35,0.08)'}
];

window.PRODUCTS = [...STATIC_PRODUCTS];

window.productsPromise = (async () => {
  try {
    const res = await fetch(`${window.BACKEND_URL}/api/v1/products?limit=100`);
    const data = await res.json();
    if (data && data.success && Array.isArray(data.data)) {
      const slugToOriginalId = {
        'homemade-murukku': 1,
        'kerala-banana-chips': 2,
        'sambar-powder': 3,
        'homemade-cookies': 4,
        'rasam-powder': 5,
        'garam-masala': 6,
        'spicy-mixture': 7,
        'idli-dosa-mix': 8,
        'chakli': 9,
        'coconut-chutney-pwd': 10,
        'festival-bundle': 11,
        'tamarind-rice-mix': 12,
        'spice-collection': 13,
        'family-combo-pack': 14
      };

      const catMap = {
        'snacks': 'snacks',
        'spices': 'spices',
        'powders': 'powders',
        'combos': 'combos',
        'namkeens-chaklis': 'snacks',
        'sweets-laddoos': 'snacks',
        'cookies-biscuits': 'snacks',
        'chutneys-pickles': 'spices',
        'dry-fruits-nuts': 'snacks',
        'festival-specials': 'combos'
      };

      const colorMap = {
        'snacks': 'rgba(200,100,0,0.14)',
        'spices': 'rgba(180,30,0,0.13)',
        'powders': 'rgba(220,180,0,0.08)',
        'combos': 'rgba(150,50,200,0.08)'
      };

      let nextNumericId = 15;

      window.PRODUCTS = data.data.map(p => {
        const cat = catMap[p.category?.slug] || p.category?.slug || 'snacks';
        const color = colorMap[cat] || 'rgba(200,100,0,0.14)';
        
        let id = slugToOriginalId[p.slug];
        if (!id) {
          id = nextNumericId++;
        }

        const price = parseFloat(p.basePrice) || 149;
        const orig = p.comparePrice ? parseFloat(p.comparePrice) : Math.round(price * 1.35);
        const rating = parseFloat(p.avgRating) || 4.8;
        const count = p.totalReviews || 120;
        const emoji = p.searchKeywords || '🌀';
        const tags = Array.isArray(p.tags) ? p.tags : [];
        
        const badge = p.isBestseller ? '🏆 Best' : p.isFeatured ? '🔥 Hot' : p.isNewArrival ? '✨ New' : '';
        const bt = p.isBestseller ? 'best' : p.isFeatured ? 'hot' : p.isNewArrival ? 'new' : '';
        const desc = p.description || p.shortDescription || '';

        return {
          id,
          dbId: p.id,
          name: p.name,
          cat,
          price,
          orig,
          rating,
          count,
          emoji,
          tags,
          badge,
          bt,
          desc,
          color
        };
      });
      console.log('Successfully loaded and mapped products from NeonDB:', window.PRODUCTS);
    }
  } catch (err) {
    console.error('Failed to fetch real products from NeonDB, using offline fallback:', err);
  }
})();

window.Cart = {
  getCart() {
    try {
      const data = localStorage.getItem('im_cart');
      return data ? JSON.parse(data) : [];
    } catch (e) { return []; }
  },
  saveCart(cart) {
    try {
      localStorage.setItem('im_cart', JSON.stringify(cart));
      window.dispatchEvent(new CustomEvent('cartUpdated'));
    } catch (e) { console.error(e); }
  },
  addItem(product, qty = 1, weight = '250g') {
    const cart = this.getCart();
    const existingIndex = cart.findIndex(item => item.id === product.id && item.weight === weight);
    if (existingIndex > -1) {
      cart[existingIndex].qty += qty;
    } else {
      cart.push({ id: product.id, name: product.name, emoji: product.emoji,
        price: product.price, orig: product.orig, cat: product.cat, weight, qty });
    }
    this.saveCart(cart);
  },
  updateQty(id, weight, delta) {
    let cart = this.getCart();
    const idx = cart.findIndex(item => item.id === id && item.weight === weight);
    if (idx > -1) {
      cart[idx].qty += delta;
      if (cart[idx].qty <= 0) cart.splice(idx, 1);
      this.saveCart(cart);
    }
  },
  removeItem(id, weight) {
    this.saveCart(this.getCart().filter(item => !(item.id === id && item.weight === weight)));
  },
  getCartCount() { return this.getCart().reduce((sum, item) => sum + item.qty, 0); },
  clearCart()    { this.saveCart([]); },
  updateBadge()  { window.CartUI && window.CartUI.updateNavBadge && window.CartUI.updateNavBadge(); }
};

window.Auth = {
  USER_KEY:  'im_user',
  TOKEN_KEY: 'im_token',

  getUser() {
    try { return JSON.parse(localStorage.getItem(this.USER_KEY) || 'null'); } catch { return null; }
  },

  getToken() {
    try { return localStorage.getItem(this.TOKEN_KEY) || null; } catch { return null; }
  },

  loginUser(userData, token) {
    try {
      localStorage.setItem(this.USER_KEY, JSON.stringify({ joinedAt: new Date().toISOString(), ...userData }));
      if (token) localStorage.setItem(this.TOKEN_KEY, token);
      window.dispatchEvent(new CustomEvent('authUpdated'));
    } catch (e) { console.error(e); }
  },

  logoutUser() {
    try {
      const token = this.getToken();
      if (token) {
        fetch(`${window.BACKEND_URL}/api/v1/auth/logout`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          credentials: 'include',
        }).catch(() => {});
      }
      localStorage.removeItem(this.USER_KEY);
      localStorage.removeItem(this.TOKEN_KEY);
      window.dispatchEvent(new CustomEvent('authUpdated'));
    } catch (e) { console.error(e); }
  },

  // DB returns: CUSTOMER, ADMIN, SUPERADMIN
  isAdmin() {
    const u = this.getUser();
    return u && (u.role === 'ADMIN' || u.role === 'SUPERADMIN');
  },
  isSuperAdmin() {
    const u = this.getUser();
    return u && u.role === 'SUPERADMIN';
  },

  login(userData, token) { this.loginUser(userData, token); },
  logout()               { this.logoutUser(); },
};

window.CartUI = {
  updateNavBadge() {
    const badge = document.getElementById('cartBadge') || document.getElementById('nav-cart-badge') || document.querySelector('.cart-badge');
    if (badge) {
      const count = window.Cart.getCartCount();
      badge.textContent = count;
      if (count > 0) {
        badge.classList.add('show');
        badge.classList.remove('bump');
        void badge.offsetWidth;
        badge.classList.add('bump');
      } else {
        badge.classList.remove('show');
      }
    }
  },
  updateAuthNavBar() {
    const loginBtn = document.getElementById('nav-login-btn') ||
      document.querySelector('.btn-nav-login') ||
      document.querySelector('.btn-login-nav') ||
      document.querySelector('.btn-nav-cta');
    const user = window.Auth.getUser();
    if (loginBtn) {
      if (user) {
        loginBtn.textContent = user.name;
        loginBtn.href = 'dashboard.html';
        loginBtn.classList.add('user-logged-in');
        loginBtn.style.background = 'linear-gradient(135deg, var(--gold, #f5a623), var(--gl, #ffe29a))';
        loginBtn.style.color = '#0a0804';
      } else {
        loginBtn.textContent = 'Log in';
        loginBtn.href = 'auth.html';
        loginBtn.classList.remove('user-logged-in');
        loginBtn.style.background = '';
        loginBtn.style.color = '';
      }
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  window.CartUI.updateNavBadge();
  window.CartUI.updateAuthNavBar();
});
window.addEventListener('cartUpdated', () => window.CartUI.updateNavBadge());
window.addEventListener('authUpdated', () => window.CartUI.updateAuthNavBar());
window.addEventListener('storage', (e) => {
  if (e.key === 'im_cart') window.dispatchEvent(new CustomEvent('cartUpdated'));
  if (e.key === 'im_user' || e.key === 'im_token') window.dispatchEvent(new CustomEvent('authUpdated'));
});
