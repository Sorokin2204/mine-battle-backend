export interface GameConfig {
  fieldSize: number;
  bombsCount: number;
  attempts: number;
  scanners: number;
  radars: number;
  moveTime: number;
  defenseLifetime: number;
  resultsDisplayTime: number;
  minBet: number;
  maxBet: number;
  quickBets: number[];
}

export const defaultGameConfig: GameConfig = {
  fieldSize: 4,
  bombsCount: 2,
  attempts: 4,
  scanners: 1,
  radars: 1,
  moveTime: 120000,
  defenseLifetime: 3600000,
  resultsDisplayTime: 10000,
  minBet: 20,
  maxBet: 10000,
  quickBets: [20, 50, 100, 200],
};

export const serverConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  devMode: process.env.NODE_ENV !== 'production',
  rateLimitWindow: 60000,
  rateLimitMax: 100,
};
