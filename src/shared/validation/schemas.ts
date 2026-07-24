/**
 * Runtime validation for every IPC request payload (§20: "validate every IPC input").
 *
 * The main process refuses any payload that does not parse. Renderer compromise therefore
 * cannot smuggle unexpected shapes into the filesystem or SQL layers.
 */
import { z } from 'zod';
import {
  MAX_SNAPSHOT_DELAY_MS,
  MIN_SNAPSHOT_DELAY_MS,
  SEARCH_PAGE_SIZE
} from '../constants';
import type { ChannelName } from '../contracts/ipc';

const voidSchema = z.union([z.undefined(), z.null(), z.void()]).transform(() => undefined);

const idSchema = z.string().min(1).max(128);

export const restoreRequestSchema = z.object({
  versionId: idSchema,
  expectedCurrentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  force: z.boolean().optional()
});

export const recoverRequestSchema = z.object({
  versionId: idSchema,
  onConflict: z.enum(['fail', 'rename', 'replace']),
  createParentDirectories: z.boolean()
});

export const settingsPatchSchema = z
  .object({
    snapshotDelayMs: z.number().int().min(MIN_SNAPSHOT_DELAY_MS).max(MAX_SNAPSHOT_DELAY_MS),
    ignorePatterns: z.array(z.string().min(1).max(512)).max(200),
    launchAtLogin: z.boolean(),
    theme: z.enum(['system', 'light', 'dark'])
  })
  .partial()
  .strict();

export const searchQuerySchema = z.object({
  text: z.string().max(512),
  scope: z.enum(['all', 'current', 'historical', 'deleted']),
  fromDate: z.number().int().nullable().optional(),
  toDate: z.number().int().nullable().optional(),
  limit: z.number().int().min(1).max(200).default(SEARCH_PAGE_SIZE).optional(),
  offset: z.number().int().min(0).max(100_000).default(0).optional()
});

export const listFilesSchema = z.object({
  filter: z.enum(['all', 'active', 'deleted']),
  query: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).optional()
});

export const timelineRequestSchema = z.object({
  fileId: idSchema,
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional()
});

export const diffRequestSchema = z.object({
  versionId: idSchema,
  compareWith: z.enum(['previous', 'current'])
});

export const fileIdSchema = z.object({ fileId: idSchema });
export const versionIdSchema = z.object({ versionId: idSchema });

/** Channel → schema. Every channel must appear here or the request is rejected. */
export const requestSchemas = {
  'vault:select': voidSchema,
  'vault:startTracking': voidSchema,
  'vault:pauseTracking': voidSchema,
  'vault:resumeTracking': voidSchema,
  'vault:rescan': voidSchema,
  'version:restore': restoreRequestSchema,
  'file:recoverDeleted': recoverRequestSchema,
  'settings:update': settingsPatchSchema,
  'search:rebuildIndex': voidSchema,
  'app:openDataFolder': voidSchema,
  'app:openLogsFolder': voidSchema,
  'vault:status': voidSchema,
  'file:list': listFilesSchema,
  'file:get': fileIdSchema,
  'file:currentContent': fileIdSchema,
  'timeline:get': timelineRequestSchema,
  'version:content': versionIdSchema,
  'version:diff': diffRequestSchema,
  'search:versions': searchQuerySchema,
  'storage:usage': voidSchema,
  'health:status': voidSchema,
  'health:skippedFiles': voidSchema,
  'settings:get': voidSchema
} as const satisfies Record<ChannelName, z.ZodTypeAny>;

export type RequestSchemas = typeof requestSchemas;
