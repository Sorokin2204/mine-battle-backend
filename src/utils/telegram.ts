import crypto from 'crypto';
import { TelegramInitData } from '../types';
import { serverConfig } from '../config/game.config';

export function validateTelegramWebAppData(initData: string): TelegramInitData | null {
  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');

    if (!hash) {
      return null;
    }

    urlParams.delete('hash');
    const dataCheckArr: string[] = [];

    urlParams.sort();
    urlParams.forEach((value, key) => {
      dataCheckArr.push(`${key}=${value}`);
    });

    const dataCheckString = dataCheckArr.join('\n');
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(serverConfig.telegramBotToken)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (calculatedHash !== hash) {
      return null;
    }

    const userStr = urlParams.get('user');
    const authDateStr = urlParams.get('auth_date');

    if (!userStr || !authDateStr) {
      return null;
    }

    const user = JSON.parse(userStr);
    const authDate = parseInt(authDateStr, 10);

    // Check if auth_date is not too old (24 hours)
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) {
      return null;
    }

    return {
      query_id: urlParams.get('query_id') || undefined,
      user,
      auth_date: authDate,
      hash,
    };
  } catch {
    return null;
  }
}

export function generateDevToken(code: string): { userId: number; telegramId: string } | null {
  // Dev codes: 1001, 1002, 1003, 1004 for test users
  const validCodes: Record<string, { userId: number; telegramId: string }> = {
    '1001': { userId: 1, telegramId: 'dev_user_1' },
    '1002': { userId: 2, telegramId: 'dev_user_2' },
    '1003': { userId: 3, telegramId: 'dev_user_3' },
    '1004': { userId: 4, telegramId: 'dev_user_4' },
  };

  return validCodes[code] || null;
}
