export type DifficultyLevel = 'EASY' | 'MEDIUM' | 'HARD';

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

export const difficultyConfigs: Record<DifficultyLevel, GameConfig> = {
  EASY: {
    fieldSize: 3,
    bombsCount: 2,
    attempts: 2,
    scanners: 1,
    radars: 2,
    moveTime: 3600000,
    defenseLifetime: 1200000,
    resultsDisplayTime: 10000,
    minBet: 20,
    maxBet: 10000,
    quickBets: [20, 50, 100, 200],
  },
  MEDIUM: {
    fieldSize: 4,
    bombsCount: 1,
    attempts: 1,
    scanners: 1,
    radars: 2,
    moveTime: 3600000,
    defenseLifetime: 1200000,
    resultsDisplayTime: 10000,
    minBet: 20,
    maxBet: 10000,
    quickBets: [20, 50, 100, 200],
  },
  HARD: {
    fieldSize: 5,
    bombsCount: 3,
    attempts: 5,
    scanners: 2,
    radars: 3,
    moveTime: 3600000,
    defenseLifetime: 1200000,
    resultsDisplayTime: 10000,
    minBet: 20,
    maxBet: 10000,
    quickBets: [20, 50, 100, 200],
  },
};

export const getConfigByDifficulty = (difficulty: DifficultyLevel): GameConfig => {
  return difficultyConfigs[difficulty];
};

// Default config for backwards compatibility
export const defaultGameConfig: GameConfig = difficultyConfigs.MEDIUM;

export const serverConfig = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  // `true` reflects the requesting origin. It is convenient for devices on
  // the local Wi-Fi network during development; use an explicit URL in
  // production.
  corsOrigin: process.env.CORS_ORIGIN === 'true' ? true : process.env.CORS_ORIGIN || 'http://localhost:3000',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  devMode: process.env.NODE_ENV !== 'production',
  rateLimitWindow: 60000,
  rateLimitMax: 100,
};
