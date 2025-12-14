import { PrismaClient } from '@prisma/client';
export const prisma = new PrismaClient();
// Fintech safety rail: posted ledger data must be immutable.
// If you need to "change" a posted entry, create an adjustment/reversal entry instead.
prisma.$use(async (params, next) => {
    if (params.model === 'JournalEntry' || params.model === 'JournalLine') {
        const action = params.action;
        if (action === 'update' ||
            action === 'updateMany' ||
            action === 'delete' ||
            action === 'deleteMany' ||
            action === 'upsert') {
            throw Object.assign(new Error(`immutable ledger: ${params.model}.${action} is not allowed`), {
                statusCode: 400,
            });
        }
    }
    return next(params);
});
//# sourceMappingURL=db.js.map