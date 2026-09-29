import { PrismaClient, DefenseStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create test users
  const testUsers = [
    { telegramId: 'dev_user_1', username: 'dev_user_1', firstName: 'Алексей', avatarId: 1 },
    { telegramId: 'dev_user_2', username: 'dev_user_2', firstName: 'Мария', avatarId: 2 },
    { telegramId: 'dev_user_3', username: 'dev_user_3', firstName: 'Дмитрий', avatarId: 3 },
    { telegramId: 'dev_user_4', username: 'dev_user_4', firstName: 'Анна', avatarId: 4 },
  ];

  const users = await Promise.all(
    testUsers.map(({ telegramId, username, firstName, avatarId }) => {
      const photoUrl = `https://i.pravatar.cc/150?img=${avatarId}`;

      return prisma.user.upsert({
        where: { telegramId },
        update: { photoUrl },
        create: {
          telegramId,
          username,
          firstName,
          photoUrl,
          balance: 10000,
        },
      });
    })
  );

  console.log(`Created ${users.length} test users`);

  // Create game config
  await prisma.gameConfig.upsert({
    where: { key: 'default' },
    update: {},
    create: {
      key: 'default',
      value: {
        fieldSize: 4,
        bombsCount: 2,
        attempts: 4,
        scanners: 1,
        radars: 1,
        moveTime: 1200000,
        defenseLifetime: 3600000,
        resultsDisplayTime: 10000,
        minBet: 20,
        maxBet: 10000,
        quickBets: [20, 50, 100, 200],
      },
      description: 'Default game configuration',
    },
  });

  console.log('Created game config');

  // Create some test defenses
  const oneHourFromNow = new Date(Date.now() + 3600000);

  const defenses = await Promise.all([
    prisma.defense.create({
      data: {
        creatorId: users[0].id,
        bet: 50,
        bombPositions: [5, 10],
        status: DefenseStatus.WAITING,
        expiresAt: oneHourFromNow,
      },
    }),
    prisma.defense.create({
      data: {
        creatorId: users[1].id,
        bet: 100,
        bombPositions: [0, 15],
        status: DefenseStatus.WAITING,
        expiresAt: oneHourFromNow,
      },
    }),
    prisma.defense.create({
      data: {
        creatorId: users[2].id,
        bet: 200,
        bombPositions: [3, 12],
        status: DefenseStatus.WAITING,
        expiresAt: oneHourFromNow,
      },
    }),
    prisma.defense.create({
      data: {
        creatorId: users[3].id,
        bet: 20,
        bombPositions: [7, 8],
        status: DefenseStatus.WAITING,
        expiresAt: oneHourFromNow,
      },
    }),
  ]);

  console.log(`Created ${defenses.length} test defenses`);

  // Create transactions for defense creation
  for (let i = 0; i < defenses.length; i++) {
    await prisma.transaction.create({
      data: {
        userId: users[i].id,
        defenseId: defenses[i].id,
        type: 'DEFENSE_CREATE',
        amount: defenses[i].bet,
        balanceBefore: 10000,
        balanceAfter: 10000 - defenses[i].bet,
        description: `Created defense #${defenses[i].id}`,
      },
    });

    // Update user balance
    await prisma.user.update({
      where: { id: users[i].id },
      data: { balance: 10000 - defenses[i].bet },
    });
  }

  console.log('Created transactions and updated balances');

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
