import pino from 'pino';

import { env, isProduction } from './env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : isProduction ? 'info' : 'debug',
  // Ne jamais logger de secret, même par accident.
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.passwordHash', '*.tokenHash'],
});
