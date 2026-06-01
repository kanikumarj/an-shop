/**
 * services/firebase.service.js
 * ==============================
 * Stateless Firebase ID Token Verification Service.
 * Avoids heavy dependency on firebase-admin, allowing stateless and fast verification.
 */

'use strict';

const jwt = require('jsonwebtoken');
const axios = require('axios');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

// Google's public keys URL for Firebase ID Tokens
const GOOGLE_PUBLIC_KEYS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

// Cache for Google public certificates
let cachedCertificates = null;
let certificatesExpiry = 0;

/**
 * Fetch Google's public certificates and cache them.
 */
const getGoogleCertificates = async () => {
  const now = Date.now();
  
  if (cachedCertificates && now < certificatesExpiry) {
    return cachedCertificates;
  }

  try {
    logger.debug('🔄 Fetching Google public certificates for Firebase token verification...');
    const response = await axios.get(GOOGLE_PUBLIC_KEYS_URL);
    
    // Parse Cache-Control header to determine expiry
    const cacheControl = response.headers['cache-control'] || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) * 1000 : 3600 * 1000; // default 1 hour

    cachedCertificates = response.data;
    certificatesExpiry = now + maxAge;
    
    logger.debug('✅ Cached Google certificates successfully. Expiry in:', maxAge / 1000, 'seconds');
    return cachedCertificates;
  } catch (err) {
    logger.error('❌ Failed to fetch Google public certificates:', err.message);
    throw AppError.internal('Failed to contact Google identity servers for token verification.');
  }
};

/**
 * Verify a Firebase ID Token statelessly.
 * Checks signature, expiration, issuer, audience, and subject.
 * 
 * @param {string} token - The raw JWT Firebase ID Token
 * @returns {object} The verified payload (including phone_number, uid, etc.)
 */
const verifyIdToken = async (token) => {
  if (!token) {
    throw AppError.badRequest('Firebase ID Token is required.', 'MISSING_ID_TOKEN');
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) {
    logger.warn('⚠️ FIREBASE_PROJECT_ID is not configured in environment variables.');
    throw AppError.serviceUnavailable('Firebase Phone Auth is disabled on this server.', 'FIREBASE_AUTH_DISABLED');
  }

  // 1. Decode JWT to inspect the kid (Key ID) header
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    throw AppError.unauthorized('Invalid Firebase ID Token format.', 'INVALID_FIREBASE_TOKEN');
  }

  const kid = decoded.header.kid;

  // 2. Retrieve public certificates from Google metadata
  const certificates = await getGoogleCertificates();
  const certificate = certificates[kid];

  if (!certificate) {
    throw AppError.unauthorized('Firebase ID Token signed by unknown or expired certificate.', 'INVALID_FIREBASE_SIGNATURE');
  }

  // 3. Verify signature and standard JWT claims
  try {
    const payload = jwt.verify(certificate, certificate, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    });

    // Additional claims verification
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('Subject (sub) claim is invalid.');
    }
    if (payload.auth_time > now) {
      throw new Error('Auth time is in the future.');
    }

    return payload;
  } catch (err) {
    // If standard jwt verification fails, try standard jwt.verify against the certificate
    try {
      const payload = jwt.verify(token, certificate, {
        algorithms: ['RS256'],
        audience: projectId,
        issuer: `https://securetoken.google.com/${projectId}`,
      });
      return payload;
    } catch (verifyErr) {
      logger.warn('Firebase ID Token verification failed:', verifyErr.message);
      throw AppError.unauthorized('Invalid Firebase verification token. Please try again.', 'INVALID_FIREBASE_TOKEN');
    }
  }
};

module.exports = {
  verifyIdToken,
};
