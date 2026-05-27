/**
 * app.js  [ENTERPRISE EDITION]
 * ==============================
 * Express application factory — fully secured, optimized, production-ready.
 *
 * MIDDLEWARE STACK ORDER (matters!):
 *  1.  trust proxy
 *  2.  requestId + securityLogger (correlation IDs)
 *  3.  helmetMiddleware (security headers)
 *  4.  CORS
 *  5.  responseTime (performance tracking)
 *  6.  Body parsers (JSON + URL encoded)
 *  7.  cookieParser
 *  8.  hppMiddleware (HTTP param pollution)
 *  9.  sanitizationMiddleware (NoSQL injection)
 * 10.  xssProtection (script tag scrubber)
 * 11.  compressionMiddleware (gzip)
 * 12.  HTTP request logging (Morgan)
 * 13.  globalRateLimiter + speedLimiter
 * 14.  paginationGuard (max page/limit)
 * 15.  fieldSelector (?fields=...)
 * 16.  conditionalEtag (304 support)
 * 17.  API versioning guard
 * 18.  requestLogger (structured logging)
 * 19.  csrfTokenMiddleware (cookie generation)
 * 20.  API routes
 * 21.  404 handler
 * 22.  Global error handler
 */

'use strict';

const express       = require('express');
const cors          = require('cors');
const compression   = require('compression');
const morgan        = require('morgan');
const cookieParser  = require('cookie-parser');
require('express-async-errors');

// ─── Internal Imports ─────────────────────────────────────────────────────────
const { morganStream }    = require('./utils/logger');
const logger              = require('./utils/logger');
const { globalErrorHandler } = require('./middleware/errorHandler');
const { notFoundHandler } = require('./middleware/notFoundHandler');
const { requestLogger }   = require('./middleware/requestLogger');

// Security middleware
const {
  requestId,
  securityLogger,
  helmetMiddleware,
  corsOptions,
  globalRateLimiter,
  speedLimiter,
  hppMiddleware,
  sanitizationMiddleware,
  xssProtection,
  csrfTokenMiddleware,
  securityHeaders,
} = require('./middleware/security');

// Performance middleware
const {
  responseTime,
  queryTimeout,
  conditionalEtag,
  paginationGuard,
  fieldSelector,
  compressionFilter,
  apiVersionGuard,
  healthCheck,
} = require('./middleware/performance.middleware');

// Cache middleware
const { noCacheHeaders } = require('./middleware/cache.middleware');

// Routes
const routes      = require('./routes');
const swaggerSetup = require('./config/swagger');

// ─── App Factory ───────────────────────────────────────────────────────────────
const app = express();

// ══════════════════════════════════════════════════════════
//   1. TRUST + PROXY
// ══════════════════════════════════════════════════════════
app.set('trust proxy', 1);
app.set('x-powered-by', false);

// ══════════════════════════════════════════════════════════
//   2. CORRELATION IDs (must be first)
// ══════════════════════════════════════════════════════════
app.use(requestId);
app.use(securityLogger);

// ══════════════════════════════════════════════════════════
//   3. SECURITY HEADERS (helmet + extra)
// ══════════════════════════════════════════════════════════
app.use(helmetMiddleware);
app.use(securityHeaders);

// ══════════════════════════════════════════════════════════
//   4. CORS (preflight + actual)
// ══════════════════════════════════════════════════════════
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ══════════════════════════════════════════════════════════
//   5. PERFORMANCE TRACKING
// ══════════════════════════════════════════════════════════
app.use(responseTime);
app.use(queryTimeout(parseInt(process.env.DB_QUERY_TIMEOUT_MS) || 30000));

// ══════════════════════════════════════════════════════════
//   6. BODY PARSERS
// ══════════════════════════════════════════════════════════
app.use(express.json({
  limit: process.env.MAX_BODY_SIZE || '10kb',
  strict: true,
  type: ['application/json', 'application/json; charset=utf-8'],
}));
app.use(express.urlencoded({ extended: true, limit: process.env.MAX_BODY_SIZE || '10kb' }));
app.use(cookieParser());

// ══════════════════════════════════════════════════════════
//   7. INPUT SANITIZATION
// ══════════════════════════════════════════════════════════
app.use(hppMiddleware);
app.use(sanitizationMiddleware);
app.use(xssProtection);

// ══════════════════════════════════════════════════════════
//   8. COMPRESSION
// ══════════════════════════════════════════════════════════
app.use(compression({
  filter:    compressionFilter,
  threshold: 1024,    // Only compress > 1KB
  level:     6,       // Balanced speed/ratio
}));

// ══════════════════════════════════════════════════════════
//   9. HTTP LOGGING
// ══════════════════════════════════════════════════════════
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: morganStream,
  skip:   (req) => req.path === '/api/v1/health',
}));

// ══════════════════════════════════════════════════════════
//   10. RATE LIMITING
// ══════════════════════════════════════════════════════════
app.use('/api/', globalRateLimiter);
app.use('/api/', speedLimiter);

// ══════════════════════════════════════════════════════════
//   11. API OPTIMIZATION MIDDLEWARE
// ══════════════════════════════════════════════════════════
app.use(paginationGuard());
app.use(fieldSelector);
app.use(apiVersionGuard);

// ══════════════════════════════════════════════════════════
//   12. RESPONSE OPTIMIZATION (ETag)
// ══════════════════════════════════════════════════════════
app.use(conditionalEtag);

// ══════════════════════════════════════════════════════════
//   13. REQUEST LOGGER (structured)
// ══════════════════════════════════════════════════════════
app.use(requestLogger);

// ══════════════════════════════════════════════════════════
//   14. CSRF COOKIE GENERATION
// ══════════════════════════════════════════════════════════
app.use(csrfTokenMiddleware);

// ══════════════════════════════════════════════════════════
//   15. API DOCUMENTATION
// ══════════════════════════════════════════════════════════
swaggerSetup(app);

// ══════════════════════════════════════════════════════════
//   16. HEALTH CHECK (pre-route, no auth, no cache)
// ══════════════════════════════════════════════════════════
app.get('/api/v1/health', noCacheHeaders, healthCheck);

// ══════════════════════════════════════════════════════════
//   17. STATIC FILES
// ══════════════════════════════════════════════════════════
app.use('/uploads', express.static('src/uploads', {
  maxAge:    '1d',
  etag:      true,
  lastModified: true,
  setHeaders: (res) => {
    // Prevent caching for sensitive uploads (payment screenshots)
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// ══════════════════════════════════════════════════════════
//   18. API ROUTES
// ══════════════════════════════════════════════════════════
app.use('/api/v1', routes);

// ══════════════════════════════════════════════════════════
//   19. ROOT ROUTE
// ══════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    success:  true,
    message:  '🛍️ Welcome to An Shop API',
    version:  'v1',
    docs:     '/api/v1/docs',
    health:   '/api/v1/health',
    environment: process.env.NODE_ENV || 'development',
  });
});

// ══════════════════════════════════════════════════════════
//   20. ERROR HANDLERS (must be last)
// ══════════════════════════════════════════════════════════
app.use(notFoundHandler);
app.use(globalErrorHandler);

module.exports = app;
