/**
 * utils/logger.js
 * ================
 * Winston logger with daily log rotation, structured JSON output,
 * and colorized console output for development.
 */

'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// ─── Ensure log directory exists ──────────────────────────────────────────────
const LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ─── Custom Log Format ────────────────────────────────────────────────────────
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'label'] }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0 && meta.metadata && Object.keys(meta.metadata).length > 0) {
      log += `\n${JSON.stringify(meta.metadata, null, 2)}`;
    }
    if (stack) log += `\n${stack}`;
    return log;
  })
);

// ─── Transport: Daily Rotating Files ──────────────────────────────────────────
const fileTransportOptions = {
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: process.env.LOG_MAX_SIZE || '20m',
  maxFiles: process.env.LOG_MAX_FILES || '14d',
  format: logFormat,
};

const transports = [
  // All logs
  new DailyRotateFile({
    filename: path.join(LOG_DIR, 'combined-%DATE%.log'),
    ...fileTransportOptions,
  }),
  // Errors only
  new DailyRotateFile({
    filename: path.join(LOG_DIR, 'error-%DATE%.log'),
    level: 'error',
    ...fileTransportOptions,
  }),
];

// ─── Console Transport (Non-production) ───────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );
}

// ─── Logger Instance ──────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: {
    service: process.env.APP_NAME || 'an-shop-api',
    environment: process.env.NODE_ENV || 'development',
  },
  transports,
  exitOnError: false,
  silent: process.env.NODE_ENV === 'test', // Silence during tests
});

// ─── Morgan Stream Integration ────────────────────────────────────────────────
const morganStream = {
  write: (message) => {
    logger.http(message.trim());
  },
};

// ─── Helper: Log structured API events ───────────────────────────────────────
logger.apiEvent = (event, data = {}) => {
  logger.info(`[API_EVENT] ${event}`, data);
};

logger.securityEvent = (event, data = {}) => {
  logger.warn(`[SECURITY] ${event}`, data);
};

logger.perfEvent = (event, durationMs, data = {}) => {
  logger.debug(`[PERF] ${event} - ${durationMs}ms`, data);
};

module.exports = logger;
module.exports.morganStream = morganStream;
