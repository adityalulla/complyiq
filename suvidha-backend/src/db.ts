import { PrismaClient } from '@prisma/client';

// A single shared Prisma client for the whole app - avoids opening
// a new database connection pool on every request.
export const prisma = new PrismaClient();
