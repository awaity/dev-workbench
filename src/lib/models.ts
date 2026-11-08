import { z } from 'zod';

/** 可用工具的固定标识列表，供路由与持久化校验共用。 */
export const toolIds = [
  'http',
  'websocket',
  'json',
  'json-editor',
  'jsonpath',
  'sm4',
  'sm2',
  'md5',
  'base64',
  'sha',
  'rsa',
  'aes',
  'des',
  'jwt',
  'bcrypt',
  'url',
  'qrcode',
] as const;
/** 可持久化的工具标识，不包含设置页。 */
export type ToolId = (typeof toolIds)[number];
/** 工具标识校验器，拒绝未知路由写入草稿。 */
export const toolIdSchema = z.enum(toolIds);
export const tools: {
  id: ToolId;
  name: string;
  group: string;
  description: string;
  mark: string;
}[] = [
  {
    id: 'http',
    name: 'HTTP 接口测试',
    group: '开发',
    description: '构建请求，查看响应，把常用接口留在本地。',
    mark: '↗',
  },
  {
    id: 'websocket',
    name: 'WebSocket 测试',
    group: '开发',
    description: '建立实时连接，发送消息并查看往返记录。',
    mark: '⇄',
  },
  {
    id: 'json',
    name: 'JSON 在线解析',
    group: 'JSON',
    description: '从一段原始数据开始，让结构一目了然。所有解析均在本机完成。',
    mark: '{ }',
  },
  {
    id: 'json-editor',
    name: 'JSON 编辑器',
    group: 'JSON',
    description: '在代码与树视图之间编辑，增删节点并导出 JSON 文件。',
    mark: '{ }',
  },
  {
    id: 'jsonpath',
    name: 'JSONPath',
    group: 'JSON',
    description: '用路径和过滤表达式提取数据，同时查看每个匹配的位置。',
    mark: '$.',
  },
  {
    id: 'sm4',
    name: '国密 SM4',
    group: '加密与编码',
    description: '128 位分组密码，支持 CBC / ECB 和 Hex / Base64。',
    mark: 'S4',
  },
  {
    id: 'sm2',
    name: '国密 SM2',
    group: '加密与编码',
    description: '生成椭圆曲线密钥，使用公钥加密、私钥解密。',
    mark: 'S2',
  },
  {
    id: 'md5',
    name: 'MD5 摘要 / 匹配',
    group: '加密与编码',
    description: '计算摘要、校验原文，或在本地候选中查找匹配。',
    mark: '#',
  },
  {
    id: 'base64',
    name: 'Base64 编解码',
    group: '加密与编码',
    description: 'UTF-8 文本与 Base64 互转，支持 URL 安全格式。',
    mark: '64',
  },
  {
    id: 'sha',
    name: 'SHA 摘要',
    group: '加密与编码',
    description: '计算 SHA 家族摘要，支持带密钥的 HMAC。',
    mark: '#',
  },
  {
    id: 'rsa',
    name: 'RSA 加密 / 解密',
    group: '加密与编码',
    description: '生成 PEM 密钥，使用 PKCS#1 v1.5 或 OAEP 加解密。',
    mark: 'R',
  },
  {
    id: 'aes',
    name: 'AES 加密 / 解密',
    group: '加密与编码',
    description: '支持 128 / 192 / 256 位密钥，以及 CBC / ECB 模式。',
    mark: 'A',
  },
  {
    id: 'des',
    name: 'DES 加密 / 解密',
    group: '加密与编码',
    description: '支持 DES 与 Triple DES，方便对接已有系统。',
    mark: 'D',
  },
  {
    id: 'jwt',
    name: 'JWT 解析',
    group: '加密与编码',
    description: '查看 Header、Payload 和有效期，可验证 HS256 签名。',
    mark: 'J',
  },
  {
    id: 'bcrypt',
    name: 'Bcrypt 哈希 / 校验',
    group: '加密与编码',
    description: '生成带盐密码哈希，或验证原文与哈希是否匹配。',
    mark: 'B',
  },
  {
    id: 'url',
    name: 'URL 编码 / 解码',
    group: '加密与编码',
    description: '对 URL 组件或完整地址进行百分号编码与解码。',
    mark: '%',
  },
  {
    id: 'qrcode',
    name: '二维码生成',
    group: '二维码',
    description: '把文字或网址变成二维码，加上自己的颜色与 Logo。',
    mark: '▦',
  },
];

/** 全局偏好的结构与默认值，约束数值范围。 */
export const settingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).default('light'),
  defaultTool: toolIdSchema.default('json'),
  saveHistory: z.boolean().default(true),
  saveDrafts: z.boolean().default(true),
  historyLimit: z.number().int().min(10).max(2000).default(200),
  autoCleanup: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  indent: z
    .number()
    .int()
    .refine((v) => {
      return v === 2 || v === 4;
    })
    .default(2),
  timeout: z.number().int().min(100).max(120000).default(30000),
  qrSize: z.number().int().min(128).max(2048).default(400),
  favorites: z.array(toolIdSchema).max(17).default(['json', 'http', 'sm4', 'qrcode']),
});
/** 全局设置；数值范围同时约束界面和备份导入。 */
export type Settings = z.infer<typeof settingsSchema>;
/** 首次启动和恢复默认时使用的全局设置。 */
export const defaultSettings = settingsSchema.parse({});

/** 加密与编码工具共享的输入、选项及结果模型。 */
export const cryptoSchema = z.object({
  input: z.string().default(''),
  output: z.string().default(''),
  key: z.string().default(''),
  iv: z.string().default(''),
  keyFormat: z.enum(['utf8', 'hex']).default('utf8'),
  ivFormat: z.enum(['utf8', 'hex']).default('utf8'),
  format: z.enum(['hex', 'base64']).default('base64'),
  mode: z.enum(['CBC', 'ECB']).default('CBC'),
  padding: z.enum(['pkcs7', 'none']).default('pkcs7'),
  publicKey: z.string().default(''),
  privateKey: z.string().default(''),
  sm2Mode: z.enum(['C1C3C2', 'C1C2C3']).default('C1C3C2'),
  rsaPadding: z.enum(['PKCS1', 'OAEP-SHA256', 'OAEP-SHA1']).default('OAEP-SHA256'),
  rsaBits: z.enum(['2048', '3072', '4096']).default('2048'),
  sha: z.enum(['SHA1', 'SHA224', 'SHA256', 'SHA384', 'SHA512']).default('SHA256'),
  hmac: z.boolean().default(false),
  uppercase: z.boolean().default(false),
  md5Short: z.boolean().default(false),
  target: z.string().default(''),
  candidates: z.string().default(''),
  rangeStart: z.number().int().min(0).max(999999999).default(0),
  rangeEnd: z.number().int().min(0).max(999999999).default(9999),
  digits: z.number().int().min(1).max(12).default(4),
  urlSafe: z.boolean().default(false),
  wholeUrl: z.boolean().default(false),
  formUrl: z.boolean().default(false),
  tripleDes: z.boolean().default(false),
  rounds: z.number().int().min(4).max(16).default(10),
});
/** 加密面板的输入和结果，所有密钥仅存本机。 */
export type CryptoState = z.infer<typeof cryptoSchema>;
/** 通用键值参数，描述只用于本地整理，不随请求发送。 */
export const pairSchema = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().default(''),
});
/** 文件引用只保存元数据，文件字节由 IndexedDB attachments 仓库单独保存。 */
export const attachmentRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  type: z.string().max(200),
  size: z
    .number()
    .int()
    .min(0)
    .max(20 * 1024 * 1024),
  lastModified: z.number().min(0),
});
/** 已选文件的稳定引用，供草稿、历史和请求集合共享同一份附件。 */
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
/** form-data 字段可为文本或多个文件；同名字段按原顺序发送。 */
export const multipartSchema = pairSchema.extend({
  kind: z.enum(['text', 'file']).default('text'),
  files: z.array(attachmentRefSchema).max(20).default([]),
  fileHint: z.string().default(''),
});
/** Multipart 参数行；fileHint 记录从 cURL 导入但尚未选择的本地路径。 */
export type MultipartField = z.infer<typeof multipartSchema>;
/** 可持久化的 HTTP 响应；二进制内容以 Base64 保存。 */
export const responseSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  duration: z.number(),
  size: z.number(),
  headers: z.string(),
  body: z.string(),
  url: z.string(),
  truncated: z.boolean(),
  encoding: z.enum(['text', 'base64']).default('text'),
  contentType: z.string().default('text/plain'),
  filename: z.string().default('response.txt'),
  redirected: z.boolean().default(false),
});
/** HTTP 请求、附件引用、鉴权、变量和响应的完整模型。 */
export const httpSchema = z.object({
  url: z.string().default(''),
  method: z
    .string()
    .regex(/^[A-Z!#$%&'*+.^_`|~-]{1,30}$/)
    .default('GET'),
  params: z.array(pairSchema).default([]),
  headers: z.array(pairSchema).default([]),
  bodyType: z
    .enum(['none', 'json', 'text', 'xml', 'html', 'javascript', 'form', 'multipart', 'binary'])
    .default('none'),
  body: z.string().default(''),
  fields: z.array(pairSchema).default([]),
  multipart: z.array(multipartSchema).max(200).default([]),
  binary: attachmentRefSchema.nullable().default(null),
  binaryHint: z.string().default(''),
  variables: z.array(pairSchema).default([]),
  name: z.string().max(120).default(''),
  folder: z.string().max(100).default('默认集合'),
  auth: z.enum(['none', 'bearer', 'basic', 'api-key']).default('none'),
  token: z.string().default(''),
  username: z.string().default(''),
  password: z.string().default(''),
  apiKeyName: z.string().default('X-API-Key'),
  apiKeyValue: z.string().default(''),
  apiKeyIn: z.enum(['header', 'query']).default('header'),
  followRedirects: z.boolean().default(true),
  credentials: z.boolean().default(false),
  timeout: z.number().int().min(100).max(120000).default(30000),
  response: responseSchema.nullable().default(null),
});
/** HTTP 请求配置和最近一次响应。 */
export type HttpState = z.infer<typeof httpSchema>;
/** 本地请求集合记录，保存时清除旧响应，以配置为准重新发送。 */
export const savedRequestSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  folder: z.string().min(1).max(100),
  state: httpSchema,
  updatedAt: z.number(),
});
/** 可命名、分组并恢复的 HTTP 请求。 */
export type SavedRequest = z.infer<typeof savedRequestSchema>;
/** WebSocket 连接参数与有界消息日志模型。 */
export const wsSchema = z.object({
  url: z.string().default(''),
  protocols: z.string().default(''),
  message: z.string().default(''),
  logs: z
    .array(
      z.object({
        time: z.string(),
        direction: z.enum(['send', 'receive', 'system']),
        text: z.string(),
      }),
    )
    .max(500)
    .default([]),
});
/** JSON 编辑、转换和路径查询状态。 */
export const jsonSchema = z.object({
  input: z.string().default(''),
  output: z.string().default(''),
  path: z.string().default('$.tools[*].name'),
  matches: z
    .array(z.object({ path: z.string(), value: z.unknown(), pointer: z.string() }))
    .default([]),
});
/** 二维码内容、样式及本地 Logo 的校验模型。 */
export const qrSchema = z.object({
  text: z.string().default(''),
  title: z.string().max(100).default(''),
  size: z.number().int().min(128).max(2048).default(400),
  margin: z.number().int().min(4).max(100).default(24),
  color: z
    .string()
    .regex(/^#[\da-f]{6}$/i)
    .default('#243149'),
  background: z
    .string()
    .regex(/^#[\da-f]{6}$/i)
    .default('#ffffff'),
  level: z.enum(['L', 'M', 'Q', 'H']).default('M'),
  dots: z.enum(['square', 'rounded', 'dots', 'classy']).default('square'),
  corners: z.enum(['square', 'extra-rounded', 'dot']).default('square'),
  logo: z
    .string()
    .max(3000000)
    .refine((s) => {
      return !s || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
    })
    .default(''),
  logoSize: z.number().min(0.1).max(0.3).default(0.22),
});
/** 二维码内容和美化配置，Logo 使用本地 data URL。 */
export type QrState = z.infer<typeof qrSchema>;
/** 按工具标识保存的草稿记录。 */
export const draftSchema = z.object({
  tool: toolIdSchema,
  state: z.record(z.string(), z.unknown()),
  updatedAt: z.number(),
});
/** 可恢复的操作历史及展示元信息。 */
export const historySchema = z.object({
  id: z.string(),
  tool: toolIdSchema,
  title: z.string().max(200),
  detail: z.string().max(300),
  createdAt: z.number(),
  state: z.record(z.string(), z.unknown()),
});
/** 一条可恢复的本地操作记录。 */
export type HistoryItem = z.infer<typeof historySchema>;
/**
 * 按工具验证草稿或历史的完整状态，阻止损坏备份进入数据库。
 * @param tool - 目标工具标识。
 * @param value - 待校验、转换或保存的值。
 * @returns 补齐默认值并通过结构校验的工具状态。
 */
export function parseState(tool: ToolId, value: unknown): Record<string, unknown> {
  if (tool === 'http') {
    return httpSchema.parse(value);
  }
  if (tool === 'websocket') {
    return wsSchema.parse(value);
  }
  if (tool === 'qrcode') {
    return qrSchema.parse(value);
  }
  if (['json', 'json-editor', 'jsonpath'].includes(tool)) {
    return jsonSchema.parse(value);
  }
  return cryptoSchema.parse(value);
}
