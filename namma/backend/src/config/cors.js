import { env } from './environment.js';

// Regex for dev: localhost, 127.0.0.1, 192.168.x.x, 10.x.x.x, 172.16-31.x.x on ports 8081/19006 (or standard ports)
const DEV_LAN_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:(8081|19006))?$/;

export const isOriginAllowed = (origin) => {
  // Allow requests without Origin (mobile native apps, curl, server-to-server)
  if (!origin) return true;

  if (env.NODE_ENV === 'production') {
    const allowed = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : [];
    return allowed.includes(origin);
  }

  // Dev only: allow localhost and private LAN origins on ports 8081/19006
  return DEV_LAN_ORIGIN_REGEX.test(origin);
};

export const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS origin not allowed: ${origin}`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};
