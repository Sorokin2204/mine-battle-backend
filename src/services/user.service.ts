import { PrismaClient, User } from '@prisma/client';
import { TelegramInitData, UserPublic, UserWithBalance } from '../types';

const prisma = new PrismaClient();

const getDevAvatarUrl = (telegramId: string): string => {
  const devUserNumber = Number(telegramId.split('_').pop());
  const avatarId = Number.isInteger(devUserNumber) ? devUserNumber : 1;

  return `https://i.pravatar.cc/150?img=${avatarId}`;
};

export async function findOrCreateUser(telegramData: TelegramInitData): Promise<User> {
  const telegramId = telegramData.user!.id.toString();

  let user = await prisma.user.findUnique({
    where: { telegramId },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        username: telegramData.user!.username || null,
        firstName: telegramData.user!.first_name || null,
        lastName: telegramData.user!.last_name || null,
        photoUrl: telegramData.user!.photo_url || null,
        balance: 1000, // Starting balance for new users
      },
    });
  } else {
    // Update user info if changed
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        username: telegramData.user!.username || user.username,
        firstName: telegramData.user!.first_name || user.firstName,
        lastName: telegramData.user!.last_name || user.lastName,
        photoUrl: telegramData.user!.photo_url || user.photoUrl,
      },
    });
  }

  return user;
}

export async function findOrCreateDevUser(telegramId: string): Promise<User> {
  let user = await prisma.user.findUnique({
    where: { telegramId },
  });

  const photoUrl = getDevAvatarUrl(telegramId);

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        username: `dev_${telegramId}`,
        firstName: `Dev User ${telegramId.split('_').pop()}`,
        photoUrl,
        balance: 10000, // More balance for dev users
      },
    });
  } else if (user.photoUrl !== photoUrl) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { photoUrl },
    });
  }

  return user;
}

export async function getUserById(userId: number): Promise<User | null> {
  return prisma.user.findUnique({
    where: { id: userId },
  });
}

export async function getUserBalance(userId: number): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { balance: true },
  });
  return user?.balance ?? 0;
}

export async function updateUserBalance(
  userId: number,
  amount: number,
  operation: 'add' | 'subtract'
): Promise<User> {
  const increment = operation === 'add' ? amount : -amount;

  return prisma.user.update({
    where: { id: userId },
    data: {
      balance: {
        increment,
      },
    },
  });
}

export function toUserPublic(user: User): UserPublic {
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    photoUrl: user.photoUrl,
  };
}

export function toUserWithBalance(user: User): UserWithBalance {
  return {
    ...toUserPublic(user),
    balance: user.balance,
  };
}
