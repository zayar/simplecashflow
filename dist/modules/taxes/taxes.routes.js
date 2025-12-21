import { prisma } from '../../infrastructure/db.js';
import { Prisma } from '@prisma/client';
import { requireCompanyIdParam } from '../../utils/tenant.js';
import { requireAnyRole, Roles } from '../../utils/rbac.js';
export async function taxesRoutes(fastify) {
    // All tax endpoints are tenant-scoped and must be authenticated.
    fastify.addHook('preHandler', fastify.authenticate);
    // --- Tax Rates ---
    // List tax rates
    fastify.get('/companies/:companyId/tax-rates', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const rates = await prisma.taxRate.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
        });
        return rates.map((r) => ({
            id: r.id,
            name: r.name,
            rate: Number(r.rate),
            ratePercent: Number(r.rate) * 100, // for display
            isCompound: r.isCompound,
            isActive: r.isActive,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        }));
    });
    // Get single tax rate
    fastify.get('/companies/:companyId/tax-rates/:taxRateId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const taxRateId = Number(request.params?.taxRateId);
        if (Number.isNaN(taxRateId)) {
            reply.status(400);
            return { error: 'invalid taxRateId' };
        }
        const rate = await prisma.taxRate.findFirst({
            where: { id: taxRateId, companyId },
        });
        if (!rate) {
            reply.status(404);
            return { error: 'tax rate not found' };
        }
        return {
            id: rate.id,
            name: rate.name,
            rate: Number(rate.rate),
            ratePercent: Number(rate.rate) * 100,
            isCompound: rate.isCompound,
            isActive: rate.isActive,
            createdAt: rate.createdAt,
            updatedAt: rate.updatedAt,
        };
    });
    // Create tax rate
    fastify.post('/companies/:companyId/tax-rates', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const body = request.body;
        if (!body.name || body.rate === undefined) {
            reply.status(400);
            return { error: 'name and rate are required' };
        }
        // Normalize rate: if > 1, assume percentage (10 means 10%)
        let rateDecimal = Number(body.rate);
        if (rateDecimal > 1) {
            rateDecimal = rateDecimal / 100;
        }
        if (rateDecimal < 0 || rateDecimal > 1) {
            reply.status(400);
            return { error: 'rate must be between 0 and 1 (or 0% to 100%)' };
        }
        const rate = await prisma.taxRate.create({
            data: {
                companyId,
                name: body.name,
                rate: new Prisma.Decimal(rateDecimal).toDecimalPlaces(4),
                isCompound: body.isCompound ?? false,
                isActive: true,
            },
        });
        return {
            id: rate.id,
            name: rate.name,
            rate: Number(rate.rate),
            ratePercent: Number(rate.rate) * 100,
            isCompound: rate.isCompound,
            isActive: rate.isActive,
        };
    });
    // Update tax rate
    fastify.put('/companies/:companyId/tax-rates/:taxRateId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const taxRateId = Number(request.params?.taxRateId);
        if (Number.isNaN(taxRateId)) {
            reply.status(400);
            return { error: 'invalid taxRateId' };
        }
        const body = request.body;
        const existing = await prisma.taxRate.findFirst({
            where: { id: taxRateId, companyId },
        });
        if (!existing) {
            reply.status(404);
            return { error: 'tax rate not found' };
        }
        const updateData = {};
        if (body.name !== undefined)
            updateData.name = body.name;
        if (body.isCompound !== undefined)
            updateData.isCompound = body.isCompound;
        if (body.isActive !== undefined)
            updateData.isActive = body.isActive;
        if (body.rate !== undefined) {
            let rateDecimal = Number(body.rate);
            if (rateDecimal > 1) {
                rateDecimal = rateDecimal / 100;
            }
            if (rateDecimal < 0 || rateDecimal > 1) {
                reply.status(400);
                return { error: 'rate must be between 0 and 1 (or 0% to 100%)' };
            }
            updateData.rate = new Prisma.Decimal(rateDecimal).toDecimalPlaces(4);
        }
        const upd = await prisma.taxRate.updateMany({
            where: { id: taxRateId, companyId },
            data: updateData,
        });
        if (upd.count !== 1) {
            reply.status(404);
            return { error: 'tax rate not found' };
        }
        const updated = await prisma.taxRate.findFirst({
            where: { id: taxRateId, companyId },
        });
        if (!updated) {
            reply.status(404);
            return { error: 'tax rate not found' };
        }
        return {
            id: updated.id,
            name: updated.name,
            rate: Number(updated.rate),
            ratePercent: Number(updated.rate) * 100,
            isCompound: updated.isCompound,
            isActive: updated.isActive,
        };
    });
    // Delete tax rate
    fastify.delete('/companies/:companyId/tax-rates/:taxRateId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const taxRateId = Number(request.params?.taxRateId);
        if (Number.isNaN(taxRateId)) {
            reply.status(400);
            return { error: 'invalid taxRateId' };
        }
        const existing = await prisma.taxRate.findFirst({
            where: { id: taxRateId, companyId },
        });
        if (!existing) {
            reply.status(404);
            return { error: 'tax rate not found' };
        }
        const del = await prisma.taxRate.deleteMany({
            where: { id: taxRateId, companyId },
        });
        if (del.count !== 1) {
            reply.status(404);
            return { error: 'tax rate not found' };
        }
        return { success: true };
    });
    // --- Tax Groups ---
    // List tax groups
    fastify.get('/companies/:companyId/tax-groups', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const groups = await prisma.taxGroup.findMany({
            where: { companyId },
            include: {
                members: {
                    include: {
                        taxRate: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        return groups.map((g) => ({
            id: g.id,
            name: g.name,
            totalRate: Number(g.totalRate),
            totalRatePercent: Number(g.totalRate) * 100,
            isActive: g.isActive,
            members: g.members.map((m) => ({
                id: m.id,
                taxRateId: m.taxRateId,
                taxRateName: m.taxRate.name,
                rate: Number(m.taxRate.rate),
                ratePercent: Number(m.taxRate.rate) * 100,
                isCompound: m.taxRate.isCompound,
            })),
            createdAt: g.createdAt,
            updatedAt: g.updatedAt,
        }));
    });
    // Get single tax group
    fastify.get('/companies/:companyId/tax-groups/:taxGroupId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const taxGroupId = Number(request.params?.taxGroupId);
        if (Number.isNaN(taxGroupId)) {
            reply.status(400);
            return { error: 'invalid taxGroupId' };
        }
        const group = await prisma.taxGroup.findFirst({
            where: { id: taxGroupId, companyId },
            include: {
                members: {
                    include: {
                        taxRate: true,
                    },
                },
            },
        });
        if (!group) {
            reply.status(404);
            return { error: 'tax group not found' };
        }
        return {
            id: group.id,
            name: group.name,
            totalRate: Number(group.totalRate),
            totalRatePercent: Number(group.totalRate) * 100,
            isActive: group.isActive,
            members: group.members.map((m) => ({
                id: m.id,
                taxRateId: m.taxRateId,
                taxRateName: m.taxRate.name,
                rate: Number(m.taxRate.rate),
                ratePercent: Number(m.taxRate.rate) * 100,
                isCompound: m.taxRate.isCompound,
            })),
            createdAt: group.createdAt,
            updatedAt: group.updatedAt,
        };
    });
    // Create tax group
    fastify.post('/companies/:companyId/tax-groups', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const body = request.body;
        if (!body.name) {
            reply.status(400);
            return { error: 'name is required' };
        }
        const taxRateIds = body.taxRateIds ?? [];
        if (taxRateIds.length === 0) {
            reply.status(400);
            return { error: 'at least one tax rate is required' };
        }
        // Validate all tax rates belong to this company
        const rates = await prisma.taxRate.findMany({
            where: { companyId, id: { in: taxRateIds } },
        });
        if (rates.length !== taxRateIds.length) {
            reply.status(400);
            return { error: 'one or more tax rates not found' };
        }
        // Calculate total rate (sum of all member rates)
        let totalRate = new Prisma.Decimal(0);
        for (const rate of rates) {
            totalRate = totalRate.add(rate.rate);
        }
        const group = await prisma.$transaction(async (tx) => {
            const created = await tx.taxGroup.create({
                data: {
                    companyId,
                    name: body.name,
                    totalRate: totalRate.toDecimalPlaces(4),
                    isActive: true,
                },
            });
            // Create members
            for (const rateId of taxRateIds) {
                await tx.taxGroupMember.create({
                    data: {
                        groupId: created.id,
                        taxRateId: rateId,
                    },
                });
            }
            return created;
        });
        // Return with members
        const groupWithMembers = await prisma.taxGroup.findFirst({
            where: { id: group.id, companyId },
            include: {
                members: {
                    include: {
                        taxRate: true,
                    },
                },
            },
        });
        return {
            id: groupWithMembers.id,
            name: groupWithMembers.name,
            totalRate: Number(groupWithMembers.totalRate),
            totalRatePercent: Number(groupWithMembers.totalRate) * 100,
            isActive: groupWithMembers.isActive,
            members: groupWithMembers.members.map((m) => ({
                id: m.id,
                taxRateId: m.taxRateId,
                taxRateName: m.taxRate.name,
                rate: Number(m.taxRate.rate),
                ratePercent: Number(m.taxRate.rate) * 100,
            })),
        };
    });
    // Update tax group
    fastify.put('/companies/:companyId/tax-groups/:taxGroupId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const taxGroupId = Number(request.params?.taxGroupId);
        if (Number.isNaN(taxGroupId)) {
            reply.status(400);
            return { error: 'invalid taxGroupId' };
        }
        const body = request.body;
        const existing = await prisma.taxGroup.findFirst({
            where: { id: taxGroupId, companyId },
        });
        if (!existing) {
            reply.status(404);
            return { error: 'tax group not found' };
        }
        await prisma.$transaction(async (tx) => {
            const updateData = {};
            if (body.name !== undefined)
                updateData.name = body.name;
            if (body.isActive !== undefined)
                updateData.isActive = body.isActive;
            // If tax rates are being updated
            if (body.taxRateIds !== undefined) {
                const taxRateIds = body.taxRateIds;
                if (taxRateIds.length === 0) {
                    throw Object.assign(new Error('at least one tax rate is required'), { statusCode: 400 });
                }
                // Validate all tax rates
                const rates = await tx.taxRate.findMany({
                    where: { companyId, id: { in: taxRateIds } },
                });
                if (rates.length !== taxRateIds.length) {
                    throw Object.assign(new Error('one or more tax rates not found'), { statusCode: 400 });
                }
                // Recalculate total rate
                let totalRate = new Prisma.Decimal(0);
                for (const rate of rates) {
                    totalRate = totalRate.add(rate.rate);
                }
                updateData.totalRate = totalRate.toDecimalPlaces(4);
                // Delete existing members
                await tx.taxGroupMember.deleteMany({
                    where: { groupId: taxGroupId },
                });
                // Create new members
                for (const rateId of taxRateIds) {
                    await tx.taxGroupMember.create({
                        data: {
                            groupId: taxGroupId,
                            taxRateId: rateId,
                        },
                    });
                }
            }
            const upd = await tx.taxGroup.updateMany({
                where: { id: taxGroupId, companyId },
                data: updateData,
            });
            if (upd.count !== 1) {
                throw Object.assign(new Error('tax group not found'), { statusCode: 404 });
            }
        });
        // Return updated group
        const updated = await prisma.taxGroup.findFirst({
            where: { id: taxGroupId, companyId },
            include: {
                members: {
                    include: {
                        taxRate: true,
                    },
                },
            },
        });
        return {
            id: updated.id,
            name: updated.name,
            totalRate: Number(updated.totalRate),
            totalRatePercent: Number(updated.totalRate) * 100,
            isActive: updated.isActive,
            members: updated.members.map((m) => ({
                id: m.id,
                taxRateId: m.taxRateId,
                taxRateName: m.taxRate.name,
                rate: Number(m.taxRate.rate),
                ratePercent: Number(m.taxRate.rate) * 100,
            })),
        };
    });
    // Delete tax group
    fastify.delete('/companies/:companyId/tax-groups/:taxGroupId', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        requireAnyRole(request, reply, [Roles.OWNER, Roles.ACCOUNTANT], 'OWNER or ACCOUNTANT');
        const taxGroupId = Number(request.params?.taxGroupId);
        if (Number.isNaN(taxGroupId)) {
            reply.status(400);
            return { error: 'invalid taxGroupId' };
        }
        const existing = await prisma.taxGroup.findFirst({
            where: { id: taxGroupId, companyId },
        });
        if (!existing) {
            reply.status(404);
            return { error: 'tax group not found' };
        }
        const del = await prisma.taxGroup.deleteMany({
            where: { id: taxGroupId, companyId },
        });
        if (del.count !== 1) {
            reply.status(404);
            return { error: 'tax group not found' };
        }
        return { success: true };
    });
    // --- Combined endpoint for UI (returns both rates and groups) ---
    fastify.get('/companies/:companyId/taxes', async (request, reply) => {
        const companyId = requireCompanyIdParam(request, reply);
        const [rates, groups] = await Promise.all([
            prisma.taxRate.findMany({
                where: { companyId, isActive: true },
                orderBy: { name: 'asc' },
            }),
            prisma.taxGroup.findMany({
                where: { companyId, isActive: true },
                include: {
                    members: {
                        include: {
                            taxRate: true,
                        },
                    },
                },
                orderBy: { name: 'asc' },
            }),
        ]);
        return {
            taxRates: rates.map((r) => ({
                id: r.id,
                name: r.name,
                rate: Number(r.rate),
                ratePercent: Number(r.rate) * 100,
                isCompound: r.isCompound,
                type: 'rate',
            })),
            taxGroups: groups.map((g) => ({
                id: g.id,
                name: g.name,
                totalRate: Number(g.totalRate),
                totalRatePercent: Number(g.totalRate) * 100,
                type: 'group',
                members: g.members.map((m) => ({
                    taxRateId: m.taxRateId,
                    taxRateName: m.taxRate.name,
                    rate: Number(m.taxRate.rate),
                })),
            })),
        };
    });
}
//# sourceMappingURL=taxes.routes.js.map