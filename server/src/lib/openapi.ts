/**
 * OpenAPI 3.0 文档注册（NovaIncus API）
 *
 * 集成方式（需要修改 server/src/app.ts，位置：在全部路由注册完成之后、
 * fastify.listen() 之前）：
 *
 *   import { registerOpenApi } from './lib/openapi.js'
 *   ...
 *   await registerOpenApi(fastify)
 *
 * 注册完成后：
 * - GET /docs        Swagger UI 交互文档
 * - GET /docs/json   OpenAPI 3.0 JSON
 * - GET /docs/yaml   OpenAPI 3.0 YAML
 *
 * 说明：
 * - hideUntagged: true：只有携带 schema/tags 的路由才会被收录。
 *   给现有路由补 schema 是渐进式工作，不阻塞本次注册。
 * - 认证：bearerAuth（Authorization: Bearer <JWT>，@fastify/jwt 登录返回的
 *   access token）为主；cookieAuth（refreshToken cookie）用于刷新令牌。
 */

import type { FastifyInstance } from 'fastify'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

export async function registerOpenApi(fastify: FastifyInstance): Promise<void> {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'NovaIncus API',
        version: '1.0.0',
        description: 'NovaIncus 云容器与 VPS 管理平台 RESTful API（OpenAPI 3.0）'
      },
      servers: [
        { url: '/', description: '当前站点（相对路径）' }
      ],
      tags: [
        { name: 'auth', description: '登录 / 注册 / 令牌刷新' },
        { name: 'instances', description: '实例（创建 / 开关机 / 流量 / 快照）' },
        { name: 'hosts', description: '宿主机管理' },
        { name: 'billing', description: '计费 / 余额 / 订单 / 充值' },
        { name: 'telegram', description: 'Telegram 机器人（绑定 / Webhook）' },
        { name: 'admin', description: '管理员接口' }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: '登录接口返回的 access token，放在 Authorization 请求头'
          },
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'refreshToken',
            description: '刷新令牌 cookie（POST /api/auth/refresh）'
          }
        }
      },
      security: [{ bearerAuth: [] }]
    },
    hideUntagged: true,
    exposeRoute: true
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    },
    staticCSP: true
  })
}
