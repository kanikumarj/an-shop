/**
 * prisma/seed.js
 * ===============
 * Database seeder — creates admin user, categories, and sample products.
 * Run with: npm run prisma:seed
 */

'use strict';

require('dotenv').config({ path: '../../../.env' });

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { slugify } = require('../utils/helpers');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // ─── Create SuperAdmin ────────────────────────────────────────────────────
  const adminPassword = await bcrypt.hash('Admin@123456', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@anshop.com' },
    update: {},
    create: {
      name: 'An Shop Admin',
      email: 'admin@anshop.com',
      password: adminPassword,
      role: 'SUPERADMIN',
      isActive: true,
      isEmailVerified: true,
    },
  });
  console.log('✅ Admin user created:', admin.email);

  // ─── Create Categories ─────────────────────────────────────────────────────
  const categoriesData = [
    { name: 'Namkeens & Chaklis', icon: '🥨', description: 'Crispy and crunchy traditional Indian snacks' },
    { name: 'Sweets & Laddoos', icon: '🍬', description: 'Delicious homemade traditional Indian sweets' },
    { name: 'Cookies & Biscuits', icon: '🍪', description: 'Freshly baked cookies and biscuits' },
    { name: 'Chutneys & Pickles', icon: '🫙', description: 'Authentic homemade chutneys and pickles' },
    { name: 'Dry Fruits & Nuts', icon: '🥜', description: 'Premium quality nuts and dry fruits' },
    { name: 'Festival Specials', icon: '🎊', description: 'Special snacks for festivals and celebrations' },
  ];

  const categories = [];
  for (const cat of categoriesData) {
    const category = await prisma.category.upsert({
      where: { slug: slugify(cat.name) },
      update: {},
      create: {
        name: cat.name,
        slug: slugify(cat.name),
        description: cat.description,
        icon: cat.icon,
        isActive: true,
        sortOrder: categoriesData.indexOf(cat),
      },
    });
    categories.push(category);
    console.log('✅ Category created:', category.name);
  }

  // ─── Create Sample Products ────────────────────────────────────────────────
  const productsData = [
    {
      name: 'Homemade Chakli',
      category: 'Namkeens & Chaklis',
      price: 180,
      comparePrice: 220,
      stock: 50,
      description: 'Crispy, crunchy, and perfectly spiced homemade chakli made from rice flour. Our signature recipe passed down through generations.',
      ingredients: 'Rice flour, gram flour, sesame seeds, cumin, salt, oil',
      shelfLife: '15 days',
      tags: ['crispy', 'traditional', 'gluten-free-option'],
      isFeatured: true,
      isBestseller: true,
    },
    {
      name: 'Besan Laddoo',
      category: 'Sweets & Laddoos',
      price: 240,
      comparePrice: 280,
      stock: 35,
      description: 'Melt-in-your-mouth besan laddoos made with pure desi ghee and roasted gram flour. A classic Indian sweet.',
      ingredients: 'Gram flour, desi ghee, powdered sugar, cardamom, dry fruits',
      shelfLife: '20 days',
      tags: ['sweet', 'ghee', 'traditional', 'festive'],
      isFeatured: true,
      isNewArrival: false,
    },
    {
      name: 'Butter Cookies',
      category: 'Cookies & Biscuits',
      price: 150,
      stock: 80,
      description: 'Freshly baked butter cookies with a perfect crumbly texture. Made with real butter and vanilla.',
      ingredients: 'Refined flour, butter, sugar, vanilla extract, baking powder',
      shelfLife: '10 days',
      tags: ['butter', 'baked', 'cookies'],
      isNewArrival: true,
    },
    {
      name: 'Mango Pickle',
      category: 'Chutneys & Pickles',
      price: 120,
      stock: 60,
      description: 'Tangy and spicy raw mango pickle made with traditional spices. A perfect accompaniment to any meal.',
      ingredients: 'Raw mango, mustard oil, salt, fenugreek, chilli powder, turmeric',
      shelfLife: '6 months',
      tags: ['pickle', 'tangy', 'spicy', 'traditional'],
    },
    {
      name: 'Mixed Dry Fruit Chikki',
      category: 'Dry Fruits & Nuts',
      price: 320,
      comparePrice: 380,
      stock: 40,
      description: 'Premium mixed dry fruit chikki with cashews, almonds, and pistachios in pure jaggery.',
      ingredients: 'Jaggery, cashews, almonds, pistachios, cardamom',
      shelfLife: '30 days',
      tags: ['healthy', 'nuts', 'jaggery', 'energy'],
      isFeatured: true,
    },
    {
      name: 'Diwali Special Box',
      category: 'Festival Specials',
      price: 599,
      comparePrice: 750,
      stock: 25,
      description: 'A special Diwali hamper with assorted sweets, namkeens, and dry fruits. Perfect as a gift.',
      ingredients: 'Assorted premium ingredients',
      shelfLife: '15 days',
      tags: ['diwali', 'gift', 'festive', 'hamper'],
      isFeatured: true,
    },
  ];

  for (const product of productsData) {
    const category = categories.find((c) => c.name === product.category);
    if (!category) continue;

    const sku = `AN-${product.name.split(' ').map((w) => w[0]).join('')}-001`;

    await prisma.product.upsert({
      where: { slug: slugify(product.name) },
      update: {},
      create: {
        name: product.name,
        slug: slugify(product.name),
        description: product.description,
        basePrice: product.price,
        comparePrice: product.comparePrice || null,
        costPrice: product.price * 0.5,
        stock: product.stock,
        sku,
        categoryId: category.id,
        tags: product.tags || [],
        ingredients: product.ingredients,
        shelfLife: product.shelfLife,
        isFeatured: product.isFeatured || false,
        isBestseller: product.isBestseller || false,
        isNewArrival: product.isNewArrival || false,
        isActive: true,
        trackInventory: true,
        lowStockThreshold: 10,
      },
    });

    console.log('✅ Product created:', product.name);
  }

  // ─── Create Global Settings ────────────────────────────────────────────────
  const settings = [
    { key: 'shop_name', value: { text: 'An Shop' }, group: 'general', isPublic: true },
    { key: 'shop_phone', value: { number: process.env.SHOP_PHONE || '+919876543210' }, group: 'general', isPublic: true },
    { key: 'free_shipping_threshold', value: { amount: 500 }, group: 'shipping', isPublic: true },
    { key: 'default_shipping_charge', value: { amount: 50 }, group: 'shipping', isPublic: true },
    { key: 'tax_rate', value: { rate: 0.18 }, group: 'billing', isPublic: false },
    { key: 'maintenance_mode', value: { enabled: false }, group: 'system', isPublic: false },
  ];

  for (const setting of settings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: { value: setting.value },
      create: setting,
    });
  }

  console.log('✅ Settings configured');
  console.log('');
  console.log('🎉 Database seed complete!');
  console.log('');
  console.log('Admin credentials:');
  console.log('  Email: admin@anshop.com');
  console.log('  Password: Admin@123456');
  console.log('  ⚠️ Change these credentials immediately in production!');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
