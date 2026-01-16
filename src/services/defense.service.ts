import { PrismaClient, Defense, DefenseStatus, GameResult, MoveType } from '@prisma/client';
import { defaultGameConfig } from '../config/game.config';
import { DefensePublic, MoveResult, ScannerResult, RadarResult } from '../types';
import { toUserPublic } from './user.service';

const prisma = new PrismaClient();

export async function createDefense(
  creatorId: number,
  bet: number,
  bombPositions: number[]
): Promise<Defense> {
  const config = defaultGameConfig;

  // Validate bomb positions
  if (bombPositions.length !== config.bombsCount) {
    throw new Error(`Must place exactly ${config.bombsCount} bombs`);
  }

  const fieldSize = config.fieldSize * config.fieldSize;
  const uniquePositions = new Set(bombPositions);
  if (uniquePositions.size !== bombPositions.length) {
    throw new Error('Bomb positions must be unique');
  }

  for (const pos of bombPositions) {
    if (pos < 0 || pos >= fieldSize) {
      throw new Error(`Invalid bomb position: ${pos}`);
    }
  }

  // Validate bet
  if (bet < config.minBet || bet > config.maxBet) {
    throw new Error(`Bet must be between ${config.minBet} and ${config.maxBet}`);
  }

  // Create defense with transaction
  return prisma.$transaction(async (tx) => {
    // Check user balance
    const user = await tx.user.findUnique({
      where: { id: creatorId },
      select: { balance: true },
    });

    if (!user || user.balance < bet) {
      throw new Error('Insufficient balance');
    }

    // Deduct balance
    await tx.user.update({
      where: { id: creatorId },
      data: { balance: { decrement: bet } },
    });

    // Create defense
    const defense = await tx.defense.create({
      data: {
        creatorId,
        bet,
        bombPositions,
        expiresAt: new Date(Date.now() + config.defenseLifetime),
      },
      include: {
        creator: true,
        attacker: true,
      },
    });

    // Create transaction record
    await tx.transaction.create({
      data: {
        userId: creatorId,
        defenseId: defense.id,
        type: 'DEFENSE_CREATE',
        amount: bet,
        balanceBefore: user.balance,
        balanceAfter: user.balance - bet,
        description: `Created defense #${defense.id}`,
      },
    });

    return defense;
  });
}

export async function getActiveDefenses(): Promise<Defense[]> {
  return prisma.defense.findMany({
    where: {
      status: {
        in: [DefenseStatus.WAITING, DefenseStatus.IN_PROGRESS],
      },
      expiresAt: {
        gt: new Date(),
      },
    },
    include: {
      creator: true,
      attacker: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

export async function getAllDefenses(includeFinished: boolean = false): Promise<Defense[]> {
  if (!includeFinished) {
    return getActiveDefenses();
  }

  return prisma.defense.findMany({
    where: {
      status: {
        in: [DefenseStatus.WAITING, DefenseStatus.IN_PROGRESS, DefenseStatus.FINISHED],
      },
    },
    include: {
      creator: true,
      attacker: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

export async function getDefenseById(defenseId: number): Promise<Defense | null> {
  return prisma.defense.findUnique({
    where: { id: defenseId },
    include: {
      creator: true,
      attacker: true,
      moves: true,
    },
  });
}

export async function startAttack(defenseId: number, attackerId: number): Promise<Defense> {
  const config = defaultGameConfig;

  return prisma.$transaction(async (tx) => {
    const defense = await tx.defense.findUnique({
      where: { id: defenseId },
      include: { creator: true },
    });

    if (!defense) {
      throw new Error('Defense not found');
    }

    if (defense.status !== DefenseStatus.WAITING) {
      throw new Error('Defense is not available for attack');
    }

    if (defense.creatorId === attackerId) {
      throw new Error('Cannot attack your own defense');
    }

    if (defense.expiresAt < new Date()) {
      throw new Error('Defense has expired');
    }

    // Check attacker balance
    const attacker = await tx.user.findUnique({
      where: { id: attackerId },
      select: { balance: true },
    });

    if (!attacker || attacker.balance < defense.bet) {
      throw new Error('Insufficient balance');
    }

    // Deduct attacker balance
    await tx.user.update({
      where: { id: attackerId },
      data: { balance: { decrement: defense.bet } },
    });

    const now = new Date();
    const moveDeadline = new Date(now.getTime() + config.moveTime);

    // Update defense
    const updatedDefense = await tx.defense.update({
      where: { id: defenseId },
      data: {
        attackerId,
        status: DefenseStatus.IN_PROGRESS,
        attackStartedAt: now,
        moveDeadline,
      },
      include: {
        creator: true,
        attacker: true,
      },
    });

    // Create transaction record
    await tx.transaction.create({
      data: {
        userId: attackerId,
        defenseId,
        type: 'ATTACK_BET',
        amount: defense.bet,
        balanceBefore: attacker.balance,
        balanceAfter: attacker.balance - defense.bet,
        description: `Attacked defense #${defenseId}`,
      },
    });

    return updatedDefense;
  });
}

export async function makeMove(
  defenseId: number,
  attackerId: number,
  moveType: MoveType,
  position?: number,
  positions?: number[]
): Promise<MoveResult> {
  const config = defaultGameConfig;

  return prisma.$transaction(async (tx) => {
    const defense = await tx.defense.findUnique({
      where: { id: defenseId },
    });

    if (!defense) {
      throw new Error('Defense not found');
    }

    if (defense.status !== DefenseStatus.IN_PROGRESS) {
      throw new Error('Game is not in progress');
    }

    if (defense.attackerId !== attackerId) {
      throw new Error('You are not the attacker');
    }

    // Check move deadline
    if (defense.moveDeadline && defense.moveDeadline < new Date()) {
      // Time expired - defender wins
      const finishedDefense = await finishGame(tx, defenseId, GameResult.TIMEOUT, defense.creatorId);
      return {
        success: false,
        moveType,
        bombsFound: defense.bombsFound,
        attemptsUsed: defense.attemptsUsed,
        scannersUsed: defense.scannersUsed,
        radarsUsed: defense.radarsUsed,
        gameFinished: true,
        result: GameResult.TIMEOUT,
        revealedCells: defense.revealedCells,
      };
    }

    let result: MoveResult;

    switch (moveType) {
      case MoveType.CLICK:
        result = await processClickMove(tx, defense, position!, config);
        break;
      case MoveType.SCANNER:
        result = await processScannerMove(tx, defense, positions!, config);
        break;
      case MoveType.RADAR:
        result = await processRadarMove(tx, defense, position!, config);
        break;
      default:
        throw new Error('Invalid move type');
    }

    // Record move
    await tx.move.create({
      data: {
        defenseId,
        playerId: attackerId,
        moveType,
        position: position ?? null,
        positions: positions ?? [],
        result: result as any,
      },
    });

    return result;
  });
}

async function processClickMove(
  tx: any,
  defense: Defense,
  position: number,
  config: typeof defaultGameConfig
): Promise<MoveResult> {
  if (defense.attemptsUsed >= config.attempts) {
    throw new Error('No attempts left');
  }

  if (defense.revealedCells.includes(position)) {
    throw new Error('Cell already revealed');
  }

  const isBomb = defense.bombPositions.includes(position);
  const newRevealedCells = [...defense.revealedCells, position];
  const newBombsFound = isBomb ? defense.bombsFound + 1 : defense.bombsFound;
  const newAttemptsUsed = defense.attemptsUsed + 1;

  // Check if game should end
  let gameFinished = false;
  let gameResult: GameResult | undefined;
  let winnerId: number | undefined;

  if (newBombsFound >= config.bombsCount) {
    // Attacker found all bombs - wins
    gameFinished = true;
    gameResult = GameResult.ATTACKER_WIN;
    winnerId = defense.attackerId!;
  } else if (newAttemptsUsed >= config.attempts) {
    // No more attempts - defender wins
    gameFinished = true;
    gameResult = GameResult.DEFENDER_WIN;
    winnerId = defense.creatorId;
  }

  if (gameFinished) {
    await finishGame(tx, defense.id, gameResult!, winnerId!);
  } else {
    // Reset move timer
    await tx.defense.update({
      where: { id: defense.id },
      data: {
        revealedCells: newRevealedCells,
        bombsFound: newBombsFound,
        attemptsUsed: newAttemptsUsed,
        moveDeadline: new Date(Date.now() + config.moveTime),
      },
    });
  }

  return {
    success: true,
    moveType: MoveType.CLICK,
    position,
    isBomb,
    bombsFound: newBombsFound,
    attemptsUsed: newAttemptsUsed,
    scannersUsed: defense.scannersUsed,
    radarsUsed: defense.radarsUsed,
    gameFinished,
    result: gameResult,
    revealedCells: newRevealedCells,
  };
}

async function processScannerMove(
  tx: any,
  defense: Defense,
  positions: number[],
  config: typeof defaultGameConfig
): Promise<MoveResult> {
  if (defense.scannersUsed >= config.scanners) {
    throw new Error('No scanners left');
  }

  // Validate scanner positions (2x2 area)
  if (positions.length !== 4) {
    throw new Error('Scanner must cover exactly 4 cells');
  }

  // Count bombs in scanner area
  const bombCount = positions.filter((pos) => defense.bombPositions.includes(pos)).length;

  const scannerResult: ScannerResult = { positions, bombCount };
  const existingResults = (defense.scannerResults as ScannerResult[]) || [];
  const newScannerResults = [...existingResults, scannerResult];

  await tx.defense.update({
    where: { id: defense.id },
    data: {
      scannersUsed: defense.scannersUsed + 1,
      scannerResults: newScannerResults,
      moveDeadline: new Date(Date.now() + config.moveTime),
    },
  });

  return {
    success: true,
    moveType: MoveType.SCANNER,
    positions,
    bombCount,
    bombsFound: defense.bombsFound,
    attemptsUsed: defense.attemptsUsed,
    scannersUsed: defense.scannersUsed + 1,
    radarsUsed: defense.radarsUsed,
    gameFinished: false,
    revealedCells: defense.revealedCells,
  };
}

async function processRadarMove(
  tx: any,
  defense: Defense,
  position: number,
  config: typeof defaultGameConfig
): Promise<MoveResult> {
  if (defense.radarsUsed >= config.radars) {
    throw new Error('No radars left');
  }

  // Position encodes row/column: 0-3 for rows, 4-7 for columns
  const isRow = position < config.fieldSize;
  const index = isRow ? position : position - config.fieldSize;

  // Count bombs in row/column
  let bombCount = 0;
  for (const bombPos of defense.bombPositions) {
    const bombRow = Math.floor(bombPos / config.fieldSize);
    const bombCol = bombPos % config.fieldSize;

    if (isRow && bombRow === index) {
      bombCount++;
    } else if (!isRow && bombCol === index) {
      bombCount++;
    }
  }

  const radarResult: RadarResult = {
    type: isRow ? 'row' : 'column',
    index,
    bombCount,
  };
  const existingResults = (defense.radarResults as RadarResult[]) || [];
  const newRadarResults = [...existingResults, radarResult];

  await tx.defense.update({
    where: { id: defense.id },
    data: {
      radarsUsed: defense.radarsUsed + 1,
      radarResults: newRadarResults,
      moveDeadline: new Date(Date.now() + config.moveTime),
    },
  });

  return {
    success: true,
    moveType: MoveType.RADAR,
    position,
    bombCount,
    bombsFound: defense.bombsFound,
    attemptsUsed: defense.attemptsUsed,
    scannersUsed: defense.scannersUsed,
    radarsUsed: defense.radarsUsed + 1,
    gameFinished: false,
    revealedCells: defense.revealedCells,
  };
}

export async function takeHalf(defenseId: number, attackerId: number): Promise<Defense> {
  return prisma.$transaction(async (tx) => {
    const defense = await tx.defense.findUnique({
      where: { id: defenseId },
      include: { creator: true, attacker: true },
    });

    if (!defense) {
      throw new Error('Defense not found');
    }

    if (defense.status !== DefenseStatus.IN_PROGRESS) {
      throw new Error('Game is not in progress');
    }

    if (defense.attackerId !== attackerId) {
      throw new Error('You are not the attacker');
    }

    if (defense.bombsFound < 1) {
      throw new Error('Must find at least 1 bomb to take half');
    }

    const halfBet = Math.floor(defense.bet / 2);
    const totalPot = defense.bet * 2;
    const attackerWinnings = halfBet;
    const defenderReturn = totalPot - halfBet;

    // Pay attacker
    const attacker = await tx.user.update({
      where: { id: attackerId },
      data: { balance: { increment: attackerWinnings } },
    });

    // Pay defender
    const creator = await tx.user.update({
      where: { id: defense.creatorId },
      data: { balance: { increment: defenderReturn } },
    });

    // Update defense
    const updatedDefense = await tx.defense.update({
      where: { id: defenseId },
      data: {
        status: DefenseStatus.FINISHED,
        result: GameResult.ATTACKER_TOOK_HALF,
        finishedAt: new Date(),
      },
      include: {
        creator: true,
        attacker: true,
      },
    });

    // Create transaction records
    await tx.transaction.create({
      data: {
        userId: attackerId,
        defenseId,
        type: 'TAKE_HALF',
        amount: attackerWinnings,
        balanceBefore: attacker.balance - attackerWinnings,
        balanceAfter: attacker.balance,
        description: `Took half from defense #${defenseId}`,
      },
    });

    await tx.transaction.create({
      data: {
        userId: defense.creatorId,
        defenseId,
        type: 'WIN',
        amount: defenderReturn,
        balanceBefore: creator.balance - defenderReturn,
        balanceAfter: creator.balance,
        description: `Partial win from defense #${defenseId}`,
      },
    });

    return updatedDefense;
  });
}

async function finishGame(
  tx: any,
  defenseId: number,
  result: GameResult,
  winnerId: number
): Promise<Defense> {
  const defense = await tx.defense.findUnique({
    where: { id: defenseId },
  });

  if (!defense) {
    throw new Error('Defense not found');
  }

  const totalPot = defense.bet * 2;

  // Pay winner
  const winner = await tx.user.update({
    where: { id: winnerId },
    data: { balance: { increment: totalPot } },
  });

  // Update defense
  const updatedDefense = await tx.defense.update({
    where: { id: defenseId },
    data: {
      status: DefenseStatus.FINISHED,
      result,
      winnerId,
      finishedAt: new Date(),
    },
    include: {
      creator: true,
      attacker: true,
    },
  });

  // Create transaction record
  await tx.transaction.create({
    data: {
      userId: winnerId,
      defenseId,
      type: 'WIN',
      amount: totalPot,
      balanceBefore: winner.balance - totalPot,
      balanceAfter: winner.balance,
      description: `Won defense #${defenseId}`,
    },
  });

  const loserId = winnerId === defense.creatorId ? defense.attackerId : defense.creatorId;
  if (loserId) {
    await tx.transaction.create({
      data: {
        userId: loserId,
        defenseId,
        type: 'LOSS',
        amount: defense.bet,
        balanceBefore: 0, // Already deducted
        balanceAfter: 0,
        description: `Lost defense #${defenseId}`,
      },
    });
  }

  return updatedDefense;
}

export async function expireDefense(defenseId: number): Promise<Defense> {
  return prisma.$transaction(async (tx) => {
    const defense = await tx.defense.findUnique({
      where: { id: defenseId },
    });

    if (!defense) {
      throw new Error('Defense not found');
    }

    if (defense.status !== DefenseStatus.WAITING) {
      throw new Error('Defense cannot be expired');
    }

    // Refund creator
    const creator = await tx.user.update({
      where: { id: defense.creatorId },
      data: { balance: { increment: defense.bet } },
    });

    // Update defense
    const updatedDefense = await tx.defense.update({
      where: { id: defenseId },
      data: {
        status: DefenseStatus.EXPIRED,
        result: GameResult.EXPIRED,
        finishedAt: new Date(),
      },
      include: {
        creator: true,
        attacker: true,
      },
    });

    // Create refund transaction
    await tx.transaction.create({
      data: {
        userId: defense.creatorId,
        defenseId,
        type: 'DEFENSE_REFUND',
        amount: defense.bet,
        balanceBefore: creator.balance - defense.bet,
        balanceAfter: creator.balance,
        description: `Defense #${defenseId} expired - refund`,
      },
    });

    return updatedDefense;
  });
}

export function toDefensePublic(defense: Defense & { creator: any; attacker: any | null }, isParticipant: boolean = false): DefensePublic {
  return {
    id: defense.id,
    creator: toUserPublic(defense.creator),
    attacker: defense.attacker ? toUserPublic(defense.attacker) : null,
    bet: defense.bet,
    status: defense.status,
    expiresAt: defense.expiresAt,
    attackStartedAt: defense.attackStartedAt,
    moveDeadline: defense.moveDeadline,
    attemptsUsed: defense.attemptsUsed,
    scannersUsed: defense.scannersUsed,
    radarsUsed: defense.radarsUsed,
    bombsFound: defense.bombsFound,
    revealedCells: defense.revealedCells,
    scannerResults: defense.scannerResults as ScannerResult[] | null,
    radarResults: defense.radarResults as RadarResult[] | null,
    result: defense.result,
    winnerId: defense.winnerId,
    createdAt: defense.createdAt,
    finishedAt: defense.finishedAt,
    // Only reveal bomb positions if game is finished or user is the creator
    bombPositions: defense.status === DefenseStatus.FINISHED ? defense.bombPositions : undefined,
  };
}
