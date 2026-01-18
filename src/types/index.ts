import { DefenseStatus, GameResult, MoveType } from '@prisma/client';

// DifficultyLevel is also defined in Prisma schema - keep in sync
export type DifficultyLevel = 'EASY' | 'MEDIUM' | 'HARD';

export interface JwtPayload {
  userId: number;
  telegramId: string;
}

export interface TelegramInitData {
  query_id?: string;
  user?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
    photo_url?: string;
  };
  auth_date: number;
  hash: string;
}

export interface AuthenticatedSocket {
  userId: number;
  telegramId: string;
}

export interface UserPublic {
  id: number;
  username: string | null;
  firstName: string | null;
  photoUrl: string | null;
}

export interface DefensePublic {
  id: number;
  creator: UserPublic;
  attacker: UserPublic | null;
  bet: number;
  difficulty: DifficultyLevel;
  status: DefenseStatus;
  expiresAt: Date;
  attackStartedAt: Date | null;
  moveDeadline: Date | null;
  attemptsUsed: number;
  scannersUsed: number;
  radarsUsed: number;
  bombsFound: number;
  revealedCells: number[];
  foundBombPositions: number[]; // Positions where bombs were found during game
  scannerResults: ScannerResult[] | null;
  radarResults: RadarResult[] | null;
  result: GameResult | null;
  winnerId: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  bombPositions?: number[];
}

export interface ScannerResult {
  positions: number[];
  bombCount: number;
}

export interface RadarResult {
  type: 'row' | 'column';
  index: number;
  bombCount: number;
}

export interface MoveResult {
  success: boolean;
  moveType: MoveType;
  position?: number;
  positions?: number[];
  isBomb?: boolean;
  bombCount?: number;
  bombsFound: number;
  attemptsUsed: number;
  scannersUsed: number;
  radarsUsed: number;
  gameFinished: boolean;
  result?: GameResult;
  revealedCells: number[];
}

export interface GetDefensesData {
  includeFinished?: boolean;
  includeExpired?: boolean;
}

// Socket Events - Client to Server
export interface ClientToServerEvents {
  createDefense: (data: CreateDefenseData, callback: (response: SocketResponse<DefensePublic>) => void) => void;
  attackDefense: (data: AttackDefenseData, callback: (response: SocketResponse<DefensePublic>) => void) => void;
  makeMove: (data: MakeMoveData, callback: (response: SocketResponse<MoveResult>) => void) => void;
  takeHalf: (data: TakeHalfData, callback: (response: SocketResponse<DefensePublic>) => void) => void;
  getDefenses: (dataOrCallback: GetDefensesData | ((response: SocketResponse<DefensePublic[]>) => void), callback?: (response: SocketResponse<DefensePublic[]>) => void) => void;
  getDefense: (data: { defenseId: number }, callback: (response: SocketResponse<DefensePublic>) => void) => void;
  joinDefenseRoom: (data: { defenseId: number }) => void;
  leaveDefenseRoom: (data: { defenseId: number }) => void;
  getMe: (callback: (response: SocketResponse<UserWithBalance>) => void) => void;
  startMatchmaking: (data: StartMatchmakingData, callback: (response: SocketResponse<MatchmakingResponse>) => void) => void;
  stopMatchmaking: (callback: (response: SocketResponse<null>) => void) => void;
}

// Socket Events - Server to Client
export interface ServerToClientEvents {
  defenseCreated: (defense: DefensePublic) => void;
  defenseUpdated: (defense: DefensePublic) => void;
  defenseRemoved: (defenseId: number) => void;
  gameStarted: (defense: DefensePublic) => void;
  moveMade: (data: { defenseId: number; move: MoveResult }) => void;
  gameFinished: (defense: DefensePublic) => void;
  timerUpdate: (data: { defenseId: number; timeLeft: number; type: 'move' | 'defense' }) => void;
  balanceUpdated: (data: { balance: number }) => void;
  error: (data: { message: string; code?: string }) => void;
  matchFound: (data: { defenseId: number; defense: DefensePublic }) => void;
  matchmakingStarted: (data: { queuePosition: number }) => void;
}

export interface CreateDefenseData {
  bet: number;
  bombPositions: number[];
  difficulty: DifficultyLevel;
}

export interface AttackDefenseData {
  defenseId: number;
}

export interface MakeMoveData {
  defenseId: number;
  moveType: MoveType;
  position?: number;
  positions?: number[];
}

export interface TakeHalfData {
  defenseId: number;
}

export interface StartMatchmakingData {
  minBet: number;
  maxBet: number;
  difficulty?: DifficultyLevel;
}

export interface MatchmakingResponse {
  queuePosition: number;
}

export interface SocketResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

export interface UserWithBalance extends UserPublic {
  balance: number;
}

export interface InterServerEvents {}

export interface SocketData {
  userId: number;
  telegramId: string;
}
