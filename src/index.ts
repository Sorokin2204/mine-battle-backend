import Fastify from 'fastify';
import cors from '@fastify/cors';
import { PrismaClient } from '@prisma/client';
import { initializeSocket } from './socket';
import { serverConfig } from './config/game.config';
import { generateToken } from './utils/jwt';
import * as dotenv from 'dotenv';
import { validateTelegramWebAppData, generateDevToken } from './utils/telegram';
import { findOrCreateUser, findOrCreateDevUser } from './services/user.service';
import { timerService } from './services/timer.service';
dotenv.config();
const prisma = new PrismaClient();
prisma.$connect().then(() => console.log('Prisma is connected'));
async function main() {
  const fastify = Fastify({
    logger: true,
  });

  // Register CORS
  await fastify.register(cors, {
    origin: serverConfig.corsOrigin,
    credentials: true,
  });

  // Health check endpoint
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Telegram Mini App authentication
  fastify.post<{ Body: { initData: string } }>('/auth/telegram', async (request, reply) => {
    try {
      const { initData } = request.body;

      if (!initData) {
        return reply.status(400).send({ error: 'Missing initData' });
      }

      const telegramData = validateTelegramWebAppData(initData);

      if (!telegramData || !telegramData.user) {
        return reply.status(401).send({ error: 'Invalid Telegram data' });
      }

      const user = await findOrCreateUser(telegramData);

      const token = generateToken({
        userId: user.id,
        telegramId: user.telegramId,
      });

      return {
        token,
        user: {
          id: user.id,
          username: user.username,
          firstName: user.firstName,
          photoUrl: user.photoUrl,
          balance: user.balance,
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Authentication failed' });
    }
  });

  // Dev mode authentication (only in development)
  if (serverConfig.devMode) {
    fastify.post<{ Body: { code: string } }>('/auth/dev', async (request, reply) => {
      try {
        const { code } = request.body;

        if (!code) {
          return reply.status(400).send({ error: 'Missing code' });
        }

        const devData = generateDevToken(code);

        if (!devData) {
          return reply.status(401).send({ error: 'Invalid dev code' });
        }

        const user = await findOrCreateDevUser(devData.telegramId);

        const token = generateToken({
          userId: user.id,
          telegramId: user.telegramId,
        });

        return {
          token,
          user: {
            id: user.id,
            username: user.username,
            firstName: user.firstName,
            photoUrl: user.photoUrl,
            balance: user.balance,
          },
        };
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ error: 'Dev authentication failed' });
      }
    });
  }

  // Start Fastify server first
  const port = serverConfig.port;
  const host = serverConfig.host;

  await fastify.listen({ port, host });

  // Initialize Socket.io with the underlying Node.js server
  const io = initializeSocket(fastify.server);
  await timerService.initialize();

  console.log(`Server running on http://${host}:${port}`);
  console.log(`Dev mode: ${serverConfig.devMode}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    timerService.cleanup();
    io.close();
    await fastify.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
