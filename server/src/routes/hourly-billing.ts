/**
 * 按量计费相关路由（NovaIncus Phase 4）
 * 用户查询按量账单 / 管理员配置按量单价策略
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { apiError, ErrorCode } from '../lib/errors.js'

export default async function hourlyBillingRoutes(fastify: FastifyInstance) {
  // ==================== 用户：查询自己的按量账单 ====================
  // GET /api/billing/hourly/records?instanceId=&page=&pageSize=
  fastify.get<{
    Querystring: { instanceId?: string; page?: string; pageSize?: string }
  }>('/api/billing/hourly/records', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest<{ Querystring: { instanceId?: string; page?: string; pageSize?: string } }>) => {
    const { user } = request
    const { instanceId, page = '1', pageSize = '20' } = request.query

    const safePageSize = Math.min(Number(pageSize) || 20, 100)
    const safePage = Math.max(Number(page) || 1, 1)

    const where: { userId: number; instanceId?: number } = { userId: user.id }
    if (instanceId !== undefined) {
      const iid = Number(instanceId)
      if (isNaN(iid)) {
        return { records: [], total: 0, page: safePage, pageSize: safePageSize }
      }
      // 校验实例归属
      const instance = await prisma.instance.findUnique({
        where: { id: iid },
        select: { userId: true }
      })
      if (!instance || instance.userId !== user.id) {
        return { records: [], total: 0, page: safePage, pageSize: safePageSize }
      }
      where.instanceId = iid
    }

    const [total, records] = await Promise.all([
      prisma.hourlyUsageRecord.count({ where }),
      prisma.hourlyUsageRecord.findMany({
        where,
        orderBy: { periodStart: 'desc' },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        include: {
          instance: { select: { id: true, name: true } }
        }
      })
    ])

    return {
      records: records.map(r => ({
        id: r.id,
        instanceId: r.instanceId,
        instanceName: r.instance.name,
        periodStart: r.periodStart.toISOString(),
        periodEnd: r.periodEnd.toISOString(),
        cpu: r.cpu,
        memory: r.memory,
        disk: r.disk,
        amount: Number(r.amount),
        status: r.status,
        remark: r.remark,
        createdAt: r.createdAt.toISOString()
      })),
      total,
      page: safePage,
      pageSize: safePageSize
    }
  })

  // ==================== 用户：本月按量费用汇总 ====================
  // GET /api/billing/hourly/summary
  fastify.get('/api/billing/hourly/summary', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest) => {
    const { user } = request
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const groups = await prisma.hourlyUsageRecord.groupBy({
      by: ['status'],
      where: {
        userId: user.id,
        createdAt: { gte: monthStart }
      },
      _sum: { amount: true },
      _count: { _all: true }
    })

    let paidTotal = 0
    let arrearsTotal = 0
    let paidCount = 0
    let arrearsCount = 0
    for (const g of groups) {
      const sum = Number(g._sum.amount || 0)
      if (g.status === 'paid') {
        paidTotal = sum
        paidCount = g._count._all
      } else {
        arrearsTotal = sum
        arrearsCount = g._count._all
      }
    }

    return {
      month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      paidTotal,
      arrearsTotal,
      total: paidTotal + arrearsTotal,
      paidCount,
      arrearsCount
    }
  })

  // ==================== 管理员：查看全部按量策略 ====================
  // GET /api/admin/billing/hourly/policies
  fastify.get('/api/admin/billing/hourly/policies', {
    onRequest: [fastify.authenticate, fastify.requireAdmin]
  }, async () => {
    const policies = await prisma.hourlyBillingPolicy.findMany({
      include: {
        packagePlan: {
          select: { id: true, name: true, packageId: true, price: true }
        }
      },
      orderBy: { packagePlanId: 'asc' }
    })

    return {
      policies: policies.map(p => ({
        id: p.id,
        packagePlanId: p.packagePlanId,
        planName: p.packagePlan.name,
        planPrice: Number(p.packagePlan.price),
        enabled: p.enabled,
        cpuPricePerHour: Number(p.cpuPricePerHour),
        memoryPricePerGbHour: Number(p.memoryPricePerGbHour),
        diskPricePerGbHour: Number(p.diskPricePerGbHour),
        stoppedDiskRate: Number(p.stoppedDiskRate),
        updatedAt: p.updatedAt.toISOString()
      }))
    }
  })

  // ==================== 管理员：配置方案按量策略 ====================
  // PUT /api/admin/billing/hourly/policies/:planId
  fastify.put<{
    Params: { planId: string }
    Body: {
      enabled?: boolean
      cpuPricePerHour?: number
      memoryPricePerGbHour?: number
      diskPricePerGbHour?: number
      stoppedDiskRate?: number
    }
  }>('/api/admin/billing/hourly/policies/:planId', {
    onRequest: [fastify.authenticate, fastify.requireAdmin],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          cpuPricePerHour: { type: 'number', minimum: 0 },
          memoryPricePerGbHour: { type: 'number', minimum: 0 },
          diskPricePerGbHour: { type: 'number', minimum: 0 },
          stoppedDiskRate: { type: 'number', minimum: 0, maximum: 10 }
        },
        additionalProperties: false
      }
    }
  }, async (request: FastifyRequest<{
    Params: { planId: string }
    Body: {
      enabled?: boolean
      cpuPricePerHour?: number
      memoryPricePerGbHour?: number
      diskPricePerGbHour?: number
      stoppedDiskRate?: number
    }
  }>, reply: FastifyReply) => {
    const { user } = request
    const planId = Number(request.params.planId)
    if (isNaN(planId)) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_ID))
    }

    const plan = await prisma.packagePlan.findUnique({
      where: { id: planId },
      select: { id: true, name: true }
    })
    if (!plan) {
      return reply.code(404).send(apiError(ErrorCode.INVALID_PARAMS, '方案不存在'))
    }

    const { enabled, cpuPricePerHour, memoryPricePerGbHour, diskPricePerGbHour, stoppedDiskRate } = request.body
    const data: Prisma.HourlyBillingPolicyUpdateInput = {}
    if (enabled !== undefined) data.enabled = enabled
    if (cpuPricePerHour !== undefined) data.cpuPricePerHour = cpuPricePerHour
    if (memoryPricePerGbHour !== undefined) data.memoryPricePerGbHour = memoryPricePerGbHour
    if (diskPricePerGbHour !== undefined) data.diskPricePerGbHour = diskPricePerGbHour
    if (stoppedDiskRate !== undefined) data.stoppedDiskRate = stoppedDiskRate

    const policy = await prisma.hourlyBillingPolicy.upsert({
      where: { packagePlanId: planId },
      update: data,
      create: {
        packagePlanId: planId,
        enabled: enabled ?? false,
        cpuPricePerHour: cpuPricePerHour ?? 0,
        memoryPricePerGbHour: memoryPricePerGbHour ?? 0,
        diskPricePerGbHour: diskPricePerGbHour ?? 0,
        stoppedDiskRate: stoppedDiskRate ?? 0.1
      }
    })

    await createLog(
      user.id,
      'admin',
      'billing.hourly_policy',
      `Updated hourly billing policy for plan "${plan.name}" (#${planId}): ${JSON.stringify(data)}`,
      'success'
    )

    return {
      message: '按量计费策略已更新',
      policy: {
        id: policy.id,
        packagePlanId: policy.packagePlanId,
        enabled: policy.enabled,
        cpuPricePerHour: Number(policy.cpuPricePerHour),
        memoryPricePerGbHour: Number(policy.memoryPricePerGbHour),
        diskPricePerGbHour: Number(policy.diskPricePerGbHour),
        stoppedDiskRate: Number(policy.stoppedDiskRate)
      }
    }
  })
}
